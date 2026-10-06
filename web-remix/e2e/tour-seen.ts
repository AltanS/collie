// The first-run screen opens on a fresh device (src/tour/), over whatever route the case is about, so
// every Playwright config starts its contexts with the tour already seen: `collie:tour:v1` = "2", web's
// TOUR_VERSION. A case about the tour itself asks for an empty context with
// `test.use({ storageState: FRESH_DEVICE })`.
import type { PlaywrightTestOptions } from "@playwright/test";

type State = Exclude<PlaywrightTestOptions["storageState"], string | undefined>;

/** The storage a device has once it has seen the tour, for the page served at `origin`. */
export function tourSeen(origin: string): State {
  return { cookies: [], origins: [{ origin, localStorage: [{ name: "collie:tour:v1", value: "2" }] }] };
}

/** A device that has never opened Collie. */
export const FRESH_DEVICE: State = { cookies: [], origins: [] };
