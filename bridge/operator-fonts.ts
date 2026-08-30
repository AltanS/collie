import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject } from "./json.ts";
import { containedRealpath } from "./journal/files.ts";
import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";
import type { OperatorFontRow } from "./types.ts";

// The operator's own UI typefaces, read from `theme.toml` next to their `.env` — the fourth file on
// the operator-file contract (`commands.toml`, `keys.toml`, `quick-replies.toml`), sharing the same
// mtime-checked reader and the same "a broken file holds the last good rows" posture.
//
// TWO THINGS ARE DIFFERENT HERE, and both are stated in ADR 0033 rather than left to be inferred.
//
// POSTURE. The trio REPLACE the shipped catalog on the panes they address (ADR 0018). Fonts ADD to
// the shipped list instead. The reason is not taste: a command row shadows a shipped command, so a
// merge would leave the operator unable to say "not that one" — whereas a font cannot fire an
// action, so an extra entry in a picker costs a line in a menu and nothing else. 0018 is untouched.
//
// THE FILE IS NAMED `theme.toml`, NOT `fonts.toml`, so a colour block can join it later without
// becoming a fifth operator file. Nothing but `[[font]]` is read today, and an unknown top-level
// table is ignored rather than warned about, which is what makes that room real.
//
// WHY THE GRAMMAR IS THIS TIGHT. Every field a row carries ends up inside CSS text on the phone.
// That makes this an injection boundary, so the rule is: rows are REBUILT from validated parts,
// never escaped. This module owns the validation half; web/src/lib/operator-fonts.ts owns the same
// grammar on the other side and re-checks it, because a client must not trust a server's promise
// about a string it is about to put in a stylesheet.
//
// SECURITY: NOTHING HERE MAKES A PATH FROM A REQUEST. `file` is an operator-authored bare name,
// checked to be one; the serve-time lookup in {@link resolveOperatorFont} maps a request's basename
// to a row that ALREADY EXISTS and takes that row's path. The journal's law is restated, not
// excepted — see bridge/journal/files.ts's header.

/**
 * The one grammar for a CSS family name, spelled as a source string so both sides can be pinned to
 * the same characters (web/src/lib/operator-fonts.ts holds the twin; `operator-fonts.test.ts` and
 * web's `fonts.test.ts` fail if they drift).
 *
 * Conservative on purpose. A family name is quoted where it enters CSS, so the quote and the
 * backslash are what would break out — but the answer is a closed charset rather than an escaper,
 * because an escaper is a thing that can have a bug and a charset is a thing that cannot. Letters,
 * digits, space, dot, underscore and hyphen cover every real font name and nothing else.
 */
export const OPERATOR_FONT_FAMILY_PATTERN = "^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$";

/**
 * CSS generic family keywords, plus the CSS-wide values. A row named `serif` would resolve to the
 * generic instead of the file, so the row would silently do nothing — refusing it says so.
 */
const RESERVED_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "math",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

/** Largest font file this bridge will serve. Checked at SERVE time, against the file on disk. */
export const MAX_OPERATOR_FONT_BYTES = 2 * 1024 * 1024;

/** A parsed `theme.toml` document, before a byte of it is believed. */
interface ThemeDocument {
  font?: unknown;
}

/**
 * True when `value` is a usable CSS family name. Pure and total — the shared predicate S9 asks for,
 * and the only place either side decides what a family may be called.
 */
export function isOperatorFontFamily(value: string): boolean {
  return new RegExp(OPERATOR_FONT_FAMILY_PATTERN).test(value) && !RESERVED_FAMILIES.has(value.toLowerCase());
}

/**
 * True when `value` is a bare `.woff2` file name and could not be anything else.
 *
 * The list of refusals is the point: a separator in either direction, a dot-segment, a leading dot
 * (which would also cover `..`), an empty name, and any suffix but `.woff2`. This runs BEFORE the
 * name is joined to anything, and containment runs again after — two independent checks, because
 * one of them being subtly wrong is the failure mode a single check cannot survive.
 */
export function isOperatorFontFile(value: string): boolean {
  if (value.length === 0 || value.length > 128) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith(".")) return false;
  if (!value.endsWith(".woff2")) return false;
  // Belt and braces: `.woff2` cannot be reached by a name that is only dots, but say it anyway.
  return value !== "." && value !== "..";
}

/**
 * True when `value` is a `font-weight` this bridge will put in CSS: one three-digit weight, or two
 * separated by a single space, each 100–900 and the pair ascending.
 *
 * A descending or out-of-range pair is not merely odd — it makes the whole `@font-face` invalid, so
 * one bad row would cost the operator the face rather than the weight.
 */
export function isOperatorFontWeight(value: string): boolean {
  if (!/^\d{3}( \d{3})?$/.test(value)) return false;
  const parts = value.split(" ").map(Number);
  if (parts.some((n) => n < 100 || n > 900)) return false;
  return parts.length === 1 || parts[0]! <= parts[1]!;
}

/**
 * Turn a parsed TOML document into typeface rows, dropping anything malformed with one warning line.
 *
 * PURE, TOTAL AND FS-FREE — it never throws and never touches a disk, so the grammar is unit-testable
 * without fixtures, and so a file whose `file` has since been deleted is not frozen into a stale
 * mtime cache. Existence and containment are SERVE-time questions, asked per request.
 *
 * ```toml
 * [[font]]
 * family = "Departure Mono"     # required; display name AND css family
 * file   = "departure.woff2"    # required; a bare name inside <config-dir>/fonts, woff2 only
 * weight = "400 700"            # optional
 * ```
 *
 * Every rejection drops the ROW, never the file: one typo must not cost the operator their other
 * faces.
 */
