// THE INSIDE WIRE, version 1 (M99 spec 01). The contract is `WIRE.md` beside this file; this module
// is its parser and its limits, and nothing else. Pure: no socket, no clock, no file.
//
// Everything a part sends is untrusted text from another process. Each parser here is TOTAL: it
// answers a value or a refusal with a reason, and never throws. Unknown fields are ignored, so a
// newer part can add a field without breaking an older bridge. A field with the wrong type or past
// its limit refuses the whole message: half a message is never acted on.
//
// No harness name and no multiplexer name lives here. A part names its harness as an open string, and
// its pane markers come as raw environment values the bridge runs through the one marker table
// (`bridge/beacon/env-markers.ts`).

import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../../web/src/lib/json.ts";
import { MARKER_ENV_NAMES } from "../beacon/env-markers.ts";

/** The wire version this build speaks. A hello with another version is refused with this one named. */
export const WIRE_VERSION = 1;

/** The three routes, all under `/v1/`. */
export const WIRE_ROUTES = { hello: "/v1/hello", event: "/v1/event", next: "/v1/next" } as const;

/** The largest request body the socket reads, any route. Bun refuses a longer one with 413 first. */
export const BODY_MAX = 64 * 1024;
/** The largest `hello` body. */
export const HELLO_MAX = 16 * 1024;
/** The longest text a command carries to a part (a prompt, a mail), in UTF-16 units. */
export const COMMAND_TEXT_MAX = 48 * 1024;
/** The longest draft a part reports, in UTF-16 units. A longer one is refused, never cut. */
export const DRAFT_TEXT_MAX = 32 * 1024;
/** The largest ask input a part reports, as JSON text. */
export const ASK_INPUT_MAX = 16 * 1024;
/** How long one `next` waits for a command before it answers 204. Bun idles a request at 10 s by default. */
export const NEXT_WAIT_MS = 25_000;
/** The shortest and longest wait a part may ask for in `next` (`?wait=`). */
export const NEXT_WAIT_MIN_MS = 1000;

/** What a part may declare it can do. Anything else in the list is dropped (fail closed). */
/**
 * `draft.state`: the part tells whether the input box holds a draft, as a boolean, each time that flips
 * and again after each hello (M99 spec 05, decision of 2026-11-13). Never the draft's text.
 */
