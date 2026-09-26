import { useSyncExternalStore } from "react";

// THE PIN HINT (M38/02): whether this device still needs to be told that a hold pins a pane.
//
// A hold is the dashboard's fast door to Pin to top (ADR 0070), and a hold is invisible until someone
// tries one: "long pressing is kinda hidden" (Altan, 2026-09-27). A pin icon on every row was weighed
// and declined, so the Panes tab says it once instead, in one quiet line where the Pinned group will
// stand (`components/pin-hint.tsx`). This module holds the one fact the line needs: has this device
// retired it.
//
// ── RETIRED ON THE OPERATOR'S OWN ACT, NEVER ON A READ ───────────────────────
// Two acts retire it, and nothing else writes: the line's own X, and the first pin from any surface
// (`setPinned` in `pins.ts` calls `retirePinHint`, so the pane pill's hold and the header ⋮ count as
// well as the row the line points at). A render, a poll, a read or a tab switch writes nothing.
//
// ── FOR GOOD ─────────────────────────────────────────────────────────────────
// Once retired the line stays gone on this device, also after every pin is removed: an operator who
// pinned once has found the gesture, and a line that came back each time the last pin left would be a
// nag. That is why this is its own flag and not "no pins stored": the pins store empties itself.
//
// Its own key, not a field in `collie:dash-prefs:v1` or `collie:pins:v1`, for the reason `pins.ts`
// gives (a per-instance copy would lose the write). Per device, like the pins it teaches.

const STORAGE_KEY = "collie:pin-hint:v1";
/** The stored value of a retired hint. Anything else, or nothing, reads as "still to show". */
const RETIRED = "1";

/**
 * The fewest pane rows the Panes list must show before the line appears. A herd of one or two has
 * nothing to pin above anything, so the line would teach a gesture with no use yet.
 */
export const PIN_HINT_MIN_ROWS = 3;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

function load(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === RETIRED;
  } catch {
    return false;
  }
}

let retired = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether this device has retired the line, as it stands. */
export function pinHintRetired(): boolean {
  return retired;
}

/** Reactive read for the Panes tab. */
export function usePinHintRetired(): boolean {
  return useSyncExternalStore(subscribe, pinHintRetired, pinHintRetired);
}

/**
 * The operator dismissed the line or pinned a pane: retire it on this device for good. Writes once;
 * a later call finds it retired and writes nothing.
 */
export function retirePinHint(): void {
  if (retired) return;
  retired = true;
  try {
    storage()?.setItem(STORAGE_KEY, RETIRED);
  } catch {
    // Quota or private mode. The in-memory flag still holds for this session.
  }
  for (const fn of listeners) fn();
}

/**
 * Whether the Panes tab draws the line: not retired, no pin stored (a dormant one included, because
 * whoever made it knows the gesture), and at least {@link PIN_HINT_MIN_ROWS} pane rows on show.
 */
export function showsPinHint(isRetired: boolean, pinCount: number, rowCount: number): boolean {
  return !isRetired && pinCount === 0 && rowCount >= PIN_HINT_MIN_ROWS;
}

/** Test seam: forget the flag, in memory and in storage. */
export function __resetPinHint(): void {
  retired = false;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}

/** Test seam: read the flag again from storage, as a fresh page load would. */
export function __reloadPinHint(): void {
  retired = load();
  for (const fn of listeners) fn();
}
