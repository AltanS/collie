import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { apiSocketPath } from "../bridge/api/socket.ts";
import { DECLARED, OPERATION_NAMES, type ArgDecl } from "../bridge/api/operations.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { privateDir } from "./private-dir.ts";
import { EXIT, type Io } from "./io.ts";
import type { Files } from "./sys.ts";
import { AskLate } from "./walky.ts";

// `collie api <operation> [flags] [--json]` (M105 spec 03, decision 19): the command face of the local
// API. EXPERIMENTAL: the shapes may change in a minor release.
//
// GENERATED, NOT WRITTEN. The operations, their flags and their help come from the operation table's
// declarations (`DECLARED` in bridge/api/operations.ts): a row's name is the operation, each declared
// argument is a flag spelled in kebab case (`--session`, `--lines`, `--after`, `--wait`), and the
// summary and the argument help are the help text. There is no hand-written verb per operation and no
// per-operation printer, so a row added to the table appears here with no change to this file.
// operations.test.ts keeps each row's parser and its declaration in agreement.
//
// THE ROAD. One connection to `<stateDir>/api/sock`, one request line `{id, op, args}`, one answer
// line, close. The socket exists only while a trick is switched on (ADR 0152); with none, the verb
// prints ONE line to stderr, "The local API is on while tricks are switched on.", and exits {@link EXIT.STATE}.
// Windows has no such socket, so it prints the same line. The socket is dialled only when it is a
// socket of this user inside folders only this user can write (the check the hold and walky sockets
// get), because a socket another user could plant would read the request and could answer it. There is
// no token to send: the file mode is the credential.
//
// EXIT CODES (one mapping):
//   0  EXIT.OK       the answer was `ok: true`
//   2  EXIT.USAGE    the command line: an unknown operation, an unknown or repeated flag, a flag with no
//                    value, a required flag left out, a whole-number flag given text. Nothing was sent.
//   3  EXIT.STATE    no local API here (no socket), or a socket that is not safe to dial
//   4  EXIT.REFUSED  the bridge answered `ok: false` with any code but `api.failed` (bad request, no
//                    such session, busy, closing, ...)
//   1  EXIT.FAIL     the bridge answered `api.failed`, did not answer in time, or sent an answer that
//                    is not one JSON line
// With `--json` the answer line is printed to stdout as the bridge sent it, an error answer too, and the
// exit code is the same. Only DEL and the C1 characters are written as `\u00XX` (`escapeC1`): the same
// JSON value, and nothing that moves the person's terminal.
//
// THE PLAIN PRINT is generic over the answer. A scalar is `key: value`; a nested object is flattened to
// `a.b: value`; a list of objects is a heading, then aligned columns (one per flattened key); a list of
// text is `key: a, b`; a text of several lines is `key:` with the lines indented under it. Every
// character below a space (an escape, a bell) is printed as `?`, so a name an agent chose cannot move
// the person's terminal. An error is `error: <message>` on stderr.

/** The one line of a socket that is not there. */
export const NO_LOCAL_API = "The local API is on while tricks are switched on.";
/** How long one request may take, and how long an `events` wait may. */
export const API_ASK_MS = 10_000;
export const API_WAIT_ASK_MS = 35_000;

/** What the command face reads of one operation: the table's own declaration. */
export interface CliOperation {
  readonly name: string;
  readonly summary: string;
  readonly args: readonly ArgDecl[];
}

/** The operations of the table, in table order. */
export function declaredOperations(): readonly CliOperation[] {
  return OPERATION_NAMES.map((name) => DECLARED[name]);
}

export interface ApiDeps {
  readonly io: Io;
  readonly stateDir: string;
  readonly platform: string;
  readonly files: Files;
  /** This process's uid: the socket and its folders must be this user's own. Absent off POSIX. */
  readonly uid?: number | undefined;
  /** One request line, its answer line. Null when nothing answered; rejects with {@link AskLate} past `ms`. */
  ask(path: string, line: string, ms: number): Promise<string | null>;
  /** The operations to offer. Default: the table's ({@link declaredOperations}); a test passes its own. */
  readonly operations?: readonly CliOperation[];
  readonly mintId?: () => string;
}

// ── The flags ────────────────────────────────────────────────────────────────────────────────────

