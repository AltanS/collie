import { useSyncExternalStore } from "react";

// Availability of the pane view's zen mode — chrome-free, mirror-only viewing.
//
// This is device-level ("does this phone offer zen at all"), so it lives here beside haptics rather
// than in DisplayPrefs: that dock's prefs are per-instance rendering knobs, this one persists and
// gates whether the entry point exists at all. Default OFF — zen takes away every way back except
// one floating button, so it is opt-in.
//
// A second, independent bit rides alongside it: whether turning the phone to a SHORT landscape
// viewport should ENTER zen automatically (AgentChat's own rotation effect). Default OFF, like zen
// itself. It cannot act alone — AgentChat gates its rotation effect on BOTH bits — but an operator
// who already runs with zen on would get the rotation on the next upgrade without asking for it,
// and zen empties the screen. So the operator turns this row on himself. It stays a separate bit
// because "zen on a tap" and "zen on a turn" are two different asks. Flipping this default later
// needs a note to existing operators, not a silent change.
//
// The active zen state itself is NOT here: it is transient local state in AgentChat, reset by the
// key={paneId} remount, so a pane always opens normal.

const STORAGE_KEY = "collie:zen-enabled:v1";
const DEFAULT_ENABLED = false;
const AUTO_STORAGE_KEY = "collie:auto-zen-enabled:v1";
// Default OFF, like zen itself. Auto-zen is the operator's choice: an install that already has zen
// on must not start emptying its screen on a rotation nobody asked about. The row sits under Zen in
// Settings and one tap turns it on. A future flip of this default owes existing operators a note.
const DEFAULT_AUTO_ENABLED = false;

let enabled = load();
let autoEnabled = loadAuto();
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

function loadAuto(): boolean {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_AUTO_ENABLED;
    const raw = localStorage.getItem(AUTO_STORAGE_KEY);
    return raw === null ? DEFAULT_AUTO_ENABLED : raw === "1";
  } catch {
    return DEFAULT_AUTO_ENABLED; // private mode / SSR
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

export function autoZenEnabled(): boolean {
  return autoEnabled;
}

export function setAutoZenEnabled(on: boolean): void {
  autoEnabled = on;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(AUTO_STORAGE_KEY, on ? "1" : "0");
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

/** Reactive read for the Settings sub-toggle. */
export function useAutoZenEnabled(): boolean {
  return useSyncExternalStore(subscribe, autoZenEnabled, () => DEFAULT_AUTO_ENABLED);
}

/** Test seam — resets both module stores to defaults between cases. */
export function __resetZen(): void {
  enabled = DEFAULT_ENABLED;
  autoEnabled = DEFAULT_AUTO_ENABLED;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(AUTO_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
