// The slash command lists of the lab's walk (M44 spec 05, carried by M56 spec 10). The file is
// `slash-commands.json`: two hand-kept lists per harness, `safe` and `unsafe`, each entry with a reason.
// This module reads it, checks its shape, and sorts the commands an agent lists into three groups:
// the ones the lab sends, the ones it never sends, and the ones it does not know (`unclassified`).
// The lab sends only a command on the safe list. It never sends an unclassified command.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asJsonObject, asJsonString, parseJson, type JsonValue } from "../../web/src/lib/json";

export const SLASH_FILE = fileURLToPath(new URL("./slash-commands.json", import.meta.url));

export type Opens = "dialog" | "inline";

export interface SafeCommand {
  readonly command: string;
  readonly opens: Opens;
  readonly reason: string;
}

export interface UnsafeCommand {
  readonly command: string;
  readonly reason: string;
}

export interface SlashLists {
  readonly safe: readonly SafeCommand[];
  readonly unsafe: readonly UnsafeCommand[];
}

/** The commands the lab must never send, whatever else the file says. M44 spec 05 names them. */
export const ALWAYS_UNSAFE = ["/clear", "/compact", "/logout", "/init", "/review", "/config"] as const;

const COMMAND = /^\/[a-z][a-z0-9:_.-]*$/u;

function list(value: JsonValue | undefined, where: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${where} is not a list`);
  return value;
}

interface Entry {
  readonly command: string;
  readonly reason: string;
  readonly opens: string | undefined;
}

function entryOf(value: JsonValue | undefined, where: string): Entry {
  const node = asJsonObject(value);
  const command = asJsonString(node?.command);
  const reason = asJsonString(node?.reason);
  if (node === undefined || command === undefined || !COMMAND.test(command)) throw new Error(`${where}: a command like /name is needed`);
  if (reason === undefined || reason.trim().length === 0) throw new Error(`${where}: ${command} needs a reason`);
  return { command, reason, opens: asJsonString(node.opens) };
}

/** The lists of one harness, parsed and checked. Throws a message that names the entry. */
export function parseSlashLists(text: string, harness: string): SlashLists {
  const root = asJsonObject(parseJson(text));
  const node = asJsonObject(root?.[harness]);
  if (node === undefined) return { safe: [], unsafe: [] };
  const safe = list(node.safe, `${harness}.safe`).map((value, i): SafeCommand => {
    const entry = entryOf(value, `${harness}.safe[${String(i)}]`);
    if (entry.opens !== "dialog" && entry.opens !== "inline") throw new Error(`${harness}.safe[${String(i)}]: ${entry.command} needs opens: dialog or inline`);
    return { command: entry.command, opens: entry.opens, reason: entry.reason };
  });
  const unsafe = list(node.unsafe, `${harness}.unsafe`).map((value, i): UnsafeCommand => {
    const { command, reason } = entryOf(value, `${harness}.unsafe[${String(i)}]`);
    return { command, reason };
  });
  const seen = new Set<string>();
  for (const { command } of [...safe, ...unsafe]) {
    if (seen.has(command)) throw new Error(`${harness}: ${command} is listed twice or on both lists`);
    seen.add(command);
  }
  for (const command of ALWAYS_UNSAFE) {
    if (safe.some((entry) => entry.command === command)) throw new Error(`${harness}: ${command} must never be on the safe list`);
  }
  return { safe, unsafe };
}

export function loadSlashLists(harness: string, path: string = SLASH_FILE): SlashLists {
  return parseSlashLists(readFileSync(path, "utf8"), harness);
}

export interface Classified {
  /** Safe commands the agent lists, in the file's order. The lab sends these. */
  readonly send: readonly SafeCommand[];
  /** Commands the agent lists that are on neither list. Reported, never sent. */
  readonly unclassified: readonly string[];
  /** Commands the agent lists that are on the unsafe list. Never sent. */
  readonly skipped: readonly string[];
  /** Safe commands the agent no longer lists. A drift to read: the command moved or went. */
  readonly missing: readonly string[];
  /** Commands the menu marks "(removed)" (Claude 2.1.302 lists `/agents` so). Reported, never sent, on any list. */
  readonly removed: readonly string[];
}

export function classifyCommands(listed: readonly string[], lists: SlashLists, removed: readonly string[] = []): Classified {
  const gone = new Set(removed);
  const known = new Set(listed.filter((command) => !gone.has(command)));
  const safeSet = new Set(lists.safe.map((entry) => entry.command));
  const unsafeSet = new Set(lists.unsafe.map((entry) => entry.command));
  return {
    send: lists.safe.filter((entry) => known.has(entry.command)),
    unclassified: [...known].filter((command) => !safeSet.has(command) && !unsafeSet.has(command)),
    skipped: [...known].filter((command) => unsafeSet.has(command)),
    missing: lists.safe.filter((entry) => !known.has(entry.command) && !gone.has(entry.command)).map((entry) => entry.command),
    removed: listed.filter((command) => gone.has(command)),
  };
}

/**
 * The commands one screen of the `/` menu shows, in order, and the command the pointer stands on.
 * A row is `  ❯ /name    description` or `    /name    description`. A description that opens with
 * `(removed)` marks a command the agent still lists but no longer runs.
 */
export interface SlashMenu {
  readonly names: readonly string[];
  readonly pointed: string | null;
  readonly removed: readonly string[];
}

/** The mark Claude Code puts in front of a retired command's description. */
const REMOVED_MARK = /^\(removed\)/u;

export function parseSlashMenu(rows: readonly string[]): SlashMenu {
  const names: string[] = [];
  const removed: string[] = [];
  let pointed: string | null = null;
  for (const row of rows) {
    const hit = /^\s*([❯>])?\s*(\/[A-Za-z][\w:.-]*)\s{2,}(\S.*)$/u.exec(row);
    if (hit?.[2] === undefined) continue;
    const name = hit[2];
    names.push(name);
    if (hit[1] !== undefined) pointed = name;
    if (REMOVED_MARK.test(hit[3] ?? "")) removed.push(name);
  }
  return { names, pointed, removed };
}
