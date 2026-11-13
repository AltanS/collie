// The request id of a send that got no answer, kept per pane so a lost answer never sends twice.
//
// The Send Protocol answers a known request id from the receipt it already wrote (ADR 0101 point 4),
// so a tap on the same text after a send that got no answer must carry the SAME id. The composer held
// that id in a React ref, which a pane switch, a reload or a killed tab drops, while the draft itself
// survives (lib/drafts.ts): the next tap minted a new id and the bridge could type the text twice,
// under a notice that says "Tap Send again: it does not send twice".
//
// This is the small store that keeps the id across those. It holds the intent (`IntentId`: the key
// that names the text, the mode and the rest of the intent, plus the id) per (host, session, pane),
// the key style of lib/drafts.ts. `requestIdFor` reuses the id only while the key is the same, so a
// text that changed since gets a new id whatever this store holds.
//
// **sessionStorage**, behind the same guard style as lib/drafts.ts (a typeof check and a try/catch:
// Safari private mode throws on setItem), with a memory map beside it for a page whose storage is
// blocked. A lost id costs only the old behaviour (a new id), never a failed send.

import type { IntentId } from "./durable-control";
import { asJsonString, parseJsonObject } from "./json";
import { normalizeScope, type Scope } from "./scope";

const PREFIX = "collie:send-intent:";

interface Stored {
  readonly key: string;
  readonly requestId: string;
  /** The text of the draft that went, or null when the send was not the draft (a tap on an offer or a held row). */
  readonly draft: string | null;
}

const memory = new Map<string, Stored>();

function keyFor(scope: Scope | undefined, paneId: string): string {
  const { host, session } = normalizeScope(scope);
  return `${PREFIX}${host ? `${host}@` : ""}${session ?? "default"}:${paneId}`;
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
  const key = asJsonString(value?.key);
  const requestId = asJsonString(value?.requestId);
  if (key === undefined || requestId === undefined) return null;
  return { key, requestId, draft: asJsonString(value?.draft) ?? null };
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

/** The intent a pane's last send left without an answer, or null. */
export function loadIntent(scope: Scope | undefined, paneId: string): IntentId | null {
  const stored = read(scope, paneId);
  return stored === null ? null : { key: stored.key, requestId: stored.requestId };
}

/** Remember the intent of a send that got no answer. `draft` is the draft's text when the send carried it. */
export function saveIntent(scope: Scope | undefined, paneId: string, intent: IntentId, draft: string | null): void {
  const key = keyFor(scope, paneId);
  const stored: Stored = { key: intent.key, requestId: intent.requestId, draft };
  memory.set(key, stored);
  try {
    storage()?.setItem(key, JSON.stringify(stored));
  } catch {
    // Quota or private mode: the memory copy still holds for this page.
  }
}

/** Forget a pane's intent: any answer from the bridge ends it. */
export function clearIntent(scope: Scope | undefined, paneId: string): void {
  const key = keyFor(scope, paneId);
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to remove from a store that cannot be reached.
  }
}

/** The draft changed: forget the intent when it was the draft's and the draft is no longer that text. */
export function clearIntentIfDraftChanged(scope: Scope | undefined, paneId: string, draft: string): void {
  const stored = read(scope, paneId);
  if (stored === null || stored.draft === null || stored.draft === draft) return;
  clearIntent(scope, paneId);
}

/** Drop every intent, memory and storage. The wipe at the end of a pairing runs it: the keys hold the text of a draft. */
export function forgetAllSendIntents(): void {
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
export function __forgetSendIntentMemory(): void {
  memory.clear();
}
