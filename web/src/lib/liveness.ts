import { useEffect, useReducer, useSyncExternalStore } from "react";
import { paneScopeKey, type Scope } from "./scope";

// ── WHEN DID THE BRIDGE LAST ANSWER FOR THIS PANE? ───────────────────────────────────────────────
//
// M46 spec 11: nothing acts from cached state. A screen drawn from the on-device cache can be hours
// old, so a dialog button or Send on it would answer a question that no longer exists. This module
// is the one fact those controls ask: "did the bridge answer a read for THIS pane just now?"
//
// `fetchPane` (lib/api.ts) is the only writer: it stamps a pane the moment a read comes back live
// (200, or a 304 that proves the cached body is still current). A control is enabled while the stamp
// is fresh and disabled once it is older than the window, so a bridge that goes quiet takes the
// controls with it, with no one having to notice the outage first.
//
// Keyed by (host, session, pane) like every other per-pane cache, because pane ids repeat across
// sessions and crew members. `scope` is optional: absent means the lead's default session.
//
// Module state + subscribe, the lib/pairing.ts idiom. Not persisted: a cold open starts with every
// pane not live, which is exactly the point.

/** How long a live answer keeps a pane's controls on. Past the idle poll gap (6s), so a quiet open
 *  pane does not flicker between polls, and short enough that a lost bridge is felt in seconds. */
export const LIVE_WINDOW_MS = 15_000;

const stamps = new Map<string, number>();
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

/** Record a live answer from the bridge for `paneId` (at `at`, default now). */
export function markLive(paneId: string, at: number = Date.now(), scope?: Scope): void {
  const key = paneScopeKey(scope, paneId);
  const prev = stamps.get(key);
  // An older stamp (a slow response landing after a newer one) never moves the clock back.
  if (prev !== undefined && prev >= at) return;
  stamps.set(key, at);
  emit();
}

/** Did the bridge answer a read for `paneId` within `withinMs`? */
export function isLive(paneId: string, withinMs: number = LIVE_WINDOW_MS, scope?: Scope): boolean {
  const at = stamps.get(paneScopeKey(scope, paneId));
  return at !== undefined && Date.now() - at <= withinMs;
}

/**
 * `isLive` for a component: re-renders when a new mark lands, and again at the moment the current
 * mark ages out, so a bridge that stops answering disables the controls without any other event.
 */
export function useLive(paneId: string, scope?: Scope, withinMs: number = LIVE_WINDOW_MS): boolean {
  const key = paneScopeKey(scope, paneId);
  const at = useSyncExternalStore(
    subscribe,
    () => stamps.get(key),
    () => undefined,
  );
  // The store's snapshot (`at`) does not change when a mark ages out, so the expiry re-renders
  // through its own tick instead.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const live = at !== undefined && Date.now() - at <= withinMs;
  useEffect(() => {
    if (at === undefined) return;
    const left = at + withinMs - Date.now();
    if (left < 0) return;
    // +1ms: the window is inclusive, so the first instant it is false is one past its end.
    const timer = setTimeout(tick, left + 1);
    return () => clearTimeout(timer);
  }, [at, withinMs]);
  return live;
}

/** Test seam: forget every stamp. */
export function resetLiveness(): void {
  stamps.clear();
  emit();
}
