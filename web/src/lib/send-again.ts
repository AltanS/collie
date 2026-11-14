// "Send it again?": the memory of a send that ended `unknown`, kept per pane for a short window.
//
// After a send whose result is unknown (the bridge typed the text and could not see it land), the draft
// stays in the box, and the next tap on Send used to send the same text again under a new request id.
// When the first one had gone, that is a message the agent gets twice. The window below is the time in
// which a second tap on the SAME text on the SAME pane asks once instead ("Send it again?"); the
// confirming tap sends. A different text, another pane or a later tap sends at once, as before.
//
// Only an answer in the `unknown` family arms it (lib/send-protocol.ts `note: "unknown"`). A send known
// to have gone or known not to have gone clears the memory and never asks. After the confirming tap the
// memory for that text is cleared, so a send that ends unknown again arms it afresh.
//
// The memory holds a fingerprint of the line, never the line (a 32-bit hash and the length), and it lives in
// memory ONLY: nothing is written to sessionStorage or anywhere else, because a short secret can be tested
// against a 32-bit hash and the phone cannot always know that a text was one. A reload forgets it, and the
// question is then not asked, which is accepted: the old behaviour (a send at once) costs at most one repeat,
// never a failed send. The key style is lib/send-intent.ts's, per (host, session, pane).
//
// Both ends read the text the same way: `sentForm` is what the composer's `send` types (trimmed at both ends
// on an agent pane, at the end only on a shell), and `rememberUnknownSend` and `asksSendAgain` both apply it,
// so a difference in trailing whitespace cannot disarm the question.

import { normalizeScope, type Scope } from "./scope";

/** How long after an unknown send a second tap on the same text asks first: two minutes. */
export const SEND_AGAIN_WINDOW_MS = 120_000;

/**
 * How long after "Send it again?" is armed before a tap on it counts: 700 ms. A person who double-taps Send by
 * habit arms the question with the first tap and would confirm it with the second without having read it (an
 * impatient second tap comes 500 to 800 ms after the first, measured by a reviewer). The word is dimmed for this
 * time, so the wait is visible. A
 * tap before this does nothing: the word stays armed, its 3 seconds keep running from the arm, nothing is sent.
 * Only this question waits; "Really send?" and the other two-tap confirms take an immediate second tap.
 */
export const SEND_AGAIN_CONFIRM_DELAY_MS = 700;

interface Stored {
  /** What the line hashes to, so the question is about this text and no other. */
  readonly print: string;
  /** When the unknown answer came in, milliseconds since the epoch. */
  readonly at: number;
}

const memory = new Map<string, Stored>();

/** The line as the composer's `send` types it: trimmed at both ends, at the end only on a shell (its leading space is kept). */
export function sentForm(line: string, isShell: boolean): string {
  return isShell ? line.trimEnd() : line.trim();
}

function keyFor(scope: Scope | undefined, paneId: string): string {
  const { host, session } = normalizeScope(scope);
  return `${host ? `${host}@` : ""}${session ?? "default"}:${paneId}`;
}

/** FNV-1a over the UTF-16 units, with the length: a fingerprint to compare, not a secret. */
function fingerprint(line: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    hash ^= line.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${line.length}:${hash.toString(16)}`;
}

/**
 * The id the composer's two-tap confirm arms for this line, apart from the id a destructive line arms
 * (the line itself): the two questions never confirm each other.
 */
export function sendAgainId(line: string): string {
  return `send-again\u0000${line}`;
}

function read(scope: Scope | undefined, paneId: string): Stored | null {
  return memory.get(keyFor(scope, paneId)) ?? null;
}

/** A send of `line` on this pane ended `unknown` at `now`. */
export function rememberUnknownSend(scope: Scope | undefined, paneId: string, line: string, now: number = Date.now(), isShell = false): void {
  memory.set(keyFor(scope, paneId), { print: fingerprint(sentForm(line, isShell)), at: now });
}

/** Whether a tap on Send with `line` should ask "Send it again?" first: the same text, the same pane, inside the window. */
export function asksSendAgain(scope: Scope | undefined, paneId: string, line: string, now: number = Date.now(), isShell = false): boolean {
  const stored = read(scope, paneId);
  if (stored === null) return false;
  const age = now - stored.at;
  if (age < 0 || age > SEND_AGAIN_WINDOW_MS) return false;
  return stored.print === fingerprint(sentForm(line, isShell));
}

/**
 * Forget a pane's unknown send: a known answer, the confirming tap, or the journal settling it ends the question.
 * With `line`, only an entry for that very text goes: a known answer for other words leaves it standing.
 */
export function forgetUnknownSend(scope: Scope | undefined, paneId: string, line?: string, isShell = false): void {
  if (line !== undefined && read(scope, paneId)?.print !== fingerprint(sentForm(line, isShell))) return;
  memory.delete(keyFor(scope, paneId));
}

/** Drop every entry: the wipe at the end of a pairing. */
export function forgetAllUnknownSends(): void {
  memory.clear();
}

/** Test seam: forget the memory, as a reload does. */
export function __forgetSendAgainMemory(): void {
  memory.clear();
}

// LEGACY CLEANUP. An earlier build of this feature kept a fingerprint in sessionStorage under this prefix.
// Nothing writes there any more; this removes what such a build left in an open tab. It runs once when the module
// loads (as lib/last-seen.ts does for its own old keys) and can go away in a later release, when no tab can still
// hold one (sessionStorage dies with the tab).
const LEGACY_PREFIX = "collie:send-again:";

export function dropLegacySendAgain(): void {
  try {
    const store = globalThis.sessionStorage;
    if (store === undefined) return;
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(LEGACY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Blocked storage: nothing could have been written there either.
  }
}

dropLegacySendAgain();
