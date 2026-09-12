import { useSyncExternalStore } from "react";

// Whether this phone draws the HARNESS BAR — the row of the running agent's own slash commands on
// the actions belt.
//
// Per-device: it is a property of the glass and the thumb in front of it, so a phone and a tablet
// paired to the same collie disagree by design. It is localStorage only, never in the snapshot and
// never on the wire.
//
// DEFAULT ON. This row is new and it is the whole point of the feature, and a row nobody can see
// until they find Settings is a row nobody uses. The toggle is there for the operator who does not
// want it, not for the operator who has not heard of it.

const STORAGE_KEY = "collie:harness-bar:v1";
const DEFAULT_ENABLED = true;

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

export function harnessBarEnabled(): boolean {
  return enabled;
}

export function setHarnessBarEnabled(on: boolean): void {
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

/** Reactive read for the Settings toggle and the composer's two call sites. */
export function useHarnessBarEnabled(): boolean {
  return useSyncExternalStore(subscribe, harnessBarEnabled, () => DEFAULT_ENABLED);
}

/** Test seam — resets the module store to its default between cases. */
export function __resetHarnessBar(): void {
  enabled = DEFAULT_ENABLED;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
