import { expect, test, type Page } from "@playwright/test";

import { installApiStub } from "./fixtures/api";

// TWO FINGERS, WITH REAL MULTI-TOUCH (ADR 0121). NOT A GATE. The unit and component tests replay the
// gesture as events; this one drives Chromium's own touch pipeline through CDP
// (`Input.dispatchTouchEvent`), so the hold, the second finger, the swipe and both lifts go through the
// browser's gesture detection as a finger's would. It proves the arm is reached and the commit moves
// the URL, nothing more, and it is no proof for Android Chrome, Safari or a device.
//
// Collected only with `COLLIE_E2E_TOUCH=1` (playwright.config.ts `TOUCH_IGNORE`), Chromium phone only:
//
//     cd web && bunx vite build && COLLIE_E2E_TOUCH=1 bunx playwright test pane-nav.touch --project app-phone
//
// The world is the shared e2e fixture (`fixtures/api.ts`): pane w1:p1 in space w1, and space w2 below
// it, which a swipe down lands on at its first pane, w2:p1.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "a Chromium phone case: CDP touch, one viewport");
  await installApiStub(page);
});

const PANE_A = `/pane/${encodeURIComponent("w1:p1")}`;
const PANE_B = `/pane/${encodeURIComponent("w2:p1")}`;

function at(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

test("hold one finger, land a second and swipe it down: the first finger's lift opens the pane in the next space", async ({ page }) => {
  await page.goto(PANE_A);
  await expect.poll(() => at(page)).toBe(PANE_A);
  const reading = page.locator('[data-slot="pane-reading"]');
  await expect(reading).toBeVisible();
  const box = await reading.boundingBox();
  if (box === null) throw new Error("the reading area has no box");

  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number; id: number }[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ ...p, radiusX: 4, radiusY: 4, force: 1 })) });

  // CDP releases every point at a `touchEnd`, one at a time in id order, and a `touchMove` that lists
  // fewer points releases none. So the first finger takes id 2 and the second id 1: the one `touchEnd`
  // lifts the second finger, then the first, the order a commit needs (found on Chromium 151, 2026-10-25).
  // The first finger, well inside the reading area and clear of the edge zones.
  const one = { x: Math.round(box.x + box.width * 0.3), y: Math.round(box.y + box.height * 0.3), id: 2 };
  await touch("touchStart", [one]);
  await page.waitForTimeout(450);
  // A lone hold shows nothing.
  await expect(page.locator('[data-slot="pane-nav-overlay"]')).toHaveCount(0);

  // The second finger lands: the arm.
  const two = { x: Math.round(box.x + box.width * 0.6), y: Math.round(box.y + box.height * 0.3), id: 1 };
  await touch("touchStart", [one, two]);
  await expect(page.locator('[data-slot="pane-nav-overlay"]')).toHaveCount(1);
  for (let dy = 10; dy <= 60; dy += 10) {
    await touch("touchMove", [one, { ...two, y: two.y + dy }]);
    await page.waitForTimeout(16);
  }
  await expect(page.locator('[data-slot="pane-nav-target-name"]')).toContainText("codex");
  // The second finger lifts, then the first: the commit.
  await touch("touchEnd", []);

  await expect.poll(() => at(page)).toBe(PANE_B);
  await expect(page.locator('[data-slot="pane-nav-overlay"]')).toHaveCount(0);
  // The first arm on this device raised the hint, in the floating group above the belt of the new pane.
  await expect(page.locator('[data-slot="floating-cards"] [data-slot="pane-nav-hint"]')).toBeVisible();
});
