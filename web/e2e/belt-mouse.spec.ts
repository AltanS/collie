import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE BELT UNDER A MOUSE: a drag and an arrow over each edge that still hides pills (the wheel is in
// wide-layout.spec.ts). Both are for a hovering, fine pointer only; a touch screen keeps the Belt as it was.
// The desktop cases run in the tablet project with touch emulation off (a touch-emulating Chromium reports a
// coarse pointer), at 1440x900. The phone case runs at 390x844 with touch on.

test.use({ serviceWorkers: "block" });

const BELT = '[data-slot="composer-actions"]';
const TRACK = `${BELT} .overflow-x-auto`;
const arrow = (page: Page, side: "left" | "right") => page.locator(`${BELT} [data-slot="scroll-arrow"][data-side="${side}"]`);

/** Make the Belt overflow by about 1700px, as a narrow column with many pills would. */
async function overflowTheBelt(page: Page): Promise<void> {
  await page.locator(TRACK).first().evaluate((el) => {
    const room = document.createElement("div");
    room.style.cssText = "width:2000px;height:8px;flex:none";
    el.append(room);
  });
}

const scrollLeft = (page: Page) => page.locator(TRACK).first().evaluate((el) => el.scrollLeft);

// WHERE THE ARROWS STAND. The right arrow's side touches the scrolling strip's visible right edge, where the
// pinned block's fade ends at its hairline, and the left arrow's touches the strip's left edge. They do not
// float inside the strip over a label, and the fade under each is at least as wide as the arrow.
async function arrowPlaces(page: Page) {
  return page.evaluate(() => {
    const belt = document.querySelector('[data-slot="composer-actions"]')!;
    const track = belt.querySelector(".overflow-x-auto")!;
    const hairline = [...belt.querySelectorAll("span")].find((el) => el.className.includes("w-px"))!;
    const pinnedFade = hairline.parentElement!.previousElementSibling!;
    const right = belt.querySelector('[data-slot="scroll-arrow"][data-side="right"]')?.getBoundingClientRect() ?? null;
    const left = belt.querySelector('[data-slot="scroll-arrow"][data-side="left"]')?.getBoundingClientRect() ?? null;
    const rule = hairline.getBoundingClientRect();
    const firstPinned = [...belt.querySelectorAll("button")].find((b) => b.getBoundingClientRect().left > rule.right);
    return {
      stripLeft: track.getBoundingClientRect().left,
      stripRight: rule.left,
      right: right === null ? null : { left: right.left, right: right.right, width: right.width },
      left: left === null ? null : { left: left.left, right: left.right, width: left.width },
      rightFadeWidth: pinnedFade.getBoundingClientRect().width,
      leftMask: getComputedStyle(track.parentElement!).maskImage,
      firstPinned: firstPinned?.getBoundingClientRect().left ?? null,
    };
  });
}

test.describe("on a desktop window", () => {
  test.use({ hasTouch: false });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "app-tablet", "a desktop case; it needs the large window");
    await installApiStub(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/pane/w1:p1");
    await expect(page.locator(BELT)).toBeVisible();
    await overflowTheBelt(page);
  });

  test("a mouse drag pulls the Belt one to one and fires no pill, and a click without movement still fires one", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") requests.push(`${r.method()} ${r.url()}`);
    });
    const keys = page.locator(BELT).getByRole("button", { name: "Keys", exact: true });
    await expect(keys).toHaveAttribute("aria-expanded", "false");
    const box = (await keys.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 8 });
    await page.mouse.move(x - 200, y, { steps: 8 });
    expect(await page.evaluate(() => document.querySelector("[data-belt-dragging]") !== null)).toBe(true);
    await page.mouse.up();
    expect(await scrollLeft(page)).toBe(200);
    await expect(keys).toHaveAttribute("aria-expanded", "false");
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => document.querySelector("[data-belt-dragging]") !== null)).toBe(false);

    // Back to the start with the left arrow's twin: a drag the other way, then a plain click on the pill.
    await page.locator(TRACK).first().evaluate((el) => {
      el.scrollLeft = 0;
    });
    const again = (await keys.boundingBox())!;
    await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    await expect(keys).toHaveAttribute("aria-expanded", "true");
  });

  test("the right arrow shows at rest, a click scrolls forward and brings the left one, and at the end the right one is gone", async ({ page }) => {
    await expect(arrow(page, "right")).toBeVisible();
    await expect(arrow(page, "right")).toHaveAccessibleName(en["belt.scroll.right"]);
    await expect(arrow(page, "left")).toHaveCount(0);

    // No pill moves when an arrow comes: a pill's place in the Belt's own content is the same before and after.
    const place = () =>
      page.locator(TRACK).first().evaluate((el) => {
        const pill = el.querySelector("button")!.getBoundingClientRect();
        return Math.round(pill.x - el.getBoundingClientRect().x + el.scrollLeft);
      });
    const before = await place();
    await arrow(page, "right").click();
    await expect.poll(() => scrollLeft(page)).toBeGreaterThan(200);
    await expect(arrow(page, "left")).toBeVisible();
    await expect(arrow(page, "left")).toHaveAccessibleName(en["belt.scroll.left"]);
    expect(await place()).toBe(before);

    const arrowBox = (await arrow(page, "right").boundingBox())!;
    const pinned = (await page.locator(BELT).getByRole("button", { name: en["actions.open.aria"], exact: true }).boundingBox())!;
    expect(arrowBox.x + arrowBox.width).toBeLessThanOrEqual(pinned.x);

    await page.locator(TRACK).first().evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(arrow(page, "right")).toHaveCount(0);
    await expect(arrow(page, "left")).toBeVisible();
    await arrow(page, "left").click();
    await expect.poll(() => scrollLeft(page)).toBeLessThan((await page.locator(TRACK).first().evaluate((el) => el.scrollWidth - el.clientWidth)) - 200);
  });

  test("the right arrow stands at the strip's right edge and the left one at its left edge, each over a fade as wide as itself", async ({ page }) => {
    const rest = await arrowPlaces(page);
    expect(rest.right).not.toBeNull();
    expect(Math.abs(rest.right!.right - rest.stripRight)).toBeLessThanOrEqual(2);
    expect(rest.right!.right).toBeLessThanOrEqual(rest.firstPinned!);
    expect(rest.rightFadeWidth).toBeGreaterThanOrEqual(rest.right!.width);

    await page.locator(TRACK).first().evaluate((el) => {
      el.scrollLeft = 300;
    });
    await expect(arrow(page, "left")).toBeVisible();
    const middle = await arrowPlaces(page);
    expect(Math.abs(middle.left!.left - middle.stripLeft)).toBeLessThanOrEqual(2);
    // The left fade is the scroller wrapper's mask, 1.5rem (24px), as wide as the arrow.
    expect(middle.leftMask).toContain("24px");
    expect(middle.left!.width).toBeLessThanOrEqual(24);
  });

  test("the same holds in a narrow pane of a row of three, where the strip is short", async ({ page }) => {
    await page.locator(BELT).evaluate((el) => {
      const column = el.closest<HTMLElement>("section[data-col-key]");
      if (column !== null) column.style.cssText += ";flex:0 0 330px;max-width:330px";
    });
    const rest = await arrowPlaces(page);
    expect(rest.right).not.toBeNull();
    expect(Math.abs(rest.right!.right - rest.stripRight)).toBeLessThanOrEqual(2);
    expect(rest.right!.right).toBeLessThanOrEqual(rest.firstPinned!);
    expect(rest.right!.left).toBeGreaterThan(rest.stripLeft);
  });
});

test.describe("on a touch phone", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "app-phone", "a phone case");
    await installApiStub(page);
  });

  test("the Belt draws no arrow, at 390 and at 360", async ({ page }) => {
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/pane/w1:p1");
      await expect(page.locator(BELT)).toBeVisible();
      await overflowTheBelt(page);
      await expect(page.locator(`${BELT} [data-slot="scroll-arrow"]`)).toHaveCount(0);
      expect(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches)).toBe(false);
    }
  });
});
