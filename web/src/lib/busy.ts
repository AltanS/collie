import { useSyncExternalStore } from "react";

// App-wide "a mutation is in flight" signal. Every WRITE to the bridge (reply, keys, prompt-option
// tap, upload, tab/space create, pane close, snooze) increments a counter for its duration; the top
// <BusyBar/> reflects `count > 0`. Background READS (snapshot/pane polling) are deliberately NOT
// tracked — they run on a constant timer, so the bar would never rest. Module-scoped, mirroring
// lib/status, so any call site participates without prop-drilling. Concurrent mutations nest via the
// counter, so the bar stays up until the LAST one settles.

let count = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/**
 * Run a promise while counting it as an in-flight mutation. The increment is synchronous (so a
 * caller's `isBusy()` reads true immediately), and the decrement runs in `finally` — a rejected
 * mutation clears the bar just like a resolved one.
 */
export function trackBusy<T>(p: Promise<T>): Promise<T> {
  count++;
  emit();
  return p.finally(() => {
    count--;
    emit();
  });
}

/** Non-hook read of the busy state (for tests and any non-React consumer). */
export function isBusy(): boolean {
  return count > 0;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useBusy(): boolean {
  return useSyncExternalStore(subscribe, isBusy, isBusy);
}
