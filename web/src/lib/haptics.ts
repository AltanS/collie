import { useSyncExternalStore } from "react";

// Haptic tick on a control press. A phone-first app driving a real terminal wants confirmation you
// can FEEL: a buzz under the thumb lands before any pixel can, and this app's whole press-feedback
// problem was that acknowledgement arrived too late to connect to the tap.
//
// Platform gate is the optional call itself: `navigator.vibrate` is simply undefined on iOS Safari,
// so `?.()` IS the feature detection — no UA sniffing, no polyfill, it just does nothing there.
// User activation is guaranteed because every caller is inside a tap handler.

const STORAGE_KEY = "collie:haptics:v1";
const DEFAULT_ENABLED = true;

/** Duration of a single press tick, in ms. Short enough to read as a click rather than a rumble. */
const TICK_MS = 10;

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

/** Whether the device can buzz at all — drives whether the Settings row is worth showing. */
export function hapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function hapticsEnabled(): boolean {
  return enabled;
}

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session.
  }
  for (const fn of listeners) fn();
  if (on) buzz(); // confirm the setting with the thing the setting does
}

/**
 * One press tick, if haptics are on and the platform has them. Deliberately fire-and-forget and
 * never throws: a buzz is never important enough to break a send.
 *
 * NOTE for repeat/hold callers: do NOT call this per repeat tick. Android coalesces rapid vibrate()
 * calls unpredictably and a held arrow key would turn the phone into a massager — buzz on engage
 * only (see hooks/use-hold-repeat.ts).
 */
export function buzz(ms: number = TICK_MS): void {
  if (!enabled) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Some browsers throw on a blocked/unsupported call — a missing buzz is not an error.
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reactive read for the Settings toggle. Module-scoped store, mirroring lib/status and lib/busy. */
export function useHapticsEnabled(): boolean {
  return useSyncExternalStore(subscribe, hapticsEnabled, () => DEFAULT_ENABLED);
}

/** Test seam — resets the module store to defaults between cases. */
export function __resetHaptics(): void {
  enabled = DEFAULT_ENABLED;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
