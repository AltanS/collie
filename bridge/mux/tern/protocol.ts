// Wire formats, argument builders and error classifiers for Tern.

import { NO_BINARY_CODE, TIMED_OUT_CODE } from "./exec.ts";

export interface TernBlock {
  id: number;
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
  id: number;
  number: number;
  name?: string | null;
  shown: boolean;
  zoomed?: boolean;
  blocks: TernBlock[];
}

export interface TernSession {
  id: number;
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
  readonly pane?: number;
  readonly conn?: number;
  readonly session?: string;
  readonly block?: number;
}

export function parseListing(stdout: string): TernLsResult {
  // SAFETY: parsed from JSON output and checked below for object structure and sessions array.
  const parsed = JSON.parse(stdout) as TernLsResult;
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
    const obj = JSON.parse(trimmed) as TernEvent;
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
