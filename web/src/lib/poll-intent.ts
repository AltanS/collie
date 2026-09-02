import { useSyncExternalStore } from "react";

// What the poller needs to know that only the SENDING and READING code can tell it: did the operator
// just act, is the mirror still changing, and is the operator still looking at the live tail.
//
// A module-scoped store rather than context or props, for the same reason lib/idle.ts is one: the
// writers (the composer's send paths, the pane loader) and the reader (hooks/use-polling.ts, mounted
// at the data root) sit in different subtrees, and the poller reads some of it from inside a
// `setInterval` callback where a captured render value would go stale. Every value here is a
// PRIMITIVE, so `useSyncExternalStore` can hand it out without a cached snapshot object.
//
// See hooks/use-polling.ts → intervalFor for the rules these values feed.

// ── The burst, as pure bookkeeping ────────────────────────────────────────────
//
// A send is the one moment the operator is certainly watching, so the poll gap collapses for a few
// beats and then earns its way back out. The rules are deliberately counted in POLLS, not in
// milliseconds: a burst that ended on a wall-clock deadline would end early on a slow link (where
// the polls it promised never happened) and late on a fast one.

/** A burst always buys at least this many polls, however quiet the pane turns out to be. Enough to
 *  cover the send's own round trip plus the TUI's repaint, so a fast key never drops back to the
 *  slow gap before its own effect has shown up on screen. */
export const BURST_MIN_POLLS = 5;
/** After the minimum, this many CONSECUTIVE unchanged polls end it. Two rather than one, because a
 *  single unchanged poll is routine mid-turn (an agent thinking between two lines of output). */
export const BURST_QUIET_POLLS = 2;

/** The burst's whole state. `paneId === null` means no burst is running. */
export interface BurstState {
  /** The pane the send went to — a burst is only ever spent on that pane's own mirror. */
  paneId: string | null;
  /** Polls counted since the burst (re)started. */
  polls: number;
  /** Consecutive polls that came back unchanged; reset by any changed poll. */
  quiet: number;
}

export const NO_BURST: BurstState = { paneId: null, polls: 0, quiet: 0 };

/** A send starts a burst, and a send DURING a burst restarts it — both counters go back to zero, so
 *  each tap buys its own full minimum rather than inheriting the last one's exhausted budget. */
export function burstOnSend(paneId: string): BurstState {
  return { paneId, polls: 0, quiet: 0 };
}

/** Fold one poll's verdict into the burst. Returns {@link NO_BURST} when this poll ended it. */
export function burstOnPoll(state: BurstState, changed: boolean): BurstState {
  if (state.paneId === null) return state;
  const polls = state.polls + 1;
  const quiet = changed ? 0 : state.quiet + 1;
  if (polls >= BURST_MIN_POLLS && quiet >= BURST_QUIET_POLLS) return NO_BURST;
  return { paneId: state.paneId, polls, quiet };
}

/** True when `state` is a live burst spent on the pane currently open. A burst whose pane has been
 *  left is not spent on the home screen or on another pane — the operator is no longer watching the
 *  thing they typed into. */
export function burstApplies(state: BurstState, openPaneId: string | null | undefined): boolean {
  return burstAppliesTo(state.paneId, openPaneId);
}

/** The same question asked of the burst's pane id alone — what a reader that subscribed to
 *  {@link useBurstPaneId} already holds. */
export function burstAppliesTo(
  burstPane: string | null,
  openPaneId: string | null | undefined,
): boolean {
  return burstPane !== null && burstPane === (openPaneId ?? null);
}

// ── The store ────────────────────────────────────────────────────────────────

let burst: BurstState = NO_BURST;
let following = true;
let changed = false;
let sends = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The operator just sent something to `paneId` — a key, a message, an answer to a dialog.
 *
 * Restarts the burst, and bumps the send counter that the poller uses to RESCHEDULE: a tap must
 * never sit out the remainder of a gap that was timed for an idle pane.
 */
export function stampSend(paneId: string): void {
  burst = burstOnSend(paneId);
  sends += 1;
  emit();
}

/**
 * One pane read came back: `changed` false for an ETag hit (the mirror is identical), true for a
 * body we had not already seen.
 *
 * This is the signal that lets the cadence work for a plain shell and for an agent whose harness
 * publishes no status at all — "the screen is still moving" is observable without either.
 */
export function markPollResult(next: boolean): void {
  const nextBurst = burstOnPoll(burst, next);
  if (nextBurst === burst && changed === next) return;
  burst = nextBurst;
  changed = next;
  emit();
}

/** The pane view's follow intent, mirrored out of its local state so the poller can see it. Set back
 *  to true when the pane is left: with nothing open there is no scrollback to be held in. */
export function setFollowing(next: boolean): void {
  if (following === next) return;
  following = next;
  emit();
}

/** Live reads — safe from inside timers/callbacks, unlike values captured at render. */
export function burstPaneId(): string | null {
  return burst.paneId;
}

export function burstState(): BurstState {
  return burst;
}

export function isFollowing(): boolean {
  return following;
}

export function lastPollChanged(): boolean {
  return changed;
}

/** Monotonic count of sends. Only its CHANGES mean anything: each one is "reschedule now". */
export function sendCount(): number {
  return sends;
}

// Reactive reads, used by the poller. Each is a plain primitive, so no cached snapshot is needed.
export function useBurstPaneId(): string | null {
  return useSyncExternalStore(subscribe, burstPaneId, burstPaneId);
}

export function useFollowing(): boolean {
  return useSyncExternalStore(subscribe, isFollowing, isFollowing);
}

export function useLastPollChanged(): boolean {
  return useSyncExternalStore(subscribe, lastPollChanged, lastPollChanged);
}

export function useSendCount(): number {
  return useSyncExternalStore(subscribe, sendCount, sendCount);
}

/** Test-only: drop all state and subscribers so a suite can't leak between cases. */
export function resetPollIntent(): void {
  burst = NO_BURST;
  following = true;
  changed = false;
  sends = 0;
  listeners.clear();
}
