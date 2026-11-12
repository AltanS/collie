import { test } from "@playwright/test";

import { judge } from "@/playground/hitbox/verdict";

import { installScanner, scan } from "./inject";
import { writeKey, type Json } from "./out";
import { SCREENS, setUpWorld } from "./screens";

// THE WIDE LAYOUT, WALKED. The census is a phone's; the large screen (ADR 0120) has its own sidebar, rail and strip
// and wears some of the same primitives (a section heading, the shared Button). This walks a few screens at
// 1280x800 and writes each target's verdict, so a change to a primitive can be compared on both layouts: run it on
// the old build and on the new one and compare `wide:before` with `wide:after`.
//
//     HITBOX_OUT=/tmp/x.json HITBOX_TAG=after bunx playwright test -c e2e/hitbox/playwright.config.ts wide

const TAG = process.env.HITBOX_TAG ?? "after";
const WIDE = ["dashboard", "space", "session-terminal", "session-chat", "settings", "new"];
const out: { [key: string]: Json } = {};

test.describe.configure({ mode: "serial" });

for (const id of WIDE) {
  test(`wide ${id}`, async ({ page }) => {
    const recipe = SCREENS.find((s) => s.id === id);
    if (recipe === undefined) throw new Error(`no screen ${id}`);
    await page.setViewportSize({ width: 1280, height: 800 });
    await installScanner(page);
    await setUpWorld(page, recipe);
    await page.goto(recipe.path ?? "/");
    await page.waitForSelector("#root *", { timeout: 8000 });
    await page.waitForTimeout(1500);
    await recipe.open?.(page);
    await page.waitForTimeout(300);
    const result = await scan(page, { scroll: false });
    const tally = { ok: 0, small: 0, covered: 0, shifts: 0, "dead-time": 0 };
    const flagged: Json[] = [];
    for (const t of result.targets) {
      if (t.pointerEvents === "none") continue;
      const v = judge(t, { shiftPx: null });
      tally[v.verdict] += 1;
      if (v.verdict === "covered") flagged.push({ name: t.name, selector: t.selector, share: t.hitShare, by: t.coveredBy });
    }
    out[id] = { targets: result.targets.length, ...tally, covered: flagged };
  });
}

test.afterAll(() => {
  writeKey(`wide:${TAG}`, out);
});