/** `lines` is spelled `--lines`; a camelCase name is spelled `--the-name`. */
export function flagOf(name: string): string {
  return `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
}

function valueWord(arg: ArgDecl): string {
  return arg.type === "integer" ? "<number>" : "<text>";
}

/** The generated help: what this is, then every operation with its flags. */
export function apiHelp(operations: readonly CliOperation[]): string[] {
  const width = Math.max(...operations.map((one) => one.name.length)) + 2;
  const lines = [
    "usage: collie api <operation> [flags] [--json]",
    "",
    "Experimental: the shapes of the local API may change in a minor release.",
    "The local API is on while tricks are switched on, and it only reads.",
    "",
  ];
  for (const one of operations) {
    lines.push(`  ${one.name.padEnd(width)}${one.summary}`);
    for (const arg of one.args) {
      const flag = `${flagOf(arg.name)} ${valueWord(arg)}`;
      lines.push(`  ${"".padEnd(width)}  ${flag}  ${arg.required ? "(required) " : ""}${arg.help}`);
    }
  }
  lines.push("", `  ${"--json".padEnd(width)}print the answer line as the bridge sent it`);
  return lines;
}

type Parsed = { readonly ok: true; readonly args: JsonObject; readonly json: boolean } | { readonly ok: false; readonly why: string };

/** The flags of one operation: `--name value`, `--name=value` and `--json`. Types are checked here, ranges by the bridge. */
export function parseFlags(operation: CliOperation, argv: readonly string[]): Parsed {
  const byFlag = new Map(operation.args.map((arg) => [flagOf(arg.name), arg]));
  const args: Record<string, JsonValue> = {};
  let json = false;
  for (let at = 0; at < argv.length; at += 1) {
    const token = argv[at] ?? "";
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq < 0 ? token : token.slice(0, eq);
    if (flag === "--json" && eq < 0) {
      json = true;
      continue;
    }
    const arg = byFlag.get(flag);
    if (arg === undefined) return { ok: false, why: `\`${operation.name}\` takes no \`${token}\`` };
    if (Object.hasOwn(args, arg.name)) return { ok: false, why: `${flag} is given twice` };
    let raw: string | undefined;
    if (eq >= 0) raw = token.slice(eq + 1);
    else {
      at += 1;
      raw = argv[at];
    }
    if (raw === undefined || raw === "") return { ok: false, why: `${flag} needs a value` };
    if (arg.type === "string") {
      args[arg.name] = raw;
      continue;
    }
    if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) return { ok: false, why: `${flag} must be a whole number` };
    args[arg.name] = Number(raw);
  }
  const missing = operation.args.find((arg) => arg.required && !Object.hasOwn(args, arg.name));
  if (missing !== undefined) return { ok: false, why: `\`${operation.name}\` needs ${flagOf(missing.name)} ${valueWord(missing)}` };
  return { ok: true, args, json };
}

// ── The plain print ──────────────────────────────────────────────────────────────────────────────

/** A text with every character below a space (but a tab or a line end) as `?`. */
function clean(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = (code < 32 && code !== 9 && code !== 10) || code === 127 || (code >= 128 && code < 160);
    out += control ? "?" : char;
  }
  return out;
}

/**
 * The answer line for `--json` with DEL (U+007F) and every C1 character (U+0080 to U+009F) written as
 * `\u00XX` (security read 2, item 3). A JSON line holds such a character only inside a string, where the
 * escape is the same value, so the line stays valid JSON and reads back the same; a terminal never sees
 * a raw CSI (U+009B). A C0 character cannot be raw in a JSON string: the parse above refused it.
 */
