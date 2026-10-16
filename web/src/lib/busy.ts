import { useEffect, useSyncExternalStore } from "react";

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

// ── A SECOND CHANNEL IN THE SAME FILE: the Collie mark's orbit ────────────────────────────────
//
// Everything above drives the BAR. `work` drives the ORBIT (components/collie-home.tsx), and the two
// are deliberately not the same number even though both mean "something is happening".
//
// The bar answers "is the app talking to the bridge at all", so it counts every write (`trackBusy`,
// wired once inside lib/api.ts) and adds a stalled read on top. The orbit answers a narrower
// question — "is the thing the OPERATOR just started still going" — and the difference is not
// cosmetic:
//
//   • A BACKGROUND REVALIDATION IS EXCLUDED, and this is the whole reason for the second counter.
//     The poll runs every 1.5s (hooks/use-polling.ts). An orbit fed from the poll would never come
//     to rest, and an orbit that never rests is a decoration rather than a signal — it would also
//     drown the one-round status spin the mark already owns. `pollStalled` covers the hung-poll case
//     for the BAR; the mark's own stall detector (useConnectionTrouble → `trouble`) is what covers
//     it here, on a 4s delay, and it is already wired.
//   • It is fed from the UI STATE, not from the request. "Sending" is true across the whole guarded
//     send — type, settle, verify, submit — which is several round trips and some deliberate waiting;
//     `trackBusy` would blink once per leg. Same for a transcription, which is a recorder phase.
//
// So: a call site declares an interval of operator-initiated work, the orbit turns for exactly that
// interval, and nothing else feeds it.
let work = 0;
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

/**
 * Declare that a piece of operator-initiated work has STARTED, and get back the way to end it.
 *
 * The returned release is IDEMPOTENT — calling it twice releases once. That is what makes it safe as
 * a React effect cleanup, where a remount under StrictMode (and any future double-invoke) would
 * otherwise decrement a counter it only incremented once and drive it negative, which is a stuck-OFF
 * orbit rather than a stuck-on one. Concurrent work nests: the orbit turns until the LAST release.
 */
export function beginBusy(): () => void {
  work++;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    work--;
    emit();
  };
}

/** Non-hook read of the orbit's channel (for tests and any non-React consumer). */
export function isOperatorBusy(): boolean {
  return work > 0;
}

/**
 * Hold the orbit open for exactly as long as `active` is true.
 *
 * The declarative form of {@link beginBusy}, and the one every call site here uses: `sending`,
 * `uploading`, a recorder phase and a router navigation are all already booleans on a render, so the
 * begin/release pair belongs to the effect's lifecycle rather than to a try/finally somebody has to
 * remember to close. Unmounting mid-work releases, so a pane switch cannot strand the orbit.
 *
 * SHORT WORK IS NOT A FLICKER, and that is a property of the mark rather than of a debounce here.
 * <CollieMark/> carries the orbit's PHASE across a rate change by hand (collie-mark.tsx), so a spin
 * that lasts 200ms joins the resting drift where it left it and rejoins it where it lands — it reads
 * as a short accelerate/decelerate, not as a jump to a different picture and back. Nothing needs a
 * minimum duration, and adding one would make the orbit outlive the work it is reporting.
 */
export function useBusyWhile(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return beginBusy();
  }, [active]);
}

/** Reactive read of the orbit's channel. Module-scoped store, mirroring lib/status. */
export function useOperatorBusy(): boolean {
  return useSyncExternalStore(subscribe, isOperatorBusy, isOperatorBusy);
}

/** Test seam — drops any work left counted by a case that unmounted nothing. */
export function __resetOperatorBusy(): void {
  work = 0;
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
