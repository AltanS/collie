import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE COMPOSER'S BELT, measured in a real engine. The belt (`components/actions-row.tsx`) is a
// 32px sideways scroller with a pinned Switch block fading in over its right end. Two of its
// promises are geometry no unit test can see, and one of them was broken in Safari alone:
//
//  * It scrolls sideways ONLY. On 2026-09-14 the belt's harness section reached 6px past the band
//    with a negative margin, and the pills' tap box reached 7px further still. Chromium clipped
//    the overflow; WebKit counted it as scrollable and let a thumb nudge the belt up. The fix made
//    every box inside the scroller fit the band, and this case is the guard: `scrollHeight` equals
//    `clientHeight`, and a `scrollTop` written by hand reads back as 0.
//  * The last pill is reachable. The scroller ends in a spacer as wide as the pinned block, so at
//    `scrollLeft` max the last real pill stops LEFT of the Switch cell's hairline rather than
//    hiding under its fade.
//
// Runs under every `app-*` project, so Chromium and WebKit answer the same questions.

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
});

const BELT = '[data-slot="composer-actions"]';
const SCROLLER = `${BELT} [data-overflow] > div > div`;

test("the belt scrolls sideways only, in this engine too", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toBeVisible();

  const box = await page.locator(SCROLLER).evaluate((el) => {
    el.scrollTop = 20;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
  });
  expect(box.scrollHeight).toBe(box.clientHeight);
  expect(box.scrollTop).toBe(0);
});

test("the last pill stops before the Switch cell at the scroll end", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const switchButton = page.getByRole("button", { name: en["chat.switcher.aria"] });
  await expect(switchButton).toBeVisible();

  const edges = await page.locator(SCROLLER).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    // The scroller's literal last child is the aria-hidden spacer that buys the pinned block its
    // room; the last PILL is the last button in document order.
    const pills = el.querySelectorAll("button");
    const last = pills[pills.length - 1];
    return { overflows: el.scrollWidth > el.clientWidth + 1, lastRight: last?.getBoundingClientRect().right ?? NaN };
  });
  const switchLeft = (await switchButton.boundingBox())?.x ?? NaN;
  // A wide viewport may fit every pill; the promise only exists when the belt overflows.
  test.skip(!edges.overflows, "every pill fits at this width, nothing scrolls");
  expect(edges.lastRight).toBeLessThanOrEqual(switchLeft);
});