export function escapeC1(line: string): string {
  return line.replace(/[\u007f-\u009f]/gu, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
}

function cell(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "-";
  const text = asJsonString(value);
  if (text !== undefined) return clean(text).replace(/\s+/gu, " ").trim() || "-";
  if (Array.isArray(value)) return value.map((one) => cell(one)).join(",");
  return asJsonObject(value) === undefined ? String(value) : JSON.stringify(value);
}

/** Nested objects as `a.b` keys, in the order met. */
function flatten(value: JsonObject, prefix = ""): Map<string, JsonValue> {
  const out = new Map<string, JsonValue>();
  for (const [key, one] of Object.entries(value)) {
    if (one === undefined) continue;
    const nested = asJsonObject(one);
    if (nested === undefined) {
      out.set(`${prefix}${key}`, one);
      continue;
    }
    for (const [inner, found] of flatten(nested, `${prefix}${key}.`)) out.set(inner, found);
  }
  return out;
}

function table(rows: readonly JsonObject[]): string[] {
  const flat = rows.map((row) => flatten(row));
  const columns = [...new Set(flat.flatMap((row) => [...row.keys()]))];
  if (columns.length === 0) return [`  ${String(rows.length)} item${rows.length === 1 ? "" : "s"}`];
  const cells = flat.map((row) => columns.map((column) => cell(row.get(column))));
  const widths = columns.map((column, at) => Math.max(column.length, ...cells.map((row) => (row[at] ?? "").length)));
  const draw = (row: readonly string[]): string => `  ${row.map((text, at) => text.padEnd(widths[at] ?? 0)).join("  ")}`.trimEnd();
  return [draw(columns), ...cells.map(draw)];
}

/** The answer as plain lines: see the header. `ok` and `id` are the envelope and are not printed. */
export function plainLines(answer: JsonObject): string[] {
  const { ok: _ok, id: _id, ...fields } = answer;
  const lines: string[] = [];
  for (const [key, value] of flatten(fields)) {
    if (Array.isArray(value) && value.length === 0) {
      lines.push(`${key}: (none)`);
      continue;
    }
    const objects = Array.isArray(value) ? value.map((one) => asJsonObject(one)).filter((one): one is JsonObject => one !== undefined) : [];
    if (Array.isArray(value) && objects.length === value.length) {
      lines.push(`${key}:`, ...table(objects));
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${key}: ${value.map((one) => cell(one)).join(", ")}`);
      continue;
    }
    const text = asJsonString(value) === undefined ? cell(value) : clean(asJsonString(value) ?? "");
    if (text.includes("\n")) {
      lines.push(`${key}:`, ...text.split("\n").map((line) => `  ${line}`.trimEnd()));
      continue;
    }
    lines.push(`${key}: ${text}`);
  }
  return lines;
}

// ── The verb ─────────────────────────────────────────────────────────────────────────────────────

/** Whether the socket is a socket of this user in folders only this user can write: "absent", "unsafe" or "ready". */
function probe(deps: ApiDeps, path: string): "absent" | "unsafe" | "ready" {
  const kind = deps.files.entryType(path);
  if (kind === null) return "absent";
  if (kind !== "other") return "unsafe";
  if (deps.uid !== undefined && deps.files.ownerUid(path) !== deps.uid) return "unsafe";
  // The folder of the socket, and the state dir above it, as the hold socket's check asks.
  return privateDir(deps, dirname(path)) && privateDir(deps, dirname(dirname(path))) ? "ready" : "unsafe";
}

/** `collie api`, bare or `--help`: the operations. */
export function cmdApiHelp(deps: Pick<ApiDeps, "io" | "operations">): number {
  for (const line of apiHelp(deps.operations ?? declaredOperations())) deps.io.out(line);
  return EXIT.OK;
}

function say(deps: ApiDeps, code: number, line: string): number {
  deps.io.err(line);
  return code;
}

/** `api <operation> [flags] [--json]`: one request to the local API socket, its answer printed. */
export async function cmdApi(deps: ApiDeps, argv: readonly string[]): Promise<number> {
  const operations = deps.operations ?? declaredOperations();
  const first = argv[0];
  if (first === undefined) return cmdApiHelp(deps);
  const operation = operations.find((one) => one.name === first);
  if (operation === undefined) {
    deps.io.err(`error: unknown operation \`${first}\``);
    deps.io.err(`usage: collie api {${operations.map((one) => one.name).join("|")}} [flags] [--json]`);
    return EXIT.USAGE;
  }
  const parsed = parseFlags(operation, argv.slice(1));
  if (!parsed.ok) return say(deps, EXIT.USAGE, `error: ${parsed.why}`);

  const path = apiSocketPath(deps.stateDir);
  if (deps.platform === "win32") return say(deps, EXIT.STATE, NO_LOCAL_API);
  const state = probe(deps, path);
  if (state === "absent") return say(deps, EXIT.STATE, NO_LOCAL_API);
  if (state === "unsafe") return say(deps, EXIT.STATE, `error: ${path} is not a socket private to this user; nothing was sent`);

  const waits = operation.name === "events" && (asJsonNumber(parsed.args.wait) ?? 0) > 0;
  const id = (deps.mintId ?? randomUUID)();
  let line: string | null;
  try {
    line = await deps.ask(path, `${JSON.stringify({ id, op: operation.name, args: parsed.args })}\n`, waits ? API_WAIT_ASK_MS : API_ASK_MS);
  } catch (err) {
    if (err instanceof AskLate) return say(deps, EXIT.FAIL, `error: the local API did not answer within ${String(Math.round(err.ms / 1000))} s`);
    throw err;
  }
  // A socket file with nothing behind it (a stopped bridge leaves none; a killed one may) is no local API.
  if (line === null) return say(deps, EXIT.STATE, NO_LOCAL_API);
  const answer = parseJsonObject(line);
  if (answer === undefined || asJsonBoolean(answer.ok) === undefined) return say(deps, EXIT.FAIL, "error: the local API sent an answer that is not one JSON answer line");

  const ok = answer.ok === true;
  const error = asJsonObject(answer.error);
  const code = asJsonString(error?.code);
  const exit = ok ? EXIT.OK : code === "api.failed" ? EXIT.FAIL : EXIT.REFUSED;
  if (parsed.json) {
    deps.io.out(escapeC1(line));
    return exit;
  }
  if (ok) {
    for (const text of plainLines(answer)) deps.io.out(text);
    return exit;
  }
  return say(deps, exit, `error: ${clean(asJsonString(error?.message) ?? code ?? "the local API refused the request")}`);
}
