import { expect, test, type Page } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// OPEN THIS SPACE (`open_space`). From a pane, the prefix and `o` go to the overview of the space the pane is in. On a
// large screen the space has no page (ADR 0173), so the overview is the Dashboard, landed on that space: its column in
// view and the focus on its first row. The space's name in the bar is a button that does the same, and it moves
// nothing around it. On a phone the same keys open the space's page.

test.use({ serviceWorkers: "block" });

const ROW = '[id^="pane-row-"]';
// A space's column, found by its heading (the key of `data-space` holds NUL characters, which a selector cannot carry).
const SPACE = (page: Page, label: string) => page.locator("section[data-space]", { hasText: label });

test.beforeEach(async ({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "sets its own viewport; one project is enough");
});

async function open(page: Page, size: { width: number; height: number }, pane: string, spaces = 3): Promise<void> {
  await page.setViewportSize(size);
  await installApiStub(page);
  const snapshot = wideSnapshot({ spaces });
  await page.route("**/api/snapshot", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }));
  await page.goto(`/pane/${encodeURIComponent(pane)}`);
  // The pane has loaded when its space's door is there: the name in the bar, or the phone's own door.
  await expect(page.locator(size.width >= 900 ? '[data-slot="space-title-door"]' : '[data-slot="pane-identity"]').first()).toBeVisible();
}

async function expectLanded(page: Page, label: string, fromKeys = true): Promise<void> {
  await expect(page).toHaveURL(/\/(\?.*)?$/u);
  const column = SPACE(page, label);
  await expect(column).toBeVisible();
  const first = column.locator(ROW).first();
  // The focus is on the column's first row, and from the keys it wears the ring a keyboard gives (a mouse click
  // leaves no ring on a focus the page sets, as everywhere else).
  await expect(first).toBeFocused();
  if (fromKeys) expect(await first.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  // The row stands in the list's own box, below the sticky command row, not under it or under the window's edge.
  const m = await first.evaluate((el) => {
    const scroller = document.querySelector('[data-slot="home-scroller"]')!.getBoundingClientRect();
    const command = document.querySelector('[data-slot="wide-command-row"]')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, floor: Math.max(scroller.top, command.bottom), ceiling: scroller.bottom };
  });
  expect(m.top).toBeGreaterThanOrEqual(m.floor - 1);
  expect(m.bottom).toBeLessThanOrEqual(m.ceiling + 1);
}

test("at 1440px the prefix and o land the Dashboard on the pane's space", async ({ page }) => {
  await open(page, { width: 1440, height: 900 }, "w2:p1");
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveAttribute("data-width-class", "expanded");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("o");
  await expectLanded(page, "space-02");
  // Nothing else was drawn at: all three spaces stand, and the Dashboard kept its sort.
  await expect(page.locator("[data-space]")).toHaveCount(3);
});

test("at 1440px the landing is an up: from a pane opened on the Dashboard it steps back there, and Forward returns to the pane", async ({ page }) => {
  await open(page, { width: 1440, height: 900 }, "w1:p1");
  // Opened from the Dashboard: a pane of the second space, by a tap on its row.
  await page.goto("/");
  await SPACE(page, "space-02").locator(ROW).first().click();
  await expect(page).toHaveURL(/\/pane\/w2/u);
  await expect(page.locator('[data-slot="space-title-door"]')).toBeVisible();
  const entries = await page.evaluate(() => history.length);
  await page.keyboard.press("Control+b");
  await page.keyboard.press("o");
  await expectLanded(page, "space-02");
  // No entry was added: the pane never stays under its own overview (ADR 0067), as the phone's door does it.
  expect(await page.evaluate(() => history.length)).toBe(entries);
  await page.goForward();
  await expect(page).toHaveURL(/\/pane\/w2/u);
});

test("at 1440px a space below the fold is scrolled into view and its first row is focused", async ({ page }) => {
  await open(page, { width: 1440, height: 560 }, "w8:p1", 9);
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveAttribute("data-width-class", "expanded");
  // The Dashboard opens on the top of the list, with this space's column out of sight below the window's foot.
  expect(await page.evaluate(() => innerHeight)).toBe(560);
  await page.keyboard.press("Control+b");
  await page.keyboard.press("o");
  await expectLanded(page, "space-08");
  expect(await SPACE(page, "space-08").evaluate((el) => document.querySelector('[data-slot="home-scroller"]')!.scrollTop > 0 && el.getBoundingClientRect().top > 0)).toBe(true);
});

test("at 1440px a click on the space's name does the same", async ({ page }) => {
  await open(page, { width: 1440, height: 900 }, "w2:p2");
  const door = page.locator('[data-slot="space-header"]').getByRole("button", { name: "Open space-02 overview" });
  await expect(door).toBeVisible();
  await door.click();
  await expectLanded(page, "space-02", false);
});

test("the name's button leaves the bar as it was: the tabs stand where they stood", async ({ page }) => {
  await open(page, { width: 1440, height: 900 }, "w2:p1");
  const m = await page.evaluate(() => {
    const title = document.querySelector('[data-slot="space-title"]')!.getBoundingClientRect();
    const name = document.querySelector('[data-slot="space-title-name"]')!.getBoundingClientRect();
    const door = document.querySelector('[data-slot="space-title-door"]')!.getBoundingClientRect();
    const nav = document.querySelector('[data-slot="space-header"] nav')!.getBoundingClientRect();
    return { titleLeft: title.left, titleRight: title.right, nameRight: name.right, doorLeft: door.left, doorRight: door.right, navLeft: nav.left };
  });
  // The title is as wide as its text, the button reaches 10px past it on each side, and the tabs start 12px after the text.
  expect(m.titleRight).toBeCloseTo(m.nameRight, 1);
  expect(m.doorLeft).toBeCloseTo(m.titleLeft - 10, 1);
  expect(m.doorRight).toBeCloseTo(m.titleRight + 10, 1);
  expect(m.navLeft).toBeCloseTo(m.titleRight + 12, 1);
});

test("while the prefix waits, the name's button wears the key and the cap covers none of its letters", async ({ page }) => {
  await open(page, { width: 1440, height: 900 }, "w2:p1");
  await page.keyboard.press("Control+b");
  const cap = page.locator('[data-slot="shortcut-hint"][data-action="open_space"]');
  await expect(cap).toHaveText("o");
  const clash = await page.evaluate(() => {
    const capBox = document.querySelector('[data-slot="shortcut-hint"][data-action="open_space"]')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-slot="space-title-name"]')!);
    return [...range.getClientRects()].some((r) => capBox.left < r.right && capBox.right > r.left && capBox.top < r.bottom && capBox.bottom > r.top);
  });
  expect(clash).toBe(false);
});

test("at 390px the same keys open the space's own page", async ({ page }) => {
  await open(page, { width: 390, height: 844 }, "w2:p1");
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(0);
  await page.keyboard.press("Control+b");
  await page.keyboard.press("o");
  await expect(page).toHaveURL(/\/space\/w2/u);
});
