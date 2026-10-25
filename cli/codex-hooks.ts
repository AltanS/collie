import { join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import { asJsonString } from "../web/src/lib/json.ts";
import { CODEX_NOTIFY_HARNESS } from "./codex-notify.ts";
import type { CliContext } from "./context.ts";
import { EXIT } from "./io.ts";
import type { HooksDeps } from "./hooks.ts";

// `collie hooks install codex` / `uninstall codex` (M56 spec 13): the Codex `notify` setting.
//
// Codex runs ONE notify command, named by a top-level `notify` key in `$CODEX_HOME/config.toml`
// (`~/.codex` when CODEX_HOME is unset). Codex appends the event JSON as the last argument. Collie
// writes `notify = ["<collie>", "beacon", "emit", "codex"]`, and cli/codex-notify.ts turns each event
// into a hook edge.
//
// The edit is line based, never a TOML rewrite: the file is the operator's, with comments and tables
// Collie does not read. The rules:
//
//  - The file is scanned as TOML statements, never as bare lines: a multi-line array, an inline
//    table and a multi-line string ("""...""" or '''...''') each stay one statement, so a `[` row inside
//    them is no table header. A file this scanner cannot read (an open string or bracket at the end,
//    a `]` with no `[`) is refused, and nothing is written.
//  - Only the top level counts: the statements before the first `[table]` header. A `notify` key
//    inside a table is not the notify setting and is left alone. A table whose path starts with
//    `notify` (`[notify]`, `[notify.desktop]`) would clash with a top-level `notify` key, so the
//    install is refused.
//  - The notify line is OURS when it is one line whose array is `[<any path>, "beacon", "emit",
//    "codex"]`. Ours is replaced in place (a moved binary heals); the same bytes write nothing.
//  - A notify statement that is not ours, or one this reader cannot parse, is refused: Codex runs one
//    notify command, and Collie never replaces the operator's.
//  - No notify statement: one line goes in at the top of the file, after the leading comments and
//    blank lines, before the first statement. That is always the top level.
//  - A symlinked config file is refused (a rename would replace the link). The first change takes a
//    `.collie-backup` copy; every write is a temp file and a rename.
//  - Uninstall removes our line and nothing else, and gives back the exact bytes: the line break after
//    the file's last line stays as it was. A file the install created is removed again.

/** The words after the binary in the notify array Collie writes. */
export const CODEX_NOTIFY_VERB: readonly string[] = ["beacon", "emit", CODEX_NOTIFY_HARNESS];

/** The Codex config dir: `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(ctx: Pick<CliContext, "home" | "env">): string {
  const set = (ctx.env.CODEX_HOME ?? "").trim();
  return set === "" ? join(ctx.home, ".codex") : set;
}

/** The Codex config file this install writes. */
export const codexConfigPath = (ctx: Pick<CliContext, "home" | "env">): string => join(codexHome(ctx), "config.toml");

/** The notify line Collie writes for this binary. */
export function codexNotifyLine(binary: string): string {
  return `notify = ${JSON.stringify([binary, ...CODEX_NOTIFY_VERB])}`;
}

/** What the top level of a config file says about notify. */
export type NotifyState =
  | { readonly kind: "none"; readonly insertAt: number }
  | { readonly kind: "ours"; readonly line: number; readonly binary: string }
  | { readonly kind: "theirs"; readonly line: number; readonly text: string }
  | { readonly kind: "unreadable"; readonly line: number; readonly text: string }
  | { readonly kind: "unparsed"; readonly line: number; readonly problem: string }
  | { readonly kind: "table"; readonly line: number; readonly text: string };

/** One top-level statement: its first and last line, and its key (null for a table header). */
interface Statement {
  readonly first: number;
  readonly last: number;
  readonly key: string | null;
}

/** A table header: its line and the first part of its path. */
interface Header {
  readonly line: number;
  readonly head: string;
}

/** The top-level statements up to the first table header, every table header, or the line where the scan failed. */
type TopLevel =
  | { readonly ok: true; readonly statements: readonly Statement[]; readonly headers: readonly Header[] }
  | { readonly ok: false; readonly line: number; readonly problem: string };

const HEADER_HEAD = /^\s*\[\[?\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')/u;

const NOTIFY_ARRAY = /^\s*notify\s*=\s*(\[.*\])\s*(?:#.*)?$/u;
const BARE_KEY = /^\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*(?:[.=])/u;

/**
 * Where a multi-line string ends on this line: the index just past its closing delimiter, -1 when it
 * runs on to the next line, -2 when a run of quotes is longer than TOML allows. TOML lets one or two
 * quotes sit directly before the closing three, so a run of 3 to 5 closes the string and the last
 * three of it are the delimiter: `'''it's'''' ` ends with a literal apostrophe in the value, and the
 * first three quotes of the run are not the close. A basic string's backslash escapes the next
 * character, so `\"""` is a quote and no close.
 */
function multiClose(line: string, from: number, delim: '"""' | "'''"): number {
  const quote = delim[0]!;
  let at = from;
  while (at < line.length) {
    const ch = line[at]!;
    if (quote === '"' && ch === "\\") {
      at += 2;
      continue;
    }
    if (ch !== quote) {
      at++;
      continue;
    }
    let run = 1;
    while (line[at + run] === quote) run++;
    if (run > 5) return -2;
    if (run >= 3) return at + run;
    at += run;
  }
  return -1;
}

/**
 * Scans a TOML file: the top-level statements before the first table header, and every header. It knows
 * strings (basic, literal, and both multi-line forms), comments, arrays and inline tables, so a row
 * inside a value never reads as a header. It does not check the TOML beyond that.
 */
export function scanTopLevel(lines: readonly string[]): TopLevel {
  const statements: Statement[] = [];
  const headers: Header[] = [];
  let depth = 0;
  let multi: '"""' | "'''" | null = null;
  let first = -1;
  let key: string | null = null;
  // The statements count until the first header; the scan goes on to find every header.
  let top = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let at = 0;
    if (multi === null && depth === 0) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[")) {
        const head = HEADER_HEAD.exec(line)?.[1]?.replace(/^["']|["']$/gu, "") ?? "";
        headers.push({ line: i, head });
        top = false;
        continue;
      }
      first = i;
      const named = BARE_KEY.exec(line);
      key = named === null ? null : named[1]!.replace(/^["']|["']$/gu, "");
    }
    while (at < line.length) {
      if (multi !== null) {
        const close = multiClose(line, at, multi);
        if (close === -1) break;
        if (close === -2) return { ok: false, line: i, problem: "a multi-line string closed by more than five quotes" };
        at = close;
        multi = null;
        continue;
      }
      const ch = line[at]!;
      if (ch === "#") break;
      if (line.startsWith('"""', at) || line.startsWith("'''", at)) {
        multi = line.startsWith('"""', at) ? '"""' : "'''";
        at += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let end = at + 1;
        while (end < line.length && line[end] !== ch) end += ch === '"' && line[end] === "\\" ? 2 : 1;
        if (end >= line.length) return { ok: false, line: i, problem: "a string with no closing quote" };
        at = end + 1;
        continue;
      }
      if (ch === "[" || ch === "{") depth++;
      if (ch === "]" || ch === "}") {
        depth--;
        if (depth < 0) return { ok: false, line: i, problem: `a ${ch} with no opening bracket` };
      }
      at++;
    }
    if (multi === null && depth === 0 && first !== -1) {
      if (top) statements.push({ first, last: i, key });
      first = -1;
    }
  }
  if (multi !== null) return { ok: false, line: lines.length - 1, problem: "a multi-line string with no end" };
  if (depth !== 0) return { ok: false, line: lines.length - 1, problem: "an array or inline table with no end" };
  return { ok: true, statements, headers };
}

/** The notify array as strings, or null when it is not a one-line array of double-quoted strings. */
function notifyArray(line: string): string[] | null {
  const found = NOTIFY_ARRAY.exec(line);
  if (found === null) return null;
  let value: JsonValue;
  try {
    value = JSON.parse(found[1]!);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const parts = value.map((part) => asJsonString(part));
  return parts.every((part) => part !== undefined) ? parts.filter((part) => part !== undefined) : null;
}

/** Reads the top level of a config file's lines for the notify key. */
export function notifyState(lines: readonly string[]): NotifyState {
  const top = scanTopLevel(lines);
  if (!top.ok) return { kind: "unparsed", line: top.line, problem: top.problem };
  const table = top.headers.find((header) => header.head === "notify");
  if (table !== undefined) return { kind: "table", line: table.line, text: lines[table.line]!.trim() };
  const notify = top.statements.find((statement) => statement.key === "notify");
  if (notify === undefined) {
    // At the top, after the leading comments and blank lines: before the first statement or header.
    let insertAt = 0;
    while (insertAt < lines.length && (lines[insertAt]!.trim() === "" || lines[insertAt]!.trim().startsWith("#"))) insertAt++;
    return { kind: "none", insertAt };
  }
  const text = lines.slice(notify.first, notify.last + 1).join(" ").trim();
  if (notify.first !== notify.last) return { kind: "unreadable", line: notify.first, text };
  const array = notifyArray(lines[notify.first]!);
  if (array === null) return { kind: "unreadable", line: notify.first, text };
  const ours = array.length === CODEX_NOTIFY_VERB.length + 1 && CODEX_NOTIFY_VERB.every((word, k) => array[k + 1] === word);
  return ours ? { kind: "ours", line: notify.first, binary: array[0]! } : { kind: "theirs", line: notify.first, text };
}

/** A file's lines, and whether a line break follows the last one. An empty file has neither. */
interface FileLines {
  readonly lines: readonly string[];
  readonly finalBreak: boolean;
}

function linesOf(text: string): FileLines {
  if (text === "") return { lines: [], finalBreak: true };
  const finalBreak = text.endsWith("\n");
  return { lines: (finalBreak ? text.slice(0, -1) : text).split("\n"), finalBreak };
}

/** The text of these lines, with the line break after the last one only where the file had it. */
const textOf = (lines: readonly string[], finalBreak: boolean): string => (lines.length === 0 ? "" : `${lines.join("\n")}${finalBreak ? "\n" : ""}`);

/** The config text with Collie's notify line in it, or a refusal. */
export function installNotify(text: string, binary: string): { readonly text: string } | { readonly refuse: string } {
  const { lines, finalBreak } = linesOf(text);
  const state = notifyState(lines);
  const ours = codexNotifyLine(binary);
  switch (state.kind) {
    case "theirs":
      return { refuse: `it already runs a notify command of its own (${state.text}). Codex runs one notify command, so Collie leaves yours in place` };
    case "unreadable":
      return { refuse: `its notify setting is in a shape Collie cannot read (${state.text})` };
    case "unparsed":
      return { refuse: `Collie cannot read its TOML at line ${String(state.line + 1)} (${state.problem}), so Collie writes nothing` };
    case "table":
      return { refuse: `it has a table named notify at line ${String(state.line + 1)} (${state.text}). A notify line would clash with it, so Collie writes nothing` };
    case "ours":
      return { text: textOf(lines.map((line, i) => (i === state.line ? ours : line)), finalBreak) };
    case "none":
      return { text: textOf([...lines.slice(0, state.insertAt), ours, ...lines.slice(state.insertAt)], finalBreak) };
  }
}

/** The config text without Collie's notify line. Text with no line of ours comes back unchanged. */
export function uninstallNotify(text: string): string {
  const { lines, finalBreak } = linesOf(text);
  const state = notifyState(lines);
  if (state.kind !== "ours") return text;
  return textOf(lines.filter((_, i) => i !== state.line), finalBreak);
}

/** Temp file, then rename, and the one-time backup before the first change. */
function writeConfig(deps: HooksDeps, path: string, previous: string | null, text: string): void {
  const backup = `${path}.collie-backup`;
  if (previous !== null && !deps.files.exists(backup)) deps.files.write(backup, previous, 0o600);
  const temp = `${path}.collie-tmp`;
  try {
    deps.files.write(temp, text, 0o600);
    deps.files.rename(temp, path);
  } catch (err) {
    deps.files.remove(temp);
    throw err;
  }
}

/** `collie hooks install codex`. `binary` is the absolute name the Claude hooks pin to (cli/hooks.ts). */
export function cmdCodexHooksInstall(deps: HooksDeps, binary: string, pinnedNote: string): number {
  const path = codexConfigPath(deps.ctx);
  if (deps.fs.probe(path).kind === "symlink") {
    deps.io.err(`error: ${path} is a symlink. Collie does not write there.`);
    deps.io.err("  Replace it with the real file, then run `collie hooks install codex` again.");
    return EXIT.FAIL;
  }
  const previous = deps.files.read(path);
  const outcome = installNotify(previous ?? "", binary);
  if ("refuse" in outcome) {
    deps.io.err(`error: ${path} cannot take the Collie notify command: ${outcome.refuse}.`);
    deps.io.err("  Remove your notify line, or keep it and go without hook edges for Codex.");
    return EXIT.FAIL;
  }
  if (outcome.text === previous) {
    deps.io.out(`${path} already has it. No bytes changed.`);
  } else {
    try {
      writeConfig(deps, path, previous, outcome.text);
    } catch (err) {
      deps.io.err(`error: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT.FAIL;
    }
    deps.io.out(`✓ ${path}`);
  }
  deps.io.out(`  notify → \`${binary} ${CODEX_NOTIFY_VERB.join(" ")}\``);
  deps.io.out(`  ${pinnedNote}`);
  deps.io.out("  Codex calls it when a turn ends. Collie then reads the pane again at once.");
  deps.io.out("  Codex sends no event for an approval dialog. The screen still shows those.");
  deps.io.out("  A Codex that started before this install keeps its old setting until it restarts.");
  return EXIT.OK;
}

/** `collie hooks uninstall codex`: removes Collie's notify line and nothing else. */
export function cmdCodexHooksUninstall(deps: HooksDeps): number {
  const path = codexConfigPath(deps.ctx);
  const previous = deps.files.read(path);
  if (previous === null || deps.fs.probe(path).kind === "symlink") {
    deps.io.out(`nothing to remove: ${path} has no Collie notify command.`);
    return EXIT.OK;
  }
  const text = uninstallNotify(previous);
  if (text === previous) {
    deps.io.out(`nothing to remove: ${path} has no Collie notify command.`);
    return EXIT.OK;
  }
  // The install created this file: it had no file to back up. With our line gone it is empty, so it goes.
  if (text === "" && !deps.files.exists(`${path}.collie-backup`)) {
    try {
      deps.files.remove(path);
    } catch (err) {
      deps.io.err(`error: could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT.FAIL;
    }
    deps.io.out(`✓ ${path}: removed. The install had created it.`);
    return EXIT.OK;
  }
  try {
    writeConfig(deps, path, previous, text);
  } catch (err) {
    deps.io.err(`error: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ ${path}: removed the Collie notify command. Every other line is untouched.`);
  return EXIT.OK;
}

/** One line for `collie hooks status`: what the Codex config carries. Reads only. */
export function codexHooksStatusLine(deps: HooksDeps, binary: string): string {
  const path = codexConfigPath(deps.ctx);
  if (deps.fs.probe(path).kind === "symlink") return `${path}: refused, the file is a symlink`;
  const text = deps.files.read(path);
  if (text === null) return `${path}: no config file. \`collie hooks install codex\` creates one`;
  const state = notifyState(linesOf(text).lines);
  switch (state.kind) {
    case "none":
      return `${path}: not installed`;
    case "unparsed":
      return `${path}: not installed, Collie cannot read its TOML at line ${String(state.line + 1)}`;
    case "table":
      return `${path}: not installed, it has a table named notify at line ${String(state.line + 1)}`;
    case "theirs":
      return `${path}: not installed, the file runs its own notify command`;
    case "unreadable":
      return `${path}: not installed, its notify setting is in a shape Collie cannot read`;
    case "ours":
      return state.binary === binary ? `${path}: installed` : `${path}: installed for ${state.binary}. Run install again to pin it to ${binary}`;
  }
}
