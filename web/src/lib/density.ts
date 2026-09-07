import { useSyncExternalStore } from "react";

// Whether this phone renders the DENSE key surfaces — the compact grids and single always-on key
// rail — instead of the roomy ones.
//
// This is device-level ("how tight does this phone draw"), so it lives here beside zen and haptics
// rather than in DisplayPrefs: that dock's prefs are per-pane rendering knobs the operator flips
// while watching the mirror, this one is a standing decision about the whole app's chrome. Default
// OFF, so an install that never opens Settings renders exactly what it rendered before.
//
// It is deliberately ONE bit, not a scale. The dense layout is a set of choices that only read
// together (smaller targets buy more keys per row, which is what makes a single rail worth its
// row); a per-surface dial would let a phone land on combinations nobody laid out or looked at.
//
// The bit is per-device and never travels: it is a property of the glass and the thumb in front of
// it, so a phone and a tablet paired to the same collie disagree by design.

const STORAGE_KEY = "collie:dense-keys:v1";
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

export function denseKeysEnabled(): boolean {
  return enabled;
}

export function setDenseKeysEnabled(on: boolean): void {
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

/** Reactive read for the Settings toggle and every surface that draws two ways. */
export function useDenseKeysEnabled(): boolean {
  return useSyncExternalStore(subscribe, denseKeysEnabled, () => DEFAULT_ENABLED);
}

/** Test seam — resets the module store to its default between cases. */
export function __resetDenseKeys(): void {
  enabled = DEFAULT_ENABLED;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
