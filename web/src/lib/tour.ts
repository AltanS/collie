import { useSyncExternalStore } from "react";

// Has this device seen the first-run screen, and which version of it. Per-device, like haptics and
// the typeface: a fact only the phone in your hand cares about, so there is no bridge field and no
// server-side record of who saw what.
//
// THE STORED VALUE IS A DECIMAL INTEGER STRING, never JSON and never a boolean — `"1"`, not
// `{"v":1}`. An absent or unparseable value reads as `0`, which is also what `resetTour()` writes:
// a device that asked to see the tour again and a device that never saw it are the same case, and
// one case needs no second branch.
//
// THE BUMP RULE. Raise `TOUR_VERSION` when a CLAIM on the screen changes — a new fact, a different
// way to answer a pane, a control that moved. Never raise it because the wording was polished. Every
// device sees the screen once more on a bump, so a bump is a `### Changed` changelog line of its own.

/** The one place this key is spelled. The e2e seeder imports it rather than re-typing it. The `v1`
 *  in it names the STORE’s shape (a decimal integer), not the screen’s version — that is the
 *  number stored under it, so a new screen never needs a new key. */
export const TOUR_STORAGE_KEY = "collie:tour:v1";

/**
 * The first-run screen this bundle ships. A device that has seen a lower number is shown it once
 * more. Version 2 is the single scrolling screen that replaced the three-slide tour: every claim on
 * it is new, and most of them are now facts about this install, so every device earns one more look.
 */
export const TOUR_VERSION = 2;

/** The version this device last saw, `0` for "never" (and for a device that asked to see it again). */
let seen = load();
const listeners = new Set<() => void>();

function load(): number {
  // try/catch IS the environment probe: a `localStorage` that does not exist throws on the read,
  // and private mode throws on some browsers even where it does. Either way, never seen.
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0; // private mode / SSR
  }
}

function write(version: number): void {
  seen = version;
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, String(version));
  } catch {
    // Ignore quota / SSR write errors — the in-memory value still applies for this session, so the
    // tour does not re-open behind the operator's back on a revalidation.
  }
  for (const fn of listeners) fn();
}

export function tourSeenVersion(): number {
  return seen;
}

/** Called from exactly one place: the effect in `TourHost` that OPENS the screen. Never on close. */
export function markTourSeen(): void {
  write(TOUR_VERSION);
}

/** The Settings row's "show it again". Writes `"0"`; it does not remove the key. */
export function resetTour(): void {
  write(0);
}

export function shouldShowTour(seenVersion: number): boolean {
  return seenVersion < TOUR_VERSION;
}

/** Reactive read for the host. Module-scoped store, mirroring lib/haptics.ts. */
export function useTourSeen(): number {
  return useSyncExternalStore(subscribe, tourSeenVersion, () => 0);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam — resets the module store to "never seen" between cases. */
export function __resetTourStore(): void {
  seen = 0;
  try {
    localStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}
