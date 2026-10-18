import { useEffect, useReducer, useSyncExternalStore } from "react";
import { paneScopeKey, type Scope } from "./scope";

// ── DID THE BRIDGE'S LAST READ OF THIS PANE SUCCEED? ─────────────────────────────────────────────
//
// M46 spec 11: nothing acts from cached state. A screen drawn from the on-device cache can be hours
// old, so a dialog button or Send on it would answer a question that no longer exists. This module
// is the one fact those controls ask: "is this pane live?"
//
// LIVE MEANS THE LAST READ SUCCEEDED. Not "a read succeeded in the last N seconds": polling is
// intent-driven (lib/poll-intent.ts), and a quiet pane can go longer between reads than any short
// window, which locked dialog buttons and Send on a healthy bridge. So the rule is failure-based:
//
//   - `markLive` (lib/api.ts `fetchPane`, on a 200 or a 304) makes the pane live AT ONCE. No delay on
//     the way up: a control the operator is waiting for comes back the instant the bridge answers.
//   - `markDead` (the same function's failure path) takes it down after DEAD_DEBOUNCE_MS, unless a
//     read succeeds first. One dropped poll does not flicker the buttons.
//   - The browser going offline (the `offline` event, or `navigator.onLine === false`) takes every
//     pane down at once, and so does `markAllDead`.
//   - A pane whose screen is a saved copy is not live (`markSavedCopy`, lib/loaders.ts), at once.
//   - ONE SAFETY CAP: a pane whose last success is older than LIVE_CAP_MS is not live, whatever else
//     happened. A poll loop that stopped without failing (a suspended tab, a stuck fetch) cannot keep
//     the controls on for ever.
//
// Keyed by (host, session, pane) like every other per-pane cache, because pane ids repeat across
// sessions and crew members. `scope` is optional: absent means the lead's default session.
//
// Module state + subscribe, the lib/pairing.ts idiom. Not persisted: a cold open starts with every
// pane not live, which is exactly the point.

/** The safety cap: how long one success can keep a pane live with no read since. */
export const LIVE_CAP_MS = 90_000;

/** How long a failed read waits before it takes the pane down, so one dropped poll does not flicker. */
export const DEAD_DEBOUNCE_MS = 1_000;

/** Pane key → the time of its last successful read. Present means live (within the cap). */
const stamps = new Map<string, number>();
/** Pane key → the pending take-down a failed read scheduled. */
const pendingDead = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function browserOffline(): boolean {
  return globalThis.navigator?.onLine === false;
}

function cancelPending(key: string): void {
  const timer = pendingDead.get(key);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingDead.delete(key);
}

function dropNow(key: string): void {
  cancelPending(key);
  if (stamps.delete(key)) emit();
}

/** Record a successful read for `paneId` (at `at`, default now). The pane is live at once. */
export function markLive(paneId: string, at: number = Date.now(), scope?: Scope): void {
  const key = paneScopeKey(scope, paneId);
  cancelPending(key);
  const prev = stamps.get(key);
  // An older stamp (a slow response landing after a newer one) never moves the clock back.
  if (prev !== undefined && prev >= at) return;
  stamps.set(key, at);
  emit();
}

/**
 * Record a failed read for `paneId`. The pane goes down after {@link DEAD_DEBOUNCE_MS} unless a read
 * succeeds before then. A pane already down, or already going down, is left as it is.
 */
export function markDead(paneId: string, scope?: Scope): void {
  const key = paneScopeKey(scope, paneId);
  if (!stamps.has(key) || pendingDead.has(key)) return;
  pendingDead.set(
    key,
    setTimeout(() => {
      pendingDead.delete(key);
      if (stamps.delete(key)) emit();
    }, DEAD_DEBOUNCE_MS),
  );
}

/** The screen for `paneId` is a saved copy, not a live read: the pane is not live, at once. */
export function markSavedCopy(paneId: string, scope?: Scope): void {
  dropNow(paneScopeKey(scope, paneId));
}

/** Every pane goes down at once: the browser went offline. */
export function markAllDead(): void {
  for (const timer of pendingDead.values()) clearTimeout(timer);
  pendingDead.clear();
  if (stamps.size === 0) return;
  stamps.clear();
  emit();
}

function liveAt(at: number | undefined): boolean {
  return at !== undefined && !browserOffline() && Date.now() - at <= LIVE_CAP_MS;
}

/** Is `paneId` live: its last read succeeded, within the safety cap, with the browser online? */
export function isLive(paneId: string, scope?: Scope): boolean {
  return liveAt(stamps.get(paneScopeKey(scope, paneId)));
}

/**
 * `isLive` for a component: re-renders when a mark lands or is dropped, and again at the moment the
 * safety cap runs out, so a poll loop that went silent disables the controls without another event.
 */
export function useLive(paneId: string, scope?: Scope): boolean {
  const key = paneScopeKey(scope, paneId);
  const at = useSyncExternalStore(
    subscribe,
    () => stamps.get(key),
    () => undefined,
  );
  // The store's snapshot (`at`) does not change when the cap runs out, so the expiry re-renders
  // through its own tick instead.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const live = liveAt(at);
  useEffect(() => {
    if (at === undefined) return;
    const left = at + LIVE_CAP_MS - Date.now();
    if (left < 0) return;
    // +1ms: the cap is inclusive, so the first instant it is false is one past its end.
    const timer = setTimeout(tick, left + 1);
    return () => clearTimeout(timer);
  }, [at]);
  return live;
}

// The browser says it lost the network: nothing is live until a read succeeds again.
globalThis.addEventListener?.("offline", markAllDead);

/** Test seam: forget every stamp and every pending take-down. */
export function resetLiveness(): void {
  for (const timer of pendingDead.values()) clearTimeout(timer);
  pendingDead.clear();
  stamps.clear();
  emit();
}