export function validateOperatorFonts(
  doc: ThemeDocument | null | undefined,
  warn = defaultWarn,
): OperatorFontRow[] {
  const rows = doc?.font;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    warn("`font` must be an array of [[font]] tables — ignoring the file's rows");
    return [];
  }
  const out: OperatorFontRow[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null || raw === undefined || Array.isArray(raw)) {
      warn("ignoring a row that is not a [[font]] table");
      continue;
    }
    const row: JsonObject = raw;
    const family = typeof row.family === "string" ? row.family.trim() : "";
    if (!isOperatorFontFamily(family)) {
      warn(`ignoring a row whose family is missing or unusable: ${JSON.stringify(row.family)}`);
      continue;
    }
    const basename = typeof row.file === "string" ? row.file.trim() : "";
    if (!isOperatorFontFile(basename)) {
      warn(`ignoring "${family}" — file must be a bare .woff2 name, not ${JSON.stringify(row.file)}`);
      continue;
    }
    let weight = "";
    if (row.weight !== undefined) {
      // Fail closed. Dropping an unusable weight would publish the face at a weight the operator
      // did not ask for, and this string enters CSS.
      if (typeof row.weight !== "string" || !isOperatorFontWeight(row.weight.trim())) {
        warn(`ignoring "${family}" — weight must be "400" or "400 700", not ${JSON.stringify(row.weight)}`);
        continue;
      }
      weight = row.weight.trim();
    }
    // Identity is the BASENAME, because that is what the URL carries and what the picker's value is
    // built from (`op:<basename>`). FIRST WINS here, unlike the trio's later-wins: two rows on one
    // file is a copy-paste, and the second one silently renaming the first would be the surprise.
    if (seen.has(basename)) {
      warn(`ignoring "${family}" — ${basename} is already declared, the first row wins`);
      continue;
    }
    seen.add(basename);
    const parsed: OperatorFontRow = { family, basename };
    // Assigned, never conditionally spread: a row with no weight carries NO `weight` key.
    if (weight) parsed.weight = weight;
    out.push(parsed);
  }
  return out;
}

/** The disk questions {@link resolveOperatorFont} asks. Behind an interface so serving is testable. */
export interface OperatorFontFs {
  /** The real path of `candidate` when it is still inside `root` afterwards, else null. */
  contained(candidate: string, root: string): Promise<string | null>;
  /** The file's size in bytes, or null when it is absent or unreadable. */
  size(path: string): Promise<number | null>;
}

export const diskFontFs: OperatorFontFs = {
  contained: containedRealpath,
  async size(path) {
    try {
      return (await stat(path)).size;
    } catch {
      return null;
    }
  },
};

/**
 * The absolute path `GET /api/fonts/<basename>` should read, or null when there is nothing to serve.
 *
 * THE ORDER IS THE SECURITY PROPERTY, so read it in order:
 *  1. The request's basename is looked UP in the rows the operator declared. A name nobody declared
 *     is null before any path exists — no path is ever BUILT from a request.
 *  2. The row's own name is re-checked against the same grammar that admitted it, so a row that
 *     reached here through a future code path still cannot be a path.
 *  3. The candidate is joined to `<config-dir>/fonts` and put through the journal's
 *     `containedRealpath`, which resolves symlinks and re-asks the question on the REAL paths. This
 *     is the independent second check: step 2 is a grammar, this is the filesystem's own answer.
 *  4. The size cap is checked against the file on disk, per request. A file that grew past the cap
 *     stops being served without anyone re-reading `theme.toml`.
 *
 * Null is the only failure this reports, and the caller answers 404 for every one of them: a client
 * must not be able to tell "not declared" from "missing" from "escaped its directory".
 */
export async function resolveOperatorFont(
  basename: string,
  rows: readonly OperatorFontRow[],
  fontsDir: string,
  fs: OperatorFontFs = diskFontFs,
  warn = defaultWarn,
): Promise<string | null> {
  const row = rows.find((r) => r.basename === basename);
  if (row === undefined) return null;
  if (!isOperatorFontFile(row.basename)) return null;
  const real = await fs.contained(join(fontsDir, row.basename), fontsDir);
  if (real === null) {
    warn(`${row.basename} is missing from ${fontsDir}, or resolves outside it — not serving it`);
    return null;
  }
  const size = await fs.size(real);
  if (size === null) return null;
  if (size > MAX_OPERATOR_FONT_BYTES) {
    warn(`${row.basename} is ${size} bytes, over the ${MAX_OPERATOR_FONT_BYTES} cap — not serving it`);
    return null;
  }
  return real;
}

function defaultWarn(message: string): void {
  console.warn(`[fonts] ${message}`);
}

/**
 * A reader for the operator's `theme.toml` — the same mtime cache, the same "no file is not an
 * error" rule and the same hold-the-last-good-rows failure posture the other three get, because it
 * is literally the same reader (operator-file.ts).
 */
export function createOperatorFonts(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<OperatorFontRow[]> {
  return createOperatorFileReader(path, validateOperatorFonts, io, warn);
}
