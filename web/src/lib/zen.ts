import { useSyncExternalStore } from "react";

// Availability of the pane view's zen mode — chrome-free, mirror-only viewing.
//
// This is device-level ("does this phone offer zen at all"), so it lives here beside haptics rather
// than in DisplayPrefs: that dock's prefs are per-instance rendering knobs, this one persists and
// gates whether the entry point exists at all. Default OFF — zen takes away every way back except
// one floating button, so it is opt-in.
//
// The active zen state itself is NOT here: it is transient local state in AgentChat, reset by the
// key={paneId} remount, so a pane always opens normal.

const STORAGE_KEY = "collie:zen-enabled:v1";
const DEFAULT_ENABLED = false;

let enabled = load();
const listeners = new Set<() => void>();

function load(): boolean {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_ENABLED;
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_ENABLED : raw === "1";
  } catch {
    return DEFAULT_ENABLED; // private mode / SSR
  }
}

export function zenEnabled(): boolean {
  return enabled;
}

export function setZenEnabled(on: boolean): void {
  enabled = on;
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

/** Reactive read for the Settings toggle. Module-scoped store, mirroring lib/haptics. */
export function useZenEnabled(): boolean {
  return useSyncExternalStore(subscribe, zenEnabled, () => DEFAULT_ENABLED);
}

/** Test seam — resets the module store to defaults between cases. */
export function __resetZen(): void {
  enabled = DEFAULT_ENABLED;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
