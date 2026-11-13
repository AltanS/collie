// THE CHARACTER HOLDS STILL IN EVERY BROWSER CASE, unless a case is about the motion.
//
// Since the header character drifts at rest whenever the page is visible (`lib/mark-motion.ts`), a page
// that is open asks the engine for a frame at every vsync. WebKit ran multi-page cases 1.5 to 3 times
// slower for exactly that in 1.28.1, and `webkit.yml` went red. The lever is the setting a person has:
// `markMoves: false` in `collie:design:v1` (`DesignPrefs.markMoves`), which holds the mark and changes
// nothing else. It is not `reducedMotion: "reduce"`, which would also switch every transition, glide and
// sheet to its reduced path and so stop the cases that test them from testing what ships.
//
// THREE PLACES USE IT:
//   * the `use.storageState` of `playwright.config.ts`, for every case that takes the `page` or `context`
//     fixture, on each origin the config serves;
//   * a case that writes its own `collie:design:v1` (a theme or a face) spreads {@link STILL_MARK} into
//     it, because its own write replaces the config's;
//   * a case that makes its own context (`browser.newContext`) passes {@link stillMarkState}, because the
//     config's `use` does not reach it.
// The one case that wants the motion is `mark-moves.spec.ts`, which sets the key itself.

import type { BrowserContextOptions } from "@playwright/test";

/** The design blob's field that holds the mark. */
export const STILL_MARK = { markMoves: false } as const;

/** The storage key of the design blob (`lib/design.ts`, held equal by `design.test.ts`). */
export const DESIGN_KEY = "collie:design:v1";

type StorageState = Exclude<NonNullable<BrowserContextOptions["storageState"]>, string>;

/** A storage state that holds the mark on the origin of each URL (a base URL is fine). */
export function stillMarkState(...urls: readonly (string | undefined)[]): StorageState {
  const origins = urls.flatMap((url) => (url === undefined ? [] : [new URL(url).origin]));
  return {
    cookies: [],
    origins: origins.map((origin) => ({ origin, localStorage: [{ name: DESIGN_KEY, value: JSON.stringify(STILL_MARK) }] })),
  };
}
