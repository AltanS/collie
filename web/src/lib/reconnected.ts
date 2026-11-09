import { useSyncExternalStore } from "react";

// ── A RESTORED CONNECTION, SHOWN ON THE MARK (2026-11-07) ────────────────────────────────────────
//
// A connection that came back used to flash a green "Connected" strip in the band under the header.
// Altan asked for the band to stop carrying it. The mark says it instead: every bead turns in the
// done colour and the orbit makes exactly ONE full turn at the loading rate, then rests. The word
// "Reconnected" rides the app's one transient-notice channel (`lib/status.ts`) for the same time.
//
// Two places meet here. The connection strip (`components/connection-banner.tsx`) owns the state
// machine that knows a bar was SHOWN and has now cleared, so it decides when a reconnection happened.
// The mark (`components/collie-home.tsx`, fed by `AppHeaderHost`) is drawn by the header, a different
// part of the tree. This store is the one fact between them, so the strip and the mark cannot
// disagree about whether the link just came back.
//
// WHAT COUNTS. Only the end of a bar the operator SAW: amber (trouble) or red (lost). A first paint
// that is already healthy has nothing to recover from, a healthy re-render is not a new event, and a
// blip that never showed a bar recovers silently, as the green strip always did. One refusal on top:
// the app being updated wins (`lib/bundle-apply.ts`). The mark is already turning in the update
// colour, and a green turn would cut across it, so the green turn is SKIPPED, not delayed.
//
// A DISMISSED RED STRIP STILL GETS THE TURN (2026-11-07). The green strip recovered quietly after a
// dismiss, because a strip was the one thing on screen the operator had asked not to see. A dismiss
// hides the strip, not the fact: the mark's lost badge stayed up the whole time, and one quiet turn
// as it clears asks nothing of anyone. So the turn and the word fire there too.

/** The strip's visible tone, or null while no bar is up. */
export type LinkTone = "amber" | "red" | null;

export interface LinkChange {
  /** The bar the operator last SAW, or null when none was shown since the last recovery. */
  shown: LinkTone;
  /** What the live signals want now. */
  next: LinkTone;
  /** A new app build is being applied on this phone (`useBundleApply() !== null`). */
  applying: boolean;
}

/** Whether this change of the link is a reconnection the mark should show. */
export function reconnects({ shown, next, applying }: LinkChange): boolean {
  if (shown === null || next !== null) return false;
  return !applying;
}

let showing = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function stopTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

/** Show the reconnection for `ms` (one turn of the mark), then go back to rest. */
export function showReconnected(ms: number): void {
  stopTimer();
  showing = true;
  emit();
  timer = setTimeout(() => {
    timer = null;
    showing = false;
    emit();
  }, ms);
}

/** End it early: the link dropped again during the turn. */
export function clearReconnected(): void {
  stopTimer();
  if (!showing) return;
  showing = false;
  emit();
}

export function reconnectedShowing(): boolean {
  return showing;
}

export function subscribeReconnected(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the mark shows a reconnection right now, live. */
export function useReconnected(): boolean {
  return useSyncExternalStore(subscribeReconnected, reconnectedShowing, reconnectedShowing);
}

/** Test helper: back to rest, no timer. */
export function __resetReconnected(): void {
  stopTimer();
  showing = false;
  emit();
}
