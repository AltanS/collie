// Has this device seen the first-run screen, and which version of it. Port of web/src/lib/tour.ts, which
// cannot be imported here (its hook is React), on the SAME key and the same value form, so a phone that
// saw the tour under one shell does not see it under the other:
//
//   collie:tour:v1   a decimal integer string, never JSON; absent or unparseable reads as 0
//
// `resetTour()` of the Settings row (routes/settings/device-prefs.ts) writes "0" straight to storage and
// tells nobody. So this store is NOT a cached copy: every read goes back to storage. The host asks again
// on each render (any navigation re-renders the Shell, and the reset row navigates), and that is how a
// reset re-opens the screen without a listener on a key nobody announces.
//
// THE BUMP RULE is web's: raise TOUR_VERSION when a CLAIM on the screen changes, never for polish.

export const TOUR_STORAGE_KEY = "collie:tour:v1";

/** The first-run screen this bundle ships (web/src/lib/tour.ts `TOUR_VERSION`; tour.test.ts keeps them equal). */
export const TOUR_VERSION = 2;

/** Set only when storage refuses the write (private mode, quota): the session still counts it as seen. */
let memory: number | null = null;

/** The version this device last saw, 0 for "never" and for a device that asked to see it again. */
export function readTourSeen(): number {
  if (memory !== null) return memory;
  try {
    const raw = localStorage.getItem(TOUR_STORAGE_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function shouldShowTour(seen: number): boolean {
  return seen < TOUR_VERSION;
}

/** Called from exactly one place: the host, when it OPENS the screen. Never on close. */
export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_STORAGE_KEY, String(TOUR_VERSION));
  } catch {
    memory = TOUR_VERSION;
  }
}

/** Test seam: forget the in-memory fallback. */
export function forgetTourMemory(): void {
  memory = null;
}
