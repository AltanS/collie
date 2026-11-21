import type { RouteObject } from "react-router";
import { describe, expect, it } from "vitest";

import { NOT_A_SCREEN, SCREENS } from "../e2e/screens/list";

// THE SCREEN LIST KEEPS ITSELF COMPLETE (web/e2e/screens/list.ts). The browser spec that visits every entry is slow and
// has its own set (`E2E_SET=screens`); this file is the cheap half and runs with the normal web suite. It holds the list
// to the router: a screen a person can reach has an entry, and an entry names a route that exists. And it holds two
// numbers that may only go down, the way `scripts/test-file-size.test.ts` holds the size of a test file.

/** Entries that are still the phone's column on a large screen (`wide: "column"`). Lower it when a screen gets its large-screen layout. */
const COLUMN_CEILING = 10;
/** Waivers of a layout rule on an entry. Lower it when a defect is fixed and its waiver goes. */
// 27 since ADR 0168 (2026-11-21): the Remove section of a trick's details page carries the page's own phone-target
// waiver (the trick switch, 44x24, an open item of e2e/hitbox/known.json); its confirm, a modal, needs none.
// 25 since ADR 0171 (2026-11-21): the phone's tab row is 44px with its "+" and its fold, so One Space and the Tab
// strip with long names break no tap target at 390 and their waivers went.
const WAIVER_CEILING = 25;

/** Every path the router can match, as `router.tsx` spells them: no leading slash, "/" for the index. */
function routePaths(routes: readonly RouteObject[], parent = ""): string[] {
  return routes.flatMap((route) => {
    if (route.index === true) return [parent === "" ? "/" : parent];
    const own = (route.path ?? "").replace(/^\/+|\/+$/gu, "");
    const full = [parent, own].filter((part) => part !== "").join("/");
    const children = route.children === undefined ? [] : routePaths(route.children, full);
    // A layout route with no path of its own (the root, "/") draws no screen of its own: its index child is the Dashboard.
    return own === "" ? children : [full, ...children];
  });
}

async function liveRoutes(): Promise<string[]> {
  window.history.replaceState(null, "", "/");
  const { router } = await import("@/router");
  return routePaths(router.routes);
}

describe("the screen list", () => {
  it("has an entry for every route of the router, or the route is on NOT_A_SCREEN with a reason", async () => {
    const covered = new Set([...SCREENS.map((s) => s.route), ...Object.keys(NOT_A_SCREEN)]);
    const missing = (await liveRoutes()).filter((route) => !covered.has(route));
    expect(
      missing,
      `The route ${missing.map((r) => `"${r}"`).join(", ")} has no screen. Add an entry to SCREENS in web/e2e/screens/list.ts with route: "${missing[0] ?? ""}", a path that opens it, and wide set by looking at the 1440x900 shot (when in doubt, "column"). Run it with E2E_SET=screens. A route that draws nothing of its own goes on NOT_A_SCREEN with its reason instead.`,
    ).toEqual([]);
  });

  it("names no route that does not exist, and keeps NOT_A_SCREEN to routes that do", async () => {
    const live = new Set(await liveRoutes());
    const gone = [...new Set([...SCREENS.map((s) => s.route), ...Object.keys(NOT_A_SCREEN)])].filter((route) => !live.has(route));
    expect(gone, `${gone.join(", ")} is not a route of src/router.tsx any more. Remove its entry from web/e2e/screens/list.ts (or its line from NOT_A_SCREEN).`).toEqual([]);
  });

  it("has unique kebab-case ids, a path that matches its route, and an honest width list", () => {
    const ids = SCREENS.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), "ids must be unique: they are the file names of the screenshots").toEqual([]);
    expect(ids.filter((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id))).toEqual([]);
    for (const screen of SCREENS) {
      expect(screen.path.startsWith("/"), `${screen.id}: path must start with a slash`).toBe(true);
      expect(screen.title.trim(), `${screen.id}: a title of a few words`).not.toBe("");
      if (screen.wide === "same") expect((screen.note ?? "").trim(), `${screen.id}: "same" needs a note that says why one layout serves both`).not.toBe("");
      for (const key of Object.keys(screen.waive ?? {})) {
        const [, width] = key.split("@");
        expect(width === undefined || (screen.widths ?? [1440, 390]).includes(Number(width)), `${screen.id}: the waiver ${key} names a width the entry is not opened at`).toBe(true);
      }
    }
  });

  it("gives every waiver a reason", () => {
    for (const screen of SCREENS) {
      for (const [rule, reason] of Object.entries(screen.waive ?? {})) {
        expect((reason ?? "").trim().length, `${screen.id}: the waiver ${rule} needs a reason (FINDING: for a defect that is not fixed yet)`).toBeGreaterThan(8);
      }
    }
  });

  it("holds the number of column screens at its ceiling, which only goes down", () => {
    const columns = SCREENS.filter((s) => s.wide === "column").map((s) => s.id);
    expect(
      columns.length,
      `${String(columns.length)} screens are still the phone's column on a large screen, above the ceiling of ${String(COLUMN_CEILING)}. A new screen must come with its large-screen layout; if it truly cannot yet, say so in review and raise COLUMN_CEILING in src/screens-list.test.ts on purpose.`,
    ).toBeLessThanOrEqual(COLUMN_CEILING);
    expect(columns.length, `The backlog shrank to ${String(columns.length)} column screens. Lower COLUMN_CEILING in src/screens-list.test.ts to ${String(columns.length)} so it cannot grow back unseen.`).toBe(COLUMN_CEILING);
  });

  it("holds the number of waivers at its ceiling, which only goes down", () => {
    const waivers = SCREENS.reduce((n, s) => n + Object.keys(s.waive ?? {}).length, 0);
    expect(
      waivers,
      `${String(waivers)} layout rules are waived, above the ceiling of ${String(WAIVER_CEILING)}. Fix the defect instead; if it must wait, raise WAIVER_CEILING in src/screens-list.test.ts on purpose, with the reason in the waiver.`,
    ).toBeLessThanOrEqual(WAIVER_CEILING);
    expect(waivers, `Waivers are down to ${String(waivers)}. Lower WAIVER_CEILING in src/screens-list.test.ts to ${String(waivers)}.`).toBe(WAIVER_CEILING);
  });
});
