import { useSyncExternalStore } from "react";

// Which reading surface the pane detail route shows: the persisted conversation thread, or the
// existing terminal mirror.
//
// Device-level, exactly like `lib/strips-collapsed.ts` and `lib/zen.ts` beside it, and deliberately
// NOT a DisplayPrefs field: that dock is per-instance terminal rendering knobs (wrap, font, raw
// mode), while this is "how does THIS device read a pane" — a property of the screen in the hand.
// A separate storage key keeps it independent of terminal display settings and testable alone.
//
// PER-DEVICE, and that is the whole first-release contract: the choice never leaves this device, so
// the operator's phone can read Conversation while the desktop keeps its terminal workflow. It is
// also explicitly OPT-IN: the default is Terminal, so an existing user's pane view does not change
// until they choose Conversation on that device.
//
// FALLBACK DOES NOT ERASE IT. When a pane has no supported journal, the route renders Terminal for
// that pane while this stored preference stays as-is — another pane on the same device can still
// open in Conversation mode. Only an explicit toggle writes here.

export type PaneViewMode = "conversation" | "terminal";

const STORAGE_KEY = "collie:pane-view-mode:v1";
const DEFAULT_MODE: PaneViewMode = "terminal";

let mode = load();
const listeners = new Set<() => void>();

function load(): PaneViewMode {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_MODE;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "conversation" ? "conversation" : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE; // private mode / SSR
  }
}

export function paneViewMode(): PaneViewMode {
  return mode;
}

export function setPaneViewMode(next: PaneViewMode): void {
  if (next === mode) return;
  mode = next;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive read for the pane route. Module-scoped store, mirroring lib/strips-collapsed. */
export function usePaneViewMode(): PaneViewMode {
  return useSyncExternalStore(subscribe, paneViewMode, () => DEFAULT_MODE);
}

/** Test seam — resets the module store to defaults between cases. */
export function __resetPaneViewMode(): void {
  mode = DEFAULT_MODE;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}