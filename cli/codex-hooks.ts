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
//  - Only the top level counts: the lines before the first `[table]` header. A `notify` key inside a
//    table is not the notify setting and is left alone.
//  - The notify line is OURS when its array is `[<any path>, "beacon", "emit", "codex"]`. Ours is
//    replaced in place (a moved binary heals); the same bytes write nothing.
//  - A notify line that is not ours, or one this reader cannot parse, is refused: Codex runs one
//    notify command, and Collie never replaces the operator's.
//  - No notify line: one line goes in after the last top-level line, before the first table.
//  - A symlinked config file is refused (a rename would replace the link). The first change takes a
//    `.collie-backup` copy; every write is a temp file and a rename.
//  - Uninstall removes our line and nothing else. Install then uninstall gives the same bytes back.

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
  | { readonly kind: "unreadable"; readonly line: number; readonly text: string };

const TABLE_HEADER = /^\s*\[/u;
const NOTIFY_KEY = /^\s*notify\s*=/u;
const NOTIFY_ARRAY = /^\s*notify\s*=\s*(\[.*\])\s*(?:#.*)?$/u;

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
  const header = lines.findIndex((line) => TABLE_HEADER.test(line));
  const top = header === -1 ? lines.length : header;
  let last = -1;
  for (let i = 0; i < top; i++) {
    const line = lines[i]!;
    if (NOTIFY_KEY.test(line)) {
      const array = notifyArray(line);
      if (array === null) return { kind: "unreadable", line: i, text: line.trim() };
      const ours = array.length === CODEX_NOTIFY_VERB.length + 1 && CODEX_NOTIFY_VERB.every((word, k) => array[k + 1] === word);
      return ours ? { kind: "ours", line: i, binary: array[0]! } : { kind: "theirs", line: i, text: line.trim() };
    }
    if (line.trim() !== "") last = i;
  }
  return { kind: "none", insertAt: last + 1 };
}

/** The file's lines, without the line break after the last one. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

const textOf = (lines: readonly string[]): string => (lines.length === 0 ? "" : `${lines.join("\n")}\n`);

/** The config text with Collie's notify line in it, or a refusal. */
export function installNotify(text: string, binary: string): { readonly text: string } | { readonly refuse: string } {
  const lines = linesOf(text);
  const state = notifyState(lines);
  const ours = codexNotifyLine(binary);
  switch (state.kind) {
    case "theirs":
      return { refuse: `it already runs a notify command of its own (${state.text}). Codex runs one notify command, so Collie leaves yours in place` };
    case "unreadable":
      return { refuse: `its notify line is in a shape Collie cannot read (${state.text})` };
    case "ours":
      return { text: textOf(lines.map((line, i) => (i === state.line ? ours : line))) };
    case "none":
      return { text: textOf([...lines.slice(0, state.insertAt), ours, ...lines.slice(state.insertAt)]) };
  }
}

/** The config text without Collie's notify line. Text with no line of ours comes back unchanged. */
export function uninstallNotify(text: string): string {
  const lines = linesOf(text);
  const state = notifyState(lines);
  if (state.kind !== "ours") return text;
  return textOf(lines.filter((_, i) => i !== state.line));
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
  const state = notifyState(linesOf(text));
  switch (state.kind) {
    case "none":
      return `${path}: not installed`;
    case "theirs":
      return `${path}: not installed, the file runs its own notify command`;
    case "unreadable":
      return `${path}: not installed, its notify line is in a shape Collie cannot read`;
    case "ours":
      return state.binary === binary ? `${path}: installed` : `${path}: installed for ${state.binary}. Run install again to pin it to ${binary}`;
  }
}