export const CAPABILITIES = ["send", "steer", "mail", "draft", "draft.state", "wake"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The ask kinds a part may declare it answers. */
export const ASK_KINDS = ["permission", "question"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** What a part reports. */
export const EVENT_KINDS = ["turn.start", "turn.end", "row", "ask.open", "ask.close", "taken", "sent", "failed", "draft", "draft.state", "bye"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** What the bridge hands a part. */
export const COMMAND_KINDS = ["prompt", "mail", "answer", "steer", "draft"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** The decisions an `answer` carries. */
export const DECISIONS = ["allow", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

/** A part id: minted by the bridge at `hello`, 22 url-safe characters (128 bits). */
export const PART_ID = /^[A-Za-z0-9_-]{16,64}$/u;
/** A command id: the phone's request id shape (`web/src/lib/surface/send.ts` REQUEST_ID). */
export const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/u;
/** An ask id, a turn id or a row id a part mints: short, no spaces, no path characters. */
export const SHORT_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
/** A harness name, a door, a reason: a lower-case word. */
const WORD = /^[a-z][a-z0-9._-]{0,47}$/u;
/** A version string. */
const VERSION_MAX = 64;
/** A harness session id. */
const SESSION_MAX = 128;
/** A cwd. */
const CWD_MAX = 4096;
/** One marker environment value. */
const ENV_VALUE_MAX = 1024;

/** A refusal: why the message is not one. */
export interface WireRefusal {
  readonly ok: false;
  readonly error: string;
}

const refuse = (error: string): WireRefusal => ({ ok: false, error });

/** The raw marker variables a part sends, by name: only names in {@link MARKER_ENV_NAMES}. */
export type PartEnv = Readonly<Record<string, string>>;

/** A part's `hello`, parsed. */
export interface Hello {
  readonly ok: true;
  readonly wire: number;
  /** The harness as the part names itself: an open word, never matched by shared code. */
  readonly harness: string;
  readonly harnessVersion: string | null;
  readonly partVersion: string | null;
  /** The harness's own session id, when the part knows it. */
  readonly session: string | null;
  readonly cwd: string | null;
  readonly pid: number;
  /** The pid's start time in the platform's probe unit (`bridge/beacon/liveness.ts`), or null. */
  readonly pidStartTime: number | null;
  /** The raw marker variables, only the names in {@link MARKER_ENV_NAMES}. */
  readonly env: PartEnv;
  readonly capabilities: readonly Capability[];
  readonly asks: readonly AskKind[];
}

/**
 * The part's own count of its state words (`turn.start`, `turn.end`, `draft.state`), rising by one with
 * each new word and kept by a word it says again (M100 spec 05). The hub drops a word older than the last
 * one of its kind it took, so a late or re-sent word never undoes a newer one. Null from a part that
 * sends none (an older part): its words are taken in the order they arrive, as before.
 */
export type WordSeq = number | null;

/** One event, parsed. Every event names the part that sends it. */
export type WireEvent =
  | { readonly ok: true; readonly part: string; readonly kind: "turn.start"; readonly turn: string | null; readonly seq: WordSeq }
  | { readonly ok: true; readonly part: string; readonly kind: "turn.end"; readonly turn: string | null; readonly reason: string | null; readonly seq: WordSeq }
  | { readonly ok: true; readonly part: string; readonly kind: "row"; readonly door: string; readonly row: string | null }
  | {
      readonly ok: true;
      readonly part: string;
      readonly kind: "ask.open";
      readonly ask: string;
      readonly askKind: AskKind;
      readonly tool: string | null;
      readonly input: JsonValue | null;
    }
  | { readonly ok: true; readonly part: string; readonly kind: "ask.close"; readonly ask: string; readonly how: string | null }
  | { readonly ok: true; readonly part: string; readonly kind: "taken" | "sent"; readonly cmd: string }
  /**
   * `detail`: the part's own words on why, one line of at most {@link FAIL_DETAIL_MAX} characters (an
   * error's class and message), never the command's text; a later field, so an older part sends none.
   */
  | { readonly ok: true; readonly part: string; readonly kind: "failed"; readonly cmd: string; readonly reason: string | null; readonly detail: string | null }
  | { readonly ok: true; readonly part: string; readonly kind: "draft"; readonly cmd: string; readonly text: string; readonly caret: number | null }
  /** Whether the box holds a draft now. Only the boolean: a `text` field, if a part sent one, is not read. */
  | { readonly ok: true; readonly part: string; readonly kind: "draft.state"; readonly present: boolean; readonly seq: WordSeq }
  | { readonly ok: true; readonly part: string; readonly kind: "bye" };

/** A command the bridge hands a part. `text` for prompt, mail and steer; `ask` and `decision` for an answer. */
export type WireCommand =
  | { readonly id: string; readonly kind: "prompt" | "steer"; readonly text: string }
  /**
   * `overDraft`: the person chose Deliver now (M99 spec 05), so the part submits the mail without reading
   * the box; their draft stays where it is. Absent on every other mail, which a draft sends back.
   */
  | { readonly id: string; readonly kind: "mail"; readonly text: string; readonly overDraft?: true }
  | { readonly id: string; readonly kind: "answer"; readonly ask: string; readonly decision: Decision }
  | { readonly id: string; readonly kind: "draft" };

/** What `next` asks for, parsed off the query string. */
export interface NextQuery {
  readonly ok: true;
  readonly part: string;
  /** Only the answer to this ask, for a part's permission hook that waits on one ask. */
  readonly ask: string | null;
  /** How long to wait, clamped to {@link NEXT_WAIT_MIN_MS} .. {@link NEXT_WAIT_MS}. */
  readonly waitMs: number;
}

/**
 * A refusal raised inside a parser. It never leaves this module: each exported parser catches it and
 * answers a {@link WireRefusal}, so the parsers stay total.
 */
class Refused extends Error {}

/** The body as one JSON object. */
function objectOf(text: string, max: number): JsonObject {
  if (text.length > max) throw new Refused("too large");
  const row = asJsonObject(parseJson(text));
  if (row === undefined) throw new Refused("not a JSON object");
  return row;
}

/** An optional string field: absent or null is null; present it must be a string of 1..max matching `pattern`. */
function optionalString(row: JsonObject, key: string, max: number, pattern?: RegExp): string | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  const text = asJsonString(value);
  if (text === undefined || text.length === 0 || text.length > max) throw new Refused(`bad ${key}`);
  if (pattern !== undefined && !pattern.test(text)) throw new Refused(`bad ${key}`);
  return text;
}

/** A required string field matching `pattern`. */
function requiredString(row: JsonObject, key: string, pattern: RegExp): string {
  const text = asJsonString(row[key]);
  if (text === undefined || !pattern.test(text)) throw new Refused(`bad ${key}`);
  return text;
}

/** The known words of a list, in the order given, each once. A list that is not a list of strings is refused. */
function wordsOf<T extends string>(value: JsonValue | undefined, known: readonly T[]): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Refused("bad list");
  const out: T[] = [];
  for (const item of value) {
    const word = asJsonString(item);
    if (word === undefined) throw new Refused("bad list");
    const hit = known.find((candidate) => candidate === word);
    if (hit !== undefined && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** The marker variables of a hello: only the names the marker table reads, each a short string. */
function envOf(value: JsonValue | undefined): PartEnv {
  if (value === undefined || value === null) return {};
  const row = asJsonObject(value);
  if (row === undefined) throw new Refused("bad env");
  const entries: [string, string][] = [];
  for (const name of MARKER_ENV_NAMES) {
    const raw = row[name];
    if (raw === undefined || raw === null) continue;
    const text = asJsonString(raw);
    if (text === undefined || text.length > ENV_VALUE_MAX) throw new Refused("bad env");
    if (text !== "") entries.push([name, text]);
  }
  return Object.fromEntries(entries);
}

/** A positive whole pid. */
function pidOf(value: JsonValue | undefined): number {
  const pid = asJsonNumber(value);
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Refused("bad pid");
  return pid;
}

/** Run a parser; a refusal raised inside it becomes the answer. Any other error is a bug and is thrown. */
function total<T>(parse: () => T): T | WireRefusal {
  try {
    return parse();
  } catch (err) {
    if (err instanceof Refused) return refuse(err.message);
    throw err;
  }
}

/** Parse a `hello` body. */
export function parseHello(text: string): Hello | WireRefusal {
  return total((): Hello => {
    const row = objectOf(text, HELLO_MAX);
    const wire = asJsonNumber(row.wire);
    if (wire === undefined || !Number.isInteger(wire)) throw new Refused("bad wire");
    if (wire !== WIRE_VERSION) throw new Refused(`wire ${String(wire)} is not spoken here; this bridge speaks ${String(WIRE_VERSION)}`);
    const cwd = optionalString(row, "cwd", CWD_MAX);
    if (cwd !== null && !cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(cwd)) throw new Refused("bad cwd");
    let pidStartTime: number | null = null;
    if (row.pidStartTime !== undefined && row.pidStartTime !== null) {
      const start = asJsonNumber(row.pidStartTime);
      if (start === undefined || !Number.isFinite(start) || start < 0) throw new Refused("bad pidStartTime");
      pidStartTime = start;
    }
    return {
      ok: true,
      wire,
      harness: requiredString(row, "harness", WORD),
      harnessVersion: optionalString(row, "harnessVersion", VERSION_MAX),
      partVersion: optionalString(row, "partVersion", VERSION_MAX),
      session: optionalString(row, "session", SESSION_MAX),
      cwd,
      pid: pidOf(row.pid),
      pidStartTime,
      env: envOf(row.env),
      capabilities: wordsOf(row.capabilities, CAPABILITIES),
      asks: wordsOf(row.asks, ASK_KINDS),
    };
  });
}

/** The longest `detail` of a `failed` the bridge keeps. */
export const FAIL_DETAIL_MAX = 160;

/**
 * The optional `detail` of a `failed`, read leniently: the word it rides on must never be lost to it. A
 * string becomes one line, control characters and runs of space made one space, cut at {@link FAIL_DETAIL_MAX}; anything
 * else, or nothing left, is null.
 */
function detailOf(value: JsonValue | undefined): string | null {
  const text = asJsonString(value);
  if (text === undefined) return null;
  // `\p{Cc}`: the control characters (C0, DEL, C1); `\s` takes the line and paragraph separators.
  const line = text.slice(0, FAIL_DETAIL_MAX * 4).replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  return line === "" ? null : line.slice(0, FAIL_DETAIL_MAX);
}

/** The optional `seq` of a state word: absent or null is null; present it must be a whole number from 0. */
function seqOf(row: JsonObject): WordSeq {
  const value = row.seq;
  if (value === undefined || value === null) return null;
  const seq = asJsonNumber(value);
  if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0) throw new Refused("bad seq");
  return seq;
}

/** One event body's fields past `part` and `kind`. */
function eventOf(row: JsonObject, part: string, kind: EventKind): WireEvent {
  switch (kind) {
    case "turn.start":
      return { ok: true, part, kind, turn: optionalString(row, "turn", 128, SHORT_ID), seq: seqOf(row) };
    case "turn.end":
      return { ok: true, part, kind, turn: optionalString(row, "turn", 128, SHORT_ID), reason: optionalString(row, "reason", 48, WORD), seq: seqOf(row) };
    case "row":
      return { ok: true, part, kind, door: requiredString(row, "door", WORD), row: optionalString(row, "row", 128, SHORT_ID) };
    case "ask.open": {
      const ask = requiredString(row, "ask", SHORT_ID);
      const askKind = ASK_KINDS.find((candidate) => candidate === asJsonString(row.askKind));
      if (askKind === undefined) throw new Refused("bad askKind");
      const tool = optionalString(row, "tool", 128);
      const input = row.input ?? null;
      if (input !== null && JSON.stringify(input).length > ASK_INPUT_MAX) throw new Refused("bad input");
      return { ok: true, part, kind, ask, askKind, tool, input };
    }
    case "ask.close":
      return { ok: true, part, kind, ask: requiredString(row, "ask", SHORT_ID), how: optionalString(row, "how", 48, WORD) };
    case "taken":
    case "sent":
      return { ok: true, part, kind, cmd: requiredString(row, "cmd", COMMAND_ID) };
    case "failed":
      return { ok: true, part, kind, cmd: requiredString(row, "cmd", COMMAND_ID), reason: optionalString(row, "reason", 48, WORD), detail: detailOf(row.detail) };
    case "draft": {
      const cmd = requiredString(row, "cmd", COMMAND_ID);
      const draft = row.text === undefined || row.text === null ? "" : asJsonString(row.text);
      if (draft === undefined || draft.length > DRAFT_TEXT_MAX) throw new Refused("bad text");
      const caret = row.caret === undefined || row.caret === null ? null : asJsonNumber(row.caret);
      if (caret === undefined || (caret !== null && (!Number.isInteger(caret) || caret < 0 || caret > draft.length))) throw new Refused("bad caret");
      return { ok: true, part, kind, cmd, text: draft, caret };
    }
    case "draft.state": {
      const present = asJsonBoolean(row.present);
      if (present === undefined) throw new Refused("bad present");
      return { ok: true, part, kind, present, seq: seqOf(row) };
    }
    case "bye":
      return { ok: true, part, kind };
  }
}

/** Parse an `event` body. */
export function parseEvent(text: string): WireEvent | WireRefusal {
  return total((): WireEvent => {
    const row = objectOf(text, BODY_MAX);
    const part = requiredString(row, "part", PART_ID);
    const kind = EVENT_KINDS.find((candidate) => candidate === asJsonString(row.kind));
    if (kind === undefined) throw new Refused("bad kind");
    return eventOf(row, part, kind);
  });
}

/** Parse a command body as a part receives it from `next`. The parts' own copies of this rule mirror it. */
export function parseCommand(text: string): WireCommand | WireRefusal {
  return total((): WireCommand => {
    const row = objectOf(text, COMMAND_TEXT_MAX + 1024);
    if (asJsonNumber(row.wire) !== WIRE_VERSION) throw new Refused("bad wire");
    const id = requiredString(row, "id", COMMAND_ID);
    const kind = COMMAND_KINDS.find((candidate) => candidate === asJsonString(row.kind));
    if (kind === undefined) throw new Refused("bad kind");
    let command: WireCommand;
    if (kind === "answer") {
      const decision = DECISIONS.find((candidate) => candidate === asJsonString(row.decision));
      if (decision === undefined) throw new Refused("bad decision");
      command = { id, kind, ask: requiredString(row, "ask", SHORT_ID), decision };
    } else if (kind === "draft") {
      command = { id, kind };
    } else {
      const commandText = asJsonString(row.text);
      if (commandText === undefined) throw new Refused("bad text");
      // Only a literal `true` on a mail is Deliver now (spec 05); anywhere else the field is not read.
      command = kind === "mail" && row.overDraft === true ? { id, kind, text: commandText, overDraft: true } : { id, kind, text: commandText };
    }
    const fault = checkCommand(command);
    if (fault !== null) throw new Refused(fault);
    return command;
  });
}

/** Parse a `next` URL's query. */
export function parseNextQuery(url: URL): NextQuery | WireRefusal {
  const part = url.searchParams.get("part") ?? "";
  if (!PART_ID.test(part)) return refuse("bad part");
  const askRaw = url.searchParams.get("ask");
  if (askRaw !== null && !SHORT_ID.test(askRaw)) return refuse("bad ask");
  const waitRaw = url.searchParams.get("wait");
  let waitMs = NEXT_WAIT_MS;
  if (waitRaw !== null) {
    if (!/^\d{1,6}$/u.test(waitRaw)) return refuse("bad wait");
    waitMs = Math.min(NEXT_WAIT_MS, Math.max(NEXT_WAIT_MIN_MS, Number(waitRaw)));
  }
  return { ok: true, part, ask: askRaw, waitMs };
}

/** Whether a command is well formed before it is queued: ids, kinds, decisions and the text limit. */
export function checkCommand(command: WireCommand): string | null {
  if (!COMMAND_ID.test(command.id)) return "bad id";
  switch (command.kind) {
    case "prompt":
    case "mail":
    case "steer":
      if (command.text.length === 0) return "empty text";
      return command.text.length > COMMAND_TEXT_MAX ? "text too long" : null;
    case "answer":
      if (!SHORT_ID.test(command.ask)) return "bad ask";
      return DECISIONS.includes(command.decision) ? null : "bad decision";
    case "draft":
      return null;
  }
}

/** The capability a command needs on the part, or the ask kind for an answer. */
export function needOf(command: WireCommand): { readonly capability: Capability } | { readonly ask: true } {
  switch (command.kind) {
    case "prompt":
      return { capability: "send" };
    case "mail":
      return { capability: "mail" };
    case "steer":
      return { capability: "steer" };
    case "draft":
      return { capability: "draft" };
    case "answer":
      return { ask: true };
  }
}

/** A command as the wire carries it to the part. */
export function commandBody(command: WireCommand): string {
  return JSON.stringify({ wire: WIRE_VERSION, ...command });
}
