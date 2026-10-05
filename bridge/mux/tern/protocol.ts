// Wire formats, argument builders and error classifiers for Tern.

import { NO_BINARY_CODE, TIMED_OUT_CODE } from "./exec.ts";

/**
 * A Tern id. Tern ids are 64-bit integers, and the largest seen on 0.4.5 is 49 bits wide
 * (`519716812619778`), so `JSON.parse` keeps it whole. An id past 2^53 would be ROUNDED by
 * `JSON.parse`, and a rounded id names a different block: a key press would land in the wrong pane.
 * {@link quoteLongIds} therefore turns every long id into a string before the parse. The adapter only
 * ever uses an id through `String(id)`, so both forms read the same.
 */
export type TernId = number | string;

export interface TernBlock {
  id: TernId;
  title: string | null;
  cwd: string;
  program: string;
  args: string[];
  command?: string | null;
  cols?: number;
  rows?: number;
  exited?: number | null;
  keep_open?: boolean;
  focused: boolean;
  live: boolean;
}

export interface TernTab {
  id: TernId;
  number: number;
  name?: string | null;
  shown: boolean;
  zoomed?: boolean;
  blocks: TernBlock[];
}

export interface TernSession {
  id: TernId;
  name: string;
  shown: boolean;
  tabs: TernTab[];
}

export interface TernLsResult {
  sessions: TernSession[];
  detached?: unknown[];
}

/** One line from `tern events`. */
export interface TernEvent {
  readonly event: string;
  readonly pane?: TernId;
  readonly conn?: number;
  readonly session?: string;
  readonly block?: TernId;
  /** The sequence number of the change that caused the event. Seen on 0.4.5; not used. */
  readonly by?: number;
  readonly cwd?: string;
  readonly title?: string;
}

/**
 * Quote every `"id"`, `"pane"` and `"block"` number of 16 digits or more, so `JSON.parse` cannot
 * round it. 16 digits is where 2^53 (`9007199254740992`) lives; a shorter number is always exact.
 *
 * Safe on raw JSON: inside a JSON string a quote is written `\"`, so the unescaped `"id":` this
 * matches can only be a real key. The digit run is bounded, so the pattern is linear.
 */
export function quoteLongIds(json: string): string {
  return json.replace(/"(id|pane|block)"(\s*:\s*)(\d{16,40})(?=\s*[,}\]])/gu, '"$1"$2"$3"');
}

export function parseListing(stdout: string): TernLsResult {
  // SAFETY: parsed from JSON output and checked below for object structure and sessions array.
  const parsed = JSON.parse(quoteLongIds(stdout)) as TernLsResult;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) {
    throw new Error("unexpected response from tern ls --json: missing sessions array");
  }
  return parsed;
}

export function parseEvent(line: string): TernEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    // SAFETY: parsed event object validated for object and event string property below.
    const obj = JSON.parse(quoteLongIds(trimmed)) as TernEvent;
    if (obj && typeof obj === "object" && typeof obj.event === "string") {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

export function saysNoBlock(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("no block is called") ||
    s.includes("no block found") ||
    s.includes("unknown block") ||
    s.includes("no block")
  );
}

export function saysNoSession(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("no session is called") ||
    s.includes("there is no session") ||
    s.includes("session not found") ||
    s.includes("unknown session")
  );
}

export function saysNoDaemon(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("the session daemon did not answer") ||
    s.includes("no daemon running") ||
    s.includes("cannot spawn daemon process") ||
    s.includes("connection refused") ||
    s.includes("broken pipe")
  );
}

/**
 * Whether a finished call says tern could not be asked at all: no binary, a daemon that did not
 * answer, or a call killed on its budget. These are `unreachable` to the contract, and the banner
 * knows that word; an ordinary non-zero exit is the daemon answering "no".
 */
export function saysUnreachable(code: number, stderr: string): boolean {
  return code === NO_BINARY_CODE || code === TIMED_OUT_CODE || saysNoDaemon(stderr);
}
