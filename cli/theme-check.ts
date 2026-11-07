import { readFileSync, statSync } from "node:fs";

import { en } from "../web/src/lib/i18n/messages/en.ts";
import { interpolate } from "../web/src/lib/i18n/template.ts";
import { CONTRAST_FAIL_KEY, HALF_KEYS, REFUSAL_KEYS, isMoreLine } from "../web/src/lib/theme/report-words.ts";
import {
  DEFAULT_THEME_ID,
  THEME_MAX_BYTES,
  contrastReport,
  parseTheme,
  sizeRefusal,
  type Finding,
  type Refusal,
  type Theme,
} from "../web/src/lib/theme/schema.ts";
import collieFile from "../web/src/themes/collie.json";
import { EXIT, type Io } from "./io.ts";

// `collie theme check <file>...` (M59 spec 05): validate theme files with the app's own parser and
// print the refusals and the contrast report, with an exit code a CI job can branch on.
//
// ONE VALIDATOR. Nothing here knows a token, a word or a floor. The parser, the size cap and the
// contrast report are imported from `web/src/lib/theme/` as `scripts/build-themes.ts` imports them,
// and every sentence comes from the English bundle through the same keys the Theme card resolves
// (`report-words.ts`). So a file this verb passes is a file the phone imports, and a refusal reads
// here as it reads in Settings.
//
// NO STATE, NO NETWORK. The verb reads the files it is named and nothing else: no context, no state
// dir, no config. It writes only to stdout and stderr, so it runs in a theme repository's CI job on a
// machine that has never run Collie.
//
// EXIT CODES. 0 when every file parses (contrast warnings do not fail it: the app lets a person
// Apply a theme that warns), 1 when a file is refused or cannot be read, 2 on a usage error.

/** The sub-verbs of `theme`, in the order the usage line prints them. */
export const THEME_SUBCOMMANDS = ["check"] as const;

/** What the verb needs from the filesystem: a regular file's size and its text. */
export interface ThemeFiles {
  /** The byte size of a regular file, or null when the path is not one or cannot be read. */
  size(path: string): number | null;
  /** The file's text, or null when it cannot be read. */
  read(path: string): string | null;
}

export interface ThemeCheckDeps {
  io: Io;
  files: ThemeFiles;
}

