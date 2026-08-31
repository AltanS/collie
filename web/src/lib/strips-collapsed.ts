import { useSyncExternalStore } from "react";

// Whether the pane view's two chrome strips — the tab row and the pane row — are folded away into
// the thin summary bar that stands in for them.
//
// Device-level, exactly like `lib/zen.ts` beside it, and for the same reason: this is "how much
// chrome does this phone want above the mirror", a property of the screen in the hand rather than of
// any one pane. It is NOT a DisplayPrefs field — that dock's prefs are per-instance rendering knobs
// — and it is NOT per-pane: folding the rows on one pane and finding them back on the next is the
// jump the fold exists to stop.
//
// Default OFF (rows shown), because the rows are the pane's only visible way to reach a sibling tab
// or pane, and a first run that hides them hides the navigation with them. The summary bar keeps
// that reachable in one tap once the operator has chosen it.
//
// The keyboard's override is NOT here: while the soft keyboard is up the rows stand down whatever
// this says, and an expand taken in that state is transient local state in AgentChat that dies with
// the keyboard. See the `composing` block there — a preference is what the operator chose, not what
// the keyboard is currently costing them.

const STORAGE_KEY = "collie:strips-collapsed:v1";
const DEFAULT_COLLAPSED = false;

let collapsed = load();
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_COLLAPSED;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_COLLAPSED : raw === "1";
  } catch {
    return DEFAULT_COLLAPSED; // private mode / SSR
  }
}

export function stripsCollapsed(): boolean {
  return collapsed;
}

export function setStripsCollapsed(on: boolean): void {
  collapsed = on;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive read for the pane view. Module-scoped store, mirroring lib/zen. */
export function useStripsCollapsed(): boolean {
  return useSyncExternalStore(subscribe, stripsCollapsed, () => DEFAULT_COLLAPSED);
}

/** Test seam — resets the module store to defaults between cases. */
export function __resetStripsCollapsed(): void {
  collapsed = DEFAULT_COLLAPSED;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
