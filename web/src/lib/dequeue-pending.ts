// A take-back whose answer has not come yet, kept per pane so the person's words are never lost (ADR 0122, the
// 2026-11-22 addendum). A `taken` take-back empties the agent's box and forgets the sends before it answers, so
// once the key left, the words live only in that answer. If it never reaches the phone, the waiting card is gone
// (the queue is empty) and nothing else holds them. So the phone keeps the request id, the way lib/send-intent.ts
// keeps a send's, and asks the bridge again by itself with the SAME id until an answer comes: a replay never
// presses (the bridge answers the stored receipt, and with `replay` it never starts a take-back for an id it does
// not know). Nothing here ever asks for a NEW take-back: only a person's tap does.
//
// - **The store** is sessionStorage with a memory map beside it, keyed like lib/drafts.ts (host, session, pane).
//   A reload or a pane switch keeps the id, and the pane view asks again when it opens (and when the page comes
//   back into view or the network comes back).
// - **Exactly once.** An answer is acted on only by the caller that claims the pending id
//   ({@link claimPendingDequeue}); a second answer for the same id (a replay racing the first) claims nothing.
// - **Where the words land.** The pane view registers its composer (`registerTaker`); with none registered (the
//   person is on another pane, or the tab was reloaded before the view came up) the words go in front of that
//   pane's stored draft, which its composer reads when it opens.

import { asJsonString, parseJsonObject } from "./json";
import { loadDraftEntry, saveDraft } from "./drafts";
import { mergedDraft } from "./dequeue-words";
import { normalizeScope, type Scope } from "./scope";
import type { DequeueReceipt } from "./surface/dequeue";

const PREFIX = "collie:dequeue-pending:";

/** The waits before each replay after an ask that got no answer: about a minute in all, then the next open or reconnect. */
export const DEQUEUE_REPLAY_GAPS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

const memory = new Map<string, string>();

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

/** The request id of the pane's take-back that has no answer yet, or null. */
export function loadPendingDequeue(scope: Scope | undefined, paneId: string): string | null {
  const key = keyFor(scope, paneId);
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    return asJsonString(parseJsonObject(storage()?.getItem(key) ?? "")?.requestId) ?? null;
  } catch {
    return null;
  }
}

/** Remember a take-back's request id before it is posted, so a lost answer can be asked for again. */
export function savePendingDequeue(scope: Scope | undefined, paneId: string, requestId: string): void {
  const key = keyFor(scope, paneId);
  memory.set(key, requestId);
  try {
    storage()?.setItem(key, JSON.stringify({ requestId }));
  } catch {
    // Quota or private mode: the memory copy still holds for this page.
  }
}

/** Forget the pending id when it is still `requestId`. True for the one caller that may act on its answer. */
export function claimPendingDequeue(scope: Scope | undefined, paneId: string, requestId: string): boolean {
  if (loadPendingDequeue(scope, paneId) !== requestId) return false;
  const key = keyFor(scope, paneId);
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    // The memory copy is gone, which is what this page reads first.
  }
  return true;
}

/** Forget the pane's pending id, whatever it is (the wipe of one pane). */
export function clearPendingDequeue(scope: Scope | undefined, paneId: string): void {
  const key = keyFor(scope, paneId);
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    // Locked-down storage kept nothing.
  }
}

/** Forget every pending id this page holds (the wipe at unpair). */
export function forgetAllPendingDequeues(): void {
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

/** What one ask ended in: a receipt, a refusal the bridge stated (nothing was pressed), or no answer at all. */
export type DequeueSettle =
  | { readonly kind: "receipt"; readonly receipt: DequeueReceipt }
  | { readonly kind: "stated"; readonly error: unknown }
  | { readonly kind: "lost" };

/** The HTTP status of a thrown ask, or undefined for no status (a network error, a timeout). */
type StatusOf = <TThrown>(error: TThrown) => number | undefined;

/** Whether a thrown ask's status means no answer: no status, or a 5xx (a member the lead could not hear is a 504). */
export function noAnswer(status: number | undefined): boolean {
  return status === undefined || status === 0 || status >= 500;
}

export interface SettleDeps {
  /** One ask: `replay` false for the person's tap, true for every ask this module makes by itself. */
  readonly post: (replay: boolean) => Promise<DequeueReceipt>;
  readonly statusOf: StatusOf;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly gaps?: readonly number[];
}

const running = new Map<string, Promise<DequeueSettle>>();
/** The gaps a call without its own uses; a test shortens them (`setDequeueReplayGapsForTests`). */
let defaultGaps: readonly number[] = DEQUEUE_REPLAY_GAPS_MS;

/** Test seam: the replay gaps every later call uses by default; `null` puts the real ones back. */
export function setDequeueReplayGapsForTests(gaps: readonly number[] | null): void {
  defaultGaps = gaps ?? DEQUEUE_REPLAY_GAPS_MS;
}

/**
 * Ask for the receipt of `requestId` until one comes, bounded by {@link DEQUEUE_REPLAY_GAPS_MS}: the first ask
 * is the tap itself (`tap`) or a replay, every later one a replay. A refusal the bridge stated ends it at once.
 * Two calls for the same id share one loop.
 */
export function settleDequeue(requestId: string, tap: boolean, deps: SettleDeps): Promise<DequeueSettle> {
  const joined = running.get(requestId);
  if (joined !== undefined) return joined;
  const work = (async (): Promise<DequeueSettle> => {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const gaps = deps.gaps ?? defaultGaps;
    for (let attempt = 0; attempt <= gaps.length; attempt++) {
      if (attempt > 0) await sleep(gaps[attempt - 1]!);
      try {
        return { kind: "receipt", receipt: await deps.post(!(tap && attempt === 0)) };
      } catch (error) {
        if (!noAnswer(deps.statusOf(error))) return { kind: "stated", error };
      }
    }
    return { kind: "lost" };
  })();
  running.set(requestId, work);
  void work.finally(() => running.delete(requestId));
  return work;
}

type Taker = (text: string) => void;
const takers = new Map<string, Taker>();

/** The pane view's composer takes a landing take-back's text while it is open. Returns the unregister. */
export function registerTaker(scope: Scope | undefined, paneId: string, take: Taker): () => void {
  const key = keyFor(scope, paneId);
  takers.set(key, take);
  return () => {
    if (takers.get(key) === take) takers.delete(key);
  };
}

/** Put a taken text where the person will find it: the open composer of its pane, else in front of that pane's stored draft. */
export function landTaken(scope: Scope | undefined, paneId: string, text: string): void {
  const take = takers.get(keyFor(scope, paneId));
  if (take !== undefined) {
    take(text);
    return;
  }
  mergeIntoStoredDraft(scope, paneId, text);
}

/** The text in front of the pane's stored draft, chips kept: what its composer shows when it opens. */
export function mergeIntoStoredDraft(scope: Scope | undefined, paneId: string, text: string): void {
  const stored = loadDraftEntry(scope, paneId);
  saveDraft(scope, paneId, mergedDraft(text, stored?.text ?? ""), stored?.attachments ?? [], stored?.next ?? 1);
}

/** Test seam: forget every pending id, loop and taker this page holds. */
export function resetDequeuePendingForTests(): void {
  memory.clear();
  running.clear();
  takers.clear();
  defaultGaps = DEQUEUE_REPLAY_GAPS_MS;
  const store = storage();
  if (store === null) return;
  for (const key of Object.keys(store)) if (key.startsWith(PREFIX)) store.removeItem(key);
}