export const realThemeFiles: ThemeFiles = {
  size(path) {
    try {
      const stat = statSync(path);
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/**
 * One refusal as the Theme card's sheet shows it (`entryOfRefusal`): the headline, where in the file,
 * and the parser's words. The closing "and N more" line has neither a place nor a detail, and a
 * shipped id has no detail, because its headline says it all.
 */
export interface CheckRefusal {
  code: Refusal["code"];
  headline: string;
  path?: string;
  detail?: string;
}

/** One contrast warning: the finding and the line the preview sheet shows for it. */
export interface CheckWarning {
  half: Finding["half"];
  check: string;
  ratio: number;
  floor: number;
  text: string;
}

/** The result for one file, the shape `--json` prints. */
export type FileReport =
  | { file: string; ok: true; id: string; name: string; version: number; warnings: CheckWarning[] }
  | { file: string; ok: false; error?: string; refusals: CheckRefusal[] };

const USAGE = "usage: collie theme check [--json] [--shipped] <file>...";

function usage(io: Io): void {
  io.err(USAGE);
  io.err("  check   validate theme files with the app's parser and print the refusals and the contrast report");
  io.err("  --json     print the report as one JSON object");
  io.err("  --shipped  accept the id of a shipped theme (for Collie's own files; an import refuses one)");
}

/** The default theme, the base the contrast report fills a missing token from, as the app does. */
function collieBase(): Theme {
  const parsed = parseTheme(JSON.stringify(collieFile), { maxBytes: THEME_MAX_BYTES, allowReservedId: true });
  if (!parsed.ok || parsed.theme.id !== DEFAULT_THEME_ID) throw new Error(`the shipped theme ${DEFAULT_THEME_ID} does not parse`);
  return parsed.theme;
}

function refusalOf(refusal: Refusal): CheckRefusal {
  if (isMoreLine(refusal)) return { code: refusal.code, headline: refusal.detail };
  const headline = en[REFUSAL_KEYS[refusal.code]];
  if (refusal.code === "reserved-id") return { code: refusal.code, headline, path: refusal.path };
  return { code: refusal.code, headline, path: refusal.path, detail: refusal.detail };
}

function warningOf(finding: Finding): CheckWarning {
  const text = interpolate(en[CONTRAST_FAIL_KEY], {
    half: en[HALF_KEYS[finding.half]],
    check: finding.check,
    ratio: finding.ratio,
    floor: finding.floor,
  });
  return { half: finding.half, check: finding.check, ratio: finding.ratio, floor: finding.floor, text };
}

/** Check one file. Pure over the {@link ThemeFiles} seam. */
export function checkFile(files: ThemeFiles, file: string, opts: { allowReservedId: boolean; base: Theme }): FileReport {
  const size = files.size(file);
  if (size === null) return { file, ok: false, error: "cannot read the file", refusals: [] };
  // Refused on its size before a byte of it is read, with the parser's own sentence.
  if (size > THEME_MAX_BYTES) return { file, ok: false, refusals: [refusalOf(sizeRefusal(size, THEME_MAX_BYTES))] };
  const raw = files.read(file);
  if (raw === null) return { file, ok: false, error: "cannot read the file", refusals: [] };
  const parsed = parseTheme(raw, { maxBytes: THEME_MAX_BYTES, allowReservedId: opts.allowReservedId });
  if (!parsed.ok) return { file, ok: false, refusals: parsed.refusals.map(refusalOf) };
  const { theme } = parsed;
  const warnings = contrastReport(theme, opts.base)
    .filter((finding) => !finding.pass)
    .map(warningOf);
  return { file, ok: true, id: theme.id, name: theme.name, version: theme.version, warnings };
}

function printText(io: Io, report: FileReport): void {
  if (report.ok) {
    const count = report.warnings.length;
    const tail = count === 0 ? "every contrast check passes" : `${count} contrast ${count === 1 ? "warning" : "warnings"}`;
    io.out(`${report.file}: ok, "${report.name}" (${report.id}), version ${report.version}, ${tail}`);
    for (const warning of report.warnings) io.out(`${report.file}: warning: ${warning.text}`);
    return;
  }
  if (report.error !== undefined) {
    io.out(`${report.file}: refused: ${report.error}`);
    return;
  }
  for (const refusal of report.refusals) {
    const where = refusal.path === undefined ? "" : ` (${refusal.path}${refusal.detail === undefined ? "" : `: ${refusal.detail}`})`;
    io.out(`${report.file}: refused: ${refusal.headline}${where}`);
  }
}

/** `collie theme check [--json] [--shipped] <file>...` */
export function cmdThemeCheck(deps: ThemeCheckDeps, args: readonly string[]): number {
  const flags = new Set(["--json", "--shipped"]);
  const unknown = args.find((arg) => arg.startsWith("-") && !flags.has(arg));
  if (unknown !== undefined) {
    deps.io.err(`error: unknown option \`${unknown}\``);
    usage(deps.io);
    return EXIT.USAGE;
  }
  const paths = args.filter((arg) => !flags.has(arg));
  if (paths.length === 0) {
    deps.io.err("error: name at least one theme file");
    usage(deps.io);
    return EXIT.USAGE;
  }
  const opts = { allowReservedId: args.includes("--shipped"), base: collieBase() };
  const reports = paths.map((path) => checkFile(deps.files, path, opts));
  const ok = reports.every((report) => report.ok);
  if (args.includes("--json")) deps.io.out(JSON.stringify({ ok, files: reports }));
  else for (const report of reports) printText(deps.io, report);
  return ok ? EXIT.OK : EXIT.FAIL;
}

/** `collie theme`: the tree's fallback, for a bare `theme` and an unknown sub-verb. */
export function cmdTheme(deps: ThemeCheckDeps, args: readonly string[]): number {
  const [sub, ...rest] = args;
  if (sub === "check") return cmdThemeCheck(deps, rest);
  deps.io.err(sub === undefined ? "error: name a sub-verb" : `error: unknown theme subcommand \`${sub}\``);
  usage(deps.io);
  return EXIT.USAGE;
}
