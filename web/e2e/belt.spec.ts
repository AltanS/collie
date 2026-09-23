import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE COMPOSER'S BELT, measured in a real engine. The belt (`components/actions-row.tsx`) is a
// sideways scroller, 45px at the default scale, with a pinned Switch block fading in over its right
// end. Two of its promises are geometry no unit test can see, and one was broken in Safari alone:
//
//  * It scrolls sideways ONLY. On 2026-09-14 the belt's harness section reached 6px past the band
//    with a negative margin, and the pills' tap box reached 7px further still. Chromium clipped
//    the overflow; WebKit counted it as scrollable and let a thumb nudge the belt up. The fix made
//    every box inside the scroller fit the band, and this case is the guard: `scrollHeight` equals
//    `clientHeight`, and a `scrollTop` written by hand reads back as 0.
//  * The last pill is reachable. The scroller ends in a spacer as wide as the pinned block plus 16px
//    of air (`BELT_END_AIR`, operator, 2026-09-23), so at `scrollLeft` max the last real pill stops
//    at least 16px LEFT of the pinned block, fade included, rather than hiding under it.
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

test("the last pill stops 16px clear of the pinned block at the scroll end", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const switchButton = page.getByRole("button", { name: en["chat.switcher.aria"] });
  await expect(switchButton).toBeVisible();

  const edges = await page.locator(SCROLLER).evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    // The scroller's literal last child is the aria-hidden spacer that buys the pinned block its
    // room; the last PILL is the last button in document order.
    const pills = el.querySelectorAll("button");
    const last = pills[pills.length - 1];
    // The pinned block is the belt's own direct `<span>` child: its left edge is where the fade starts.
    const block = el.closest('[data-slot="composer-actions"]')!.querySelector(":scope > span")!;
    return {
      overflows: el.scrollWidth > el.clientWidth + 1,
      lastRight: last?.getBoundingClientRect().right ?? NaN,
      blockLeft: block.getBoundingClientRect().left,
    };
  });
  // A wide viewport may fit every pill; the promise only exists when the belt overflows.
  test.skip(!edges.overflows, "every pill fits at this width, nothing scrolls");
  expect(edges.lastRight).toBeLessThanOrEqual(edges.blockLeft - 16);
});

// ONE SCALE FOR THE WHOLE BELT (operator, 2026-09-23). The Settings row "Action belt size" stores
// `beltScale` in the dash prefs; the belt's root carries it as `--belt-scale`, and index.css derives
// band, pill, icon and word from it. Measured at 375x812, the narrowest phone the Changes case uses,
// in Chromium: the band, a pill and its icon at each of the three sizes, every pill answering the
// whole band, and at the largest size the last pill still stopping clear of the pinned block.
test.describe("the belt's size setting", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  const SIZES = [
    { scale: 1.15, band: 45, pill: 37, icon: 18 },
    { scale: 1.3, band: 52, pill: 42, icon: 21 },
    { scale: 1.5, band: 60, pill: 48, icon: 24 },
  ] as const;

  for (const size of SIZES) {
    test(`at scale ${size.scale} the band is ${size.band}px, a pill ${size.pill}px, an icon ${size.icon}px`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== "app-phone", "measured once, in Chromium at phone width");
      await page.addInitScript((beltScale) => {
        localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ beltScale }));
      }, size.scale);
      await page.goto("/pane/w1:p1");
      const switchButton = page.getByRole("button", { name: en["chat.switcher.aria"] });
      await expect(switchButton).toBeVisible();

      const m = await page.locator(SCROLLER).evaluate((el) => {
        const pill = el.querySelector("button")!;
        const icon = pill.querySelector("svg")!;
        const band = el.getBoundingClientRect();
        const p = pill.getBoundingClientRect();
        const i = icon.getBoundingClientRect();
        // The pill's hit box reaches the band's own edges: a probe 1px inside the band's top and
        // bottom, over the pill's middle, lands on the pill.
        const x = p.left + p.width / 2;
        const hit = (y: number) => pill.contains(document.elementFromPoint(x, y));
        return {
          band: band.height,
          pill: p.height,
          icon: [i.width, i.height],
          top: hit(band.top + 1),
          bottom: hit(band.bottom - 1),
          scroll: [el.scrollHeight, el.clientHeight],
        };
      });
      expect(m.band).toBe(size.band);
      expect(m.pill).toBe(size.pill);
      expect(m.icon).toEqual([size.icon, size.icon]);
      expect(m.band).toBeGreaterThanOrEqual(44);
      expect(m.top).toBe(true);
      expect(m.bottom).toBe(true);
      expect(m.scroll[0]).toBe(m.scroll[1]);
      // The pinned mark is square at the pill's own height.
      const s = (await switchButton.boundingBox())!;
      expect(s.width).toBe(size.pill);
      expect(s.height).toBe(size.pill);

      if (size.scale !== 1.5) return;
      const edges = await page.locator(SCROLLER).evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
        const pills = el.querySelectorAll("button");
        const last = pills[pills.length - 1]!;
        const block = el.closest('[data-slot="composer-actions"]')!.querySelector(":scope > span")!;
        return { lastRight: last.getBoundingClientRect().right, blockLeft: block.getBoundingClientRect().left };
      });
      expect(edges.lastRight).toBeLessThanOrEqual(edges.blockLeft - 16);
    });
  }
});

test("a portrait cover display keeps its focused composer when the keyboard shrinks the viewport", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("collie:zen-enabled:v1", "1");
    localStorage.setItem("collie:auto-zen-enabled:v1", "1");
    // Only the viewport shrinks on keyboard opening; the device never rotates.
    Object.defineProperty(screen, "orientation", {
      configurable: true,
      value: { type: "portrait-primary", addEventListener() {}, removeEventListener() {} },
    });
  });
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/pane/w1:p1");
  const box = page.getByRole("textbox", { name: en["composer.placeholder.reply"] });
  await box.focus();

  await page.setViewportSize({ width: 430, height: 360 });

  expect(await page.evaluate(() => matchMedia("(orientation: landscape)").matches)).toBe(true);
  await expect(box).toBeVisible();
  await expect(box).toBeFocused();
  await expect(page.getByRole("button", { name: "Exit zen mode" })).toHaveCount(0);
});
