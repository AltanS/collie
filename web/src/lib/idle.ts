import { useSyncExternalStore } from "react";

// The idle lock's state, hoisted out of the hook into a module-scoped store so unrelated readers can
// see it: <App> (which renders the cover) and use-polling's tick (which must NOT fetch behind it).
// A store rather than context because the polling tick reads it from inside a `setInterval` callback,
// where a captured render value would go stale — `isLocked()` is a live read at fire time and costs no
// re-render. Same `useSyncExternalStore` shape as lib/status.ts.
//
// It also carries the catch-up beat. Resuming has to refetch (the route tree stayed mounted, so no
// loader re-runs on its own), and the cover claims what's behind it is frozen — so dropping the cover
// the instant you tap would put you back on stale data with nothing saying so. The store is what lets
// the cover, which renders OUTSIDE RouterProvider, know about a revalidation happening inside it.

/** Hard cap on the catch-up beat. A revalidation that never visibly settles (a state flip React
 *  coalesced away, a wedged fetch) must not strand the cover — this releases it regardless. */
const CATCH_UP_CAP_MS = 8_000;

let locked = false;
let catchingUp = false;
let capTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Live read — safe from inside timers/callbacks, unlike a value captured at render. */
export function isLocked(): boolean {
  return locked;
}

export function isCatchingUp(): boolean {
  return catchingUp;
}

export function setLocked(next: boolean): void {
  if (locked === next) return;
  locked = next;
  emit();
}

/** Enter the catch-up beat: the cover stays up, showing the gallop, until the refetch settles. */
export function beginCatchUp(): void {
  if (capTimer) clearTimeout(capTimer);
  capTimer = setTimeout(endCatchUp, CATCH_UP_CAP_MS);
  if (catchingUp) return;
  catchingUp = true;
  emit();
}

export function endCatchUp(): void {
  if (capTimer) {
    clearTimeout(capTimer);
    capTimer = undefined;
  }
  if (!catchingUp) return;
  catchingUp = false;
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Reactive reads for components. */
export function useLocked(): boolean {
  return useSyncExternalStore(subscribe, isLocked, isLocked);
}

export function useCatchingUp(): boolean {
  return useSyncExternalStore(subscribe, isCatchingUp, isCatchingUp);
}

/** Test-only: drop all state and subscribers so a suite can't leak between cases. */
export function resetIdleLock(): void {
  if (capTimer) clearTimeout(capTimer);
  capTimer = undefined;
  locked = false;
  catchingUp = false;
  listeners.clear();
}
