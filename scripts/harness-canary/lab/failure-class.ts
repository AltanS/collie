// Which lab failures the environment caused (the drift loop, 2026-11-19). A run that cannot finish ends
// `failed`: no verdict on the readers. Most of those are no fault of Collie or of the harness: the
// registry has not published the version yet, a login ran out, the machine was busy. Such a pair must
// not be final, or one bad hour hides a version for good (four rows of 2026-10-23 did exactly that).
//
// This file is pure: a note goes in, a class comes out. The ledger (lab-ledger.ts) holds the retry count.
// A real drift failure never comes through here: the verdict `fail` is final and writes the issue draft.

/** The classes, in the order they are tried. */
export const FAILURE_CLASSES = ["notarget", "credits", "login", "load", "timeout", "interrupted"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const PATTERNS: readonly (readonly [FailureClass, RegExp])[] = [
  // The registry does not list the version yet, or `min-release-age` hides it.
  ["notarget", /\bnotarget\b|\bETARGET\b|No matching version found/iu],
  // OpenRouter's 402, also with credit left on the account (the key limit is below the call's reservation).
  ["credits", /\b402 (?:Payment|requires)|(?:HTTP|status) 402\b|requires more credits/iu],
  // Claude: no login, a token with too few minutes left, or one that expired.
  ["login", /minutes left|no Claude login|OAuth token has expired|authentication_error|please run \/login|not logged in|invalid (?:x-)?api[- ]key|(?:HTTP|status) 401\b|\b401 Unauthorized/iu],
  ["load", /load average|machine is (?:too )?busy/iu],
  // A network that dropped, an install or a run that took too long. An npm install killed by its own timer exits 143 or 137.
  ["timeout", /timed? ?out|timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|exited (?:143|137|-1)\b/iu],
  // The process died or was stopped: the OOM killer, systemd's stop, a signal. An uncaught error is a lab bug, not the environment, so it stays final.
  ["interrupted", /^interrupted(?: by SIG|: the run's process)/iu],
];

/** The class of a failure note, or null when the note names no environment cause. */
export function classifyFailure(note: string): FailureClass | null {
  for (const [name, pattern] of PATTERNS) if (pattern.test(note)) return name;
  return null;
}

/** Tries before a retryable class turns final. */
export const RETRY_MAX_TRIES = 5;
/** Days (in ms) after the first try before a retryable class turns final. */
export const RETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The wait grows by this much per try, so a one-hour timer never retries in the same hour: 50 min, 100 min, ... */
export const RETRY_GAP_MS = 50 * 60 * 1000;

/** The retry facts a row carries. */
export interface RetryFacts {
  readonly tries: number;
  readonly firstTry: number;
  readonly lastTry: number;
}

/** True when the pair has used its tries or its week. */
export function retryExhausted(facts: RetryFacts, now: number): boolean {
  return facts.tries >= RETRY_MAX_TRIES || now - facts.firstTry > RETRY_MAX_AGE_MS;
}

/** True when enough time has passed since the last try. */
export function retryDue(facts: RetryFacts, now: number): boolean {
  return now - facts.lastTry >= RETRY_GAP_MS * Math.max(1, facts.tries);
}
