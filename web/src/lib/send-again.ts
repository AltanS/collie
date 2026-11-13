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
// The store holds a fingerprint of the line, never the line: a password typed at a prompt that never
// echoes ends `unknown` too, and its text must not sit in sessionStorage. The key style is
// lib/send-intent.ts's, per (host, session, pane), sessionStorage behind the same guard and a memory map
// beside it. A lost entry costs only the old behaviour (a send at once), never a failed send.

import { asJsonNumber, asJsonString, parseJsonObject } from "./json";
import { normalizeScope, type Scope } from "./scope";

/** How long after an unknown send a second tap on the same text asks first: two minutes. */
export const SEND_AGAIN_WINDOW_MS = 120_000;

const PREFIX = "collie:send-again:";

interface Stored {
  /** What the line hashes to, so the question is about this text and no other. */
  readonly print: string;
  /** When the unknown answer came in, milliseconds since the epoch. */
  readonly at: number;
}

const memory = new Map<string, Stored>();

function keyFor(scope: Scope | undefined, paneId: string): string {
  const { host, session } = normalizeScope(scope);
  return `${PREFIX}${host ? `${host}@` : ""}${session ?? "default"}:${paneId}`;
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

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // SSR / blocked storage
  }
}

function parse(raw: string | null): Stored | null {
  if (raw === null) return null;
  const value = parseJsonObject(raw);
  const print = asJsonString(value?.print);
  const at = asJsonNumber(value?.at);
  if (print === undefined || at === undefined) return null;
  return { print, at };
}

function read(scope: Scope | undefined, paneId: string): Stored | null {
  const key = keyFor(scope, paneId);
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    return parse(storage()?.getItem(key) ?? null);
  } catch {
    return null;
  }
}

/** A send of `line` on this pane ended `unknown` at `now`. */
export function rememberUnknownSend(scope: Scope | undefined, paneId: string, line: string, now: number = Date.now()): void {
  const key = keyFor(scope, paneId);
  const stored: Stored = { print: fingerprint(line), at: now };
  memory.set(key, stored);
  try {
    storage()?.setItem(key, JSON.stringify(stored));
  } catch {
    // Quota or private mode: the memory copy still holds for this page.
  }
}

/** Whether a tap on Send with `line` should ask "Send it again?" first: the same text, the same pane, inside the window. */
export function asksSendAgain(scope: Scope | undefined, paneId: string, line: string, now: number = Date.now()): boolean {
  const stored = read(scope, paneId);
  if (stored === null) return false;
  const age = now - stored.at;
  if (age < 0 || age > SEND_AGAIN_WINDOW_MS) return false;
  return stored.print === fingerprint(line);
}

/**
 * Forget a pane's unknown send: a known answer, the confirming tap, or the journal settling it ends the question.
 * With `line`, only an entry for that very text goes: a known answer for other words leaves it standing.
 */
export function forgetUnknownSend(scope: Scope | undefined, paneId: string, line?: string): void {
  const key = keyFor(scope, paneId);
  if (line !== undefined && read(scope, paneId)?.print !== fingerprint(line)) return;
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to remove from a store that cannot be reached.
  }
}

/** Drop every entry, memory and storage: the wipe at the end of a pairing. */
export function forgetAllUnknownSends(): void {
  memory.clear();
  try {
    const store = storage();
    if (store === null) return;
    const held: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(PREFIX)) held.push(key);
    }
    for (const key of held) store.removeItem(key);
  } catch {
    // Locked-down storage kept nothing.
  }
}

/** Test seam: forget the memory copies, as a reload does, and leave sessionStorage as it is. */
export function __forgetSendAgainMemory(): void {
  memory.clear();
}
