import { useSyncExternalStore } from "react";

// App-wide "the bar should show" signal. Two independent sources feed it:
//   1. Mutations — every WRITE to the bridge (reply, keys, prompt-option tap, upload, tab/space
//      create, pane close, snooze) increments a counter for its duration.
//   2. A SLOW load — a background revalidation (the poll) or a route navigation that stays in flight
//      past its own threshold sets a boolean (see hooks/use-poll-busy, which uses two independent
//      thresholds — snappy for navigation, longer for the ambient poll). A routine fast poll never
//      trips it, so the bar stays invisible on healthy traffic; only genuinely laggy loading does.
// The top <BusyBar/> reflects `count > 0 || pollStalled`. Background reads are otherwise NOT counted
// as mutations — they run on a constant timer, so the counter alone would never rest. Module-scoped,
// mirroring lib/status, so any call site participates without prop-drilling. Concurrent mutations
// nest via the counter, so the bar stays up until the LAST one settles.

let count = 0;
let pollStalled = false;
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

/**
 * Set whether a slow poll/revalidation is currently surfacing the bar. Idempotent (a no-op when
 * unchanged, so it doesn't churn subscribers). Driven only by hooks/use-poll-busy, which clears it
 * the moment loading stops and on unmount, so the bar can't get stuck on.
 */
export function setPollBusy(stalled: boolean): void {
  if (pollStalled === stalled) return;
  pollStalled = stalled;
  emit();
}

/** Non-hook read of the busy state (for tests and any non-React consumer). */
export function isBusy(): boolean {
  return count > 0 || pollStalled;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useBusy(): boolean {
  return useSyncExternalStore(subscribe, isBusy, isBusy);
}
