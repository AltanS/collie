import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";
import type { OperatorKeyRow } from "./types.ts";

// The operator's own Keys-tray preset rows, read from `keys.toml` next to their `.env` — the exact
// sibling of `commands.toml`, down to the discovery rule and the mtime-checked live reload
// (operator-file.ts owns both).
//
// SCOPE. The Keys tray is two things: a KEYBOARD (Esc/arrows/Enter/Tab/Space, the modifiers, the
// digits, F1–F12) and a CATALOG of labelled canned chords (the "Presets" collapsible). Only the
// catalog is configurable — the keyboard is fixed, because a phone with no Escape key has no other
// route to one.
//
// Replacement (not merge) is the resolution rule, for the reason ADR 0018 gives; resolution itself
// lives client-side in `web/src/lib/operator-keys.ts`. This module only decides what a row IS.

/** The named keys Herdr's `pane.send_keys` accepts bare, in their canonical spelling (HERDR_API.md). */
const NAMED: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  tab: "Tab",
  enter: "Enter",
  escape: "Escape",
  space: "Space",
  backspace: "Backspace",
  // Herdr's own alias for Backspace. Normalised away so one chord has one spelling on the wire.
  bs: "Backspace",
};

/** Modifiers Herdr accepts, case-insensitively, joined with `+`. NOT tmux's `C-`/`M-` prefixes. */
const MODIFIERS = new Set(["ctrl", "shift", "alt", "cmd", "super"]);

/**
 * Normalise one chord to the spelling Herdr wants, or null when Herdr would reject it.
 *
 * The grammar is `pane.send_keys`', verified in HERDR_API.md: an optional `+`-joined modifier
 * prefix, then a base that is either ONE literal character, one of the named keys above, or
 * `F1`–`F12`. Everything else fails HERE rather than on the wire — `PageUp`, `Home`, `End`,
 * `Delete` and tmux's `C-c` all return `invalid_key` from the server, and a row that would only
 * ever error is worth more as a startup warning than as a button.
 *
 * Case: modifiers and named keys are matched case-insensitively (Herdr does too) and emitted
 * canonically, so `CTRL+Escape` and `ctrl+escape` cannot render as two different buttons. A literal
 * single character keeps its case — that IS the character typed.
 */
export function normalizeChord(raw: string): string | null {
  const chord = raw.trim();
  if (chord === "") return null;
  // `+` is itself a typable character, so `ctrl++` is ctrl plus the PLUS key — the one place the
  // join character has to be read as data. A single trailing `+` stays a dangling separator
  // (`ctrl+` names no key at all) and fails below.
  const plusBase = chord === "+" || chord.endsWith("++");
  const parts = plusBase ? chord.slice(0, -1).split("+").slice(0, -1) : chord.split("+");
  const base = plusBase ? "+" : (parts.pop() ?? "");
  const mods: string[] = [];
  for (const part of parts) {
    const mod = part.trim().toLowerCase();
    if (!MODIFIERS.has(mod)) return null;
    // A modifier named twice is the same chord; keeping one spelling keeps one button.
    if (!mods.includes(mod)) mods.push(mod);
  }
  const key = normalizeBase(base);
  if (key === null) return null;
  return [...mods, key].join("+");
}

function normalizeBase(base: string): string | null {
  if (base === "") return null;
  const lower = base.toLowerCase();
  if (Object.hasOwn(NAMED, lower)) return NAMED[lower]!;
  if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase();
  // One literal character, typed as itself. `[...base]` counts code points, so an emoji or an
  // accented character is one character here exactly as it is on the operator's keyboard.
  return [...base].length === 1 ? base : null;
}

/** A parsed `keys.toml` document, before a byte of it is believed. */
interface KeysDocument {
  keys?: unknown;
}

