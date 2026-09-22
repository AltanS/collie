import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE DASHBOARD'S WORKSPACE FILTER STRIP, measured in a real engine. It is a sideways scroller of
// chips (`components/agent-list.tsx`) and it must scroll sideways ONLY.
//
// On 2026-09-19 it did not. Its scroller overrode `STRIP_SCROLLER`'s `py-1.5` with `py-0`, which
// left a chip's `STRIP_TAP_TARGET` `::before` (the 6px reach that buys the 44px tap floor) with no
// padding to reach into. `overflow-x: auto` forces `overflow-y` to compute to `auto`, so the reach
// became 6px of real vertical scroll: `scrollHeight` 40 against a `clientHeight` of 34, and a drag
// dragged the chips' bottom edge out of a 34px clip box. The belt hit the same thing first
// (`e2e/belt.spec.ts`, `components/actions-row.tsx`), and Chromium hid it while WebKit let a thumb
// nudge it. That is why this case runs under every `app-*` project rather than one.
//
// Selectors are a role and an accessible name, never a class and never a testid.

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
});

const scroller = (page: import("@playwright/test").Page) =>
  page.getByRole("navigation", { name: en["space.strip.title"] }).locator("> div");

test("the filter strip scrolls sideways only, in this engine too", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: en["space.tabStrip.all"] })).toBeVisible();

  const box = await scroller(page).evaluate((el) => {
    el.scrollTop = 20;
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
  });
  expect(box.scrollHeight).toBe(box.clientHeight);
  expect(box.scrollTop).toBe(0);
});

test("the last chip is reachable at the scroll end", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: en["space.tabStrip.all"] })).toBeVisible();

  const edges = await scroller(page).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    const chips = el.querySelectorAll("button");
    const last = chips[chips.length - 1]!.getBoundingClientRect();
    const rail = el.getBoundingClientRect();
    return {
      overflows: el.scrollWidth > el.clientWidth + 1,
      lastLeft: last.left,
      lastRight: last.right,
      railLeft: rail.left,
      railRight: rail.right,
    };
  });
  // A wide viewport fits every chip; the promise only exists when the strip overflows.
  test.skip(!edges.overflows, "every chip fits at this width, nothing scrolls");
  expect(edges.lastRight).toBeLessThanOrEqual(edges.railRight);
  expect(edges.lastLeft).toBeGreaterThan(edges.railLeft);
});
