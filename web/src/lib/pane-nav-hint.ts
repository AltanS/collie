import { useSyncExternalStore } from "react";

// THE FIRST-ARM HINT FOR TWO FINGERS (ADR 0121, release counsel 2026-10-25): once per device, the
// first time the Two fingers mode arms, one floating notice says what just happened and where to turn
// it off. It stands in the floating notice group above the belt (composer.tsx `floating`), so it moves
// nothing (DESIGN.md §11), and its x hides it.
//
// ── SPENT AT THE FIRST ARM, SHOWN UNTIL ITS X ─────────────────────────────────────────────────────
// The device flag is written at the first arm, not at the x: a person who never taps the x, or whose
// page reloads, still meets the hint only once. Whether it stands right now is memory only, so it
// survives the remount a commit makes (the move opens another pane) and goes with the page.
//
// Its own key and the shape of `masked-hint.ts`, per device, kept across an unpair (it records that a
// hint was shown, not what any session said; lib/storage-keys.test.ts holds the decision).

const STORAGE_KEY = "collie:pane-nav-hint:v1";
/** The stored value of a spent hint. Anything else, or nothing, reads as "still to show". */
const SPENT = "1";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

function load(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === SPENT;
  } catch {
    return false;
  }
}

let spent = load();
let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether the hint stands right now. */
export function paneNavHintOpen(): boolean {
  return open;
}

/** Reactive read for the pane. */
export function usePaneNavHintOpen(): boolean {
  return useSyncExternalStore(subscribe, paneNavHintOpen, paneNavHintOpen);
}

/** Two fingers armed. The first time on this device, the hint opens and the device flag is spent. */
export function notePaneNavArm(): void {
  if (spent) return;
  spent = true;
  open = true;
  try {
    storage()?.setItem(STORAGE_KEY, SPENT);
  } catch {
    // Quota or private mode. The in-memory flag still holds for this page.
  }
  emit();
}

/** The hint's x. */
export function dismissPaneNavHint(): void {
  if (!open) return;
  open = false;
  emit();
}

/** Test seam: forget the flag, in memory and in storage. */
export function __resetPaneNavHint(): void {
  spent = false;
  open = false;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

/** Test seam: read the flag again from storage and close the hint, as a fresh page load would. */
export function __reloadPaneNavHint(): void {
  spent = load();
  open = false;
  emit();
}