/**
 * Turn a parsed TOML document into preset rows, dropping anything malformed with one warning line.
 *
 * Pure and total: it never throws and never reads a file, so the grammar is unit-testable without
 * fs. Every rejection is a DROP of the offending row, never of the file — one typo'd row must not
 * cost the operator the rest of their presets.
 *
 * ```toml
 * [[keys]]
 * scope = "claude"              # optional; omitted = addresses every pane
 * label = "Interrupt"           # required; the button's text, and its identity
 * keys = ["ctrl+c"]             # required; one chord, or several sent as ONE batch
 * danger = true                 # optional; the operator putting their own row behind a two-tap
 * ```
 *
 * Nothing is defaulted into existence: a row with no `label` or no usable `keys` is a row that
 * would render as a nameless or inert button, so it is dropped and said out loud instead.
 */
export function validateOperatorKeys(
  doc: KeysDocument | null | undefined,
  warn = defaultWarn,
): OperatorKeyRow[] {
  const rows = doc?.keys;
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) {
    warn("`keys` must be an array of [[keys]] tables — ignoring the file's rows");
    return [];
  }
  const out: OperatorKeyRow[] = [];
  const at = new Map<string, number>();
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      warn("ignoring a row that is not a [[keys]] table");
      continue;
    }
    const row = raw as Record<string, unknown>;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (label === "") {
      warn(`ignoring a row with no label: ${JSON.stringify(row.keys)}`);
      continue;
    }
    const chords = readChords(row.keys, label, warn);
    if (chords === null) continue;
    let agent = "";
    if (row.scope !== undefined) {
      // Fail closed. Dropping an unusable scope would WIDEN the row to every pane — the opposite of
      // what a scope was typed for.
      if (typeof row.scope !== "string" || row.scope.trim() === "") {
        warn(`ignoring "${label}" — scope must be a non-empty agent name`);
        continue;
      }
      agent = row.scope.trim().toLowerCase();
    }
    if (row.danger !== undefined && typeof row.danger !== "boolean") {
      // Fail closed, and here it is the whole point of the field: reading an unusable `danger` as
      // false would leave the ONE row the operator was trying to slow down firing on a single tap.
      warn(`ignoring "${label}" — danger must be true or false`);
      continue;
    }
    const parsed: OperatorKeyRow = {
      ...(agent ? { agent } : {}),
      label,
      keys: chords,
      danger: row.danger === true,
    };
    // Identity is scope+label, because the label IS what the button says: two rows sharing one on
    // one pane would be two buttons a thumb cannot tell apart. The later row wins IN PLACE, so
    // correcting a preset does not reshuffle the grid.
    const key = `${agent} ${label}`;
    const prev = at.get(key);
    if (prev !== undefined) {
      warn(`"${label}" redefined — the later row wins`);
      out[prev] = parsed;
      continue;
    }
    at.set(key, out.length);
    out.push(parsed);
  }
  return out;
}

/** The row's `keys` array, normalised — or null (already warned) when the row cannot be sent. */
function readChords(value: unknown, label: string, warn: (message: string) => void): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    warn(`ignoring "${label}" — keys must be a non-empty array of chords`);
    return null;
  }
  const chords: string[] = [];
  for (const entry of value) {
    const chord = typeof entry === "string" ? normalizeChord(entry) : null;
    if (chord === null) {
      // The whole row goes, not just the chord: a sequence with a step missing is not a shorter
      // sequence, it is a different one — and this one would type into a real terminal.
      warn(`ignoring "${label}" — ${JSON.stringify(entry)} is not a key herdr accepts`);
      return null;
    }
    chords.push(chord);
  }
  return chords;
}

function defaultWarn(message: string): void {
  console.warn(`[keys] ${message}`);
}

/**
 * A reader for the operator's `keys.toml` — the same mtime cache, the same "no file is not an
 * error" rule and the same hold-the-last-good-rows failure posture `commands.toml` gets, because it
 * is literally the same reader (operator-file.ts).
 */
export function createOperatorKeys(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<OperatorKeyRow[]> {
  return createOperatorFileReader(path, validateOperatorKeys, io, warn);
}
