// The Chat view's data: one merged window per pane (ADR 0073), polled on the shared beat while the
// Chat tab is open. Port of web/src/hooks/use-chat-window.ts without React: the fetch is web's
// `fetchChat` (its live-page ETag, its 404-means-stale rule) and the merge is web's pure `mergeChat`.
// Both are read-only reuse; this module only keeps the window in a store and pages older turns.
import { fetchChat } from "@web/lib/api";
import { describeThrownError } from "@web/lib/api-error-message";
import { EMPTY_CHAT_WINDOW, mergeChat, type ChatWindow } from "@web/lib/chat-window";
import type { Scope } from "@web/lib/scope";

import { createStore, type Store } from "../../lib/store";
import { statusOf } from "./data";

/** A turn page, as web's "load older" asks for one. */
const OLDER_PAGE = 40;

export interface ChatState {
  window: ChatWindow;
  /** A `?before=` page is in flight. */
  loadingOlder: boolean;
  /** The last live poll failed with this message (the window is kept). */
  error: string | undefined;
  /** …and this HTTP status, when the bridge answered one. */
  status: number | undefined;
  /** At least one live poll has answered (or failed): the empty state may speak. */
  answered: boolean;
}

const INITIAL: ChatState = { window: EMPTY_CHAT_WINDOW, loadingOlder: false, error: undefined, status: undefined, answered: false };

/** The gate: field by field, so a poll that changed nothing (a 304, the same window) wakes nobody. */
function sameChat(a: ChatState, b: ChatState): boolean {
  return a.window === b.window && a.loadingOlder === b.loadingOlder && a.error === b.error && a.status === b.status && a.answered === b.answered;
}

const stores = new Map<string, Store<ChatState>>();

export function chatStore(key: string): Store<ChatState> {
  let store = stores.get(key);
  if (!store) {
    store = createStore<ChatState>(INITIAL, sameChat);
    stores.set(key, store);
  }
  return store;
}

/**
 * Live reads started and answered, numbered (use-chat-window.ts `asked`/`answered`): the chat gate's
 * "a read started after the turn ended has answered" test reads these. They move on EVERY poll, so
 * they live outside `ChatState` (two wakes per poll before): `asked` is a plain counter read at
 * render time, and `replies` a store only the pane subscribes to, and only wakes for when the
 * answer crosses the gate's end mark (routes/pane/pane.tsx).
 */
export interface ChatReads {
  asked: number;
  readonly replies: Store<number>;
}

const reads = new Map<string, ChatReads>();

export function chatReads(key: string): ChatReads {
  let entry = reads.get(key);
  if (!entry) {
    entry = { asked: 0, replies: createStore(0) };
    reads.set(key, entry);
  }
  return entry;
}

/** One live poll. Resolves true when the window moved. */
export async function pollChat(key: string, paneId: string, scope: Scope, signal: AbortSignal): Promise<boolean> {
  const store = chatStore(key);
  const counters = chatReads(key);
  const held = store.get().window;
  const number = ++counters.asked;
  try {
    const answer = await fetchChat(paneId, held.gen === 0 ? {} : { after: { gen: held.gen, rev: held.rev } }, scope, signal);
    const next = mergeChat(store.get().window, answer);
    const moved = next !== store.get().window;
    store.update((s) => ({ ...s, window: next, error: undefined, status: undefined, answered: true }));
    counters.replies.update((replies) => Math.max(replies, number));
    return moved;
  } catch (error) {
    if (!(error instanceof Error) || error.name === "AbortError") return false;
    store.update((s) => ({ ...s, error: error.message, status: statusOf(error), answered: true }));
    return false;
  }
}

/** Page one batch of older turns in above the held ones. Resolves the failure's words, or undefined. */
export async function loadOlder(key: string, paneId: string, scope: Scope): Promise<string | undefined> {
  const store = chatStore(key);
  const { window, loadingOlder } = store.get();
  const first = window.entries[0];
  if (loadingOlder || !window.hasOlder || first === undefined) return undefined;
  store.update((s) => ({ ...s, loadingOlder: true }));
  try {
    const answer = await fetchChat(paneId, { limit: OLDER_PAGE, before: { seq: window.oldest, uuid: first.uuid } }, scope);
    store.update((s) => ({ ...s, window: mergeChat(s.window, answer), loadingOlder: false }));
    return undefined;
  } catch (error) {
    store.update((s) => ({ ...s, loadingOlder: false }));
    return describeThrownError(error);
  }
}
