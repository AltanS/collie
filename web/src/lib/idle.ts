import { useSyncExternalStore } from "react";

// The idle lock's state, hoisted out of the hook into a module-scoped store so two unrelated readers
// can see it: <App> (which renders the cover) and use-polling's tick (which must NOT fetch behind it).
// A store rather than context because the polling tick reads it from inside a `setInterval` callback,
// where a captured render value would go stale — `isLocked()` is a live read at fire time and costs no
// re-render. Same `useSyncExternalStore` shape as lib/status.ts.

let locked = false;
const listeners = new Set<() => void>();

/** Live read — safe from inside timers/callbacks, unlike a value captured at render. */
export function isLocked(): boolean {
  return locked;
}

export function setLocked(next: boolean): void {
  if (locked === next) return;
  locked = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Reactive read for components. */
export function useLocked(): boolean {
  return useSyncExternalStore(subscribe, isLocked, isLocked);
}

/** Test-only: drop the lock and every subscriber so a suite can't leak state between cases. */
export function resetIdleLock(): void {
  locked = false;
  listeners.clear();
}
