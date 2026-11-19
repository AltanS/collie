import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { SnapshotResponse } from "@/lib/types";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// THE DASHBOARD ON A LARGE SCREEN (ADR 0158): a band of the sessions that need you over a grid of Space
// columns 384px wide, in the expanded width class, with Large-screen layout not Off. A real engine has to
// check what jsdom cannot: the column count the measured scroller gives, no sideways overflow, the last row
// scrolling clear of the New button and the tab bar, and a Space keeping its column while another changes.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  // These cases set their own viewport; the tablet project would run each of them a second time.
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  await installApiStub(page);
});

/** Answer the snapshot with what `make` returns at each poll. */
async function serveWith(page: Page, make: () => SnapshotResponse) {
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(make()) }),
  );
}

async function serve(page: Page, snapshot: SnapshotResponse) {
  await serveWith(page, () => snapshot);
}

const WAITING = { blocked: ["w2:p1", "w7:p1"], unseen: ["w4:p2"] } as const;

/** The columns of the Space grid, read from the grid's own computed tracks. */
async function tracks(page: Page): Promise<number> {
  return page.locator('[data-slot="wide-rows"]').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
}

const spaces = (page: Page) => page.locator("[data-space]");
const band = (page: Page) => page.locator('[data-slot="wide-waiting"]');
const scroller = (page: Page) => page.getByRole("main").locator("xpath=..");

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

test("at 1280 x 800 the Spaces stand in three columns, each 384px wide", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
  await page.goto("/");
  await expect(spaces(page)).toHaveCount(12);
  expect(await tracks(page)).toBe(3);
  const first = await box(spaces(page).nth(0));
  const second = await box(spaces(page).nth(1));
  const third = await box(spaces(page).nth(2));
  const fourth = await box(spaces(page).nth(3));
  expect(first.width).toBe(384);
  expect(second.x - (first.x + first.width)).toBe(24);
  // The first three Spaces share one top edge and the fourth starts the next row, under the first.
  expect(second.y).toBe(first.y);
  expect(third.y).toBe(first.y);
  expect(fourth.x).toBe(first.x);
  expect(fourth.y).toBeGreaterThan(first.y);
});

test("at 1920 x 1080 the Spaces stand in four columns", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
  await page.goto("/");
  await expect(spaces(page)).toHaveCount(12);
  expect(await tracks(page)).toBe(4);
});

test("at 390 x 844 the dashboard is the phone's list, as before", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("button", { name: /needs you/u }).first()).toBeVisible();
  await expect(page.locator('[data-slot="wide-dashboard"]')).toHaveCount(0);
  await expect(band(page)).toHaveCount(0);
  await expect(page.locator('[data-slot="wide-rows"]')).toHaveCount(0);
  // One column, 16px gutters: the first Space heading starts at the phone's gutter.
  const heading = await box(page.getByRole("heading", { name: "space-01" }));
  expect(heading.x).toBe(16);
});

test("Large-screen layout Off keeps the phone's narrow list at 1280", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("collie:wide-layout-mode:v1", "off"));
  await page.setViewportSize({ width: 1280, height: 800 });
  await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "space-01" })).toBeVisible();
  await expect(page.locator('[data-slot="wide-dashboard"]')).toHaveCount(0);
  const column = await box(page.getByRole("main"));
  expect(column.width).toBeLessThanOrEqual(640);
});

for (const [width, height] of [
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`at ${width} x ${height} the page does not scroll sideways and the controls stay inside the grid`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
    await page.goto("/");
    await expect(spaces(page)).toHaveCount(12);
    const over = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
      list: (() => {
        const main = document.querySelector("main")!.parentElement!;
        return main.scrollWidth - main.clientWidth;
      })(),
    }));
    expect(over).toEqual({ page: 0, body: 0, list: 0 });
    // The control row ends at the grid's right edge: the last control is inside the last Space column.
    const grid = await box(page.locator('[data-slot="wide-rows"]').first());
    const filter = await box(page.getByRole("button", { name: new RegExp(en["home.workspaceFilter.all"], "u") }));
    expect(filter.x).toBeGreaterThanOrEqual(grid.x);
    const switchBox = await box(page.getByRole("button", { name: en["home.needsYouOnly"] }));
    expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(grid.x + grid.width + 8);
  });
}

test("the band shows each session that needs you, and each stays in its own Space", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
  await page.goto("/");
  await expect(band(page)).toBeVisible();
  // Two blocked and one unseen, in the list's order: Space 2, Space 4, Space 7.
  await expect(band(page).getByRole("button")).toHaveCount(3);
  const cards = await band(page).getByRole("button").allTextContents();
  expect(cards[0]).toContain("space-02");
  expect(cards[1]).toContain("space-04");
  expect(cards[2]).toContain("space-07");
  // The first card carries the question; the same session also has its row in its Space.
  await expect(band(page).getByText("waiting on you in space-02")).toBeVisible();
  await expect(page.locator('[data-space$="w2"]').getByRole("button", { name: /work in space-02/u }).first()).toBeVisible();
  // The band's card stands on the grid's column edge.
  const card = await box(band(page).getByRole("button").first());
  expect(Math.round(card.x)).toBe(Math.round((await box(spaces(page).first())).x));
  // The band sits above the grid.
  expect((await box(band(page))).y).toBeLessThan((await box(spaces(page).first())).y);
});

test("the band is absent when nothing waits", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serve(page, wideSnapshot({ spaces: 6 }));
  await page.goto("/");
  await expect(spaces(page)).toHaveCount(6);
  await expect(band(page)).toHaveCount(0);
});

test("a cold open draws the band in the first frame, with no entrance", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Record the state of the band's collapse and the grid's top the first time the band exists, on <html>.
  await page.addInitScript(() => {
    let done = false;
    new MutationObserver(() => {
      if (done) return;
      const b = document.querySelector('[data-slot="wide-waiting"]');
      if (b === null) return;
      done = true;
      const grid = document.querySelector('[data-slot="wide-rows"]');
      document.documentElement.dataset.bandFirst = JSON.stringify({
        state: b.closest('[data-slot="collapse"]')?.getAttribute("data-state") ?? null,
        gridTop: grid === null ? null : grid.getBoundingClientRect().top,
      });
    }).observe(document, { childList: true, subtree: true });
  });
  await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
  await page.goto("/");
  await expect(band(page)).toBeVisible();
  const raw = await page.locator("html").getAttribute("data-band-first");
  expect(raw).not.toBeNull();
  const first = JSON.parse(raw ?? "{}");
  expect(first.state).toBe("open");
  // And the grid never moved after that frame.
  const settled = await box(page.locator('[data-slot="wide-rows"]').first());
  expect(first.gridTop).not.toBeNull();
  expect(Math.round(settled.y)).toBe(Math.round(first.gridTop));
});

test("the last Space row scrolls clear of the New button and the tab bar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await serve(page, wideSnapshot({ spaces: 12, ...WAITING }));
  await page.goto("/");
  await expect(spaces(page)).toHaveCount(12);
  await scroller(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const fab = page.locator('[data-slot="fab"]');
  await expect(fab).toBeVisible();
  const f = await box(fab);
  const tabs = await box(page.getByRole("navigation", { name: en["home.tabs.aria"] }));
  expect(f.y + f.height).toBeLessThanOrEqual(tabs.y);
  // The foot of the last Space of the grid is above the button and the bar, in the scroller's own view.
  const last = await box(spaces(page).nth(11));
  expect(last.y + last.height).toBeLessThanOrEqual(f.y);
  expect(last.y + last.height).toBeLessThanOrEqual(tabs.y);
  // The button stands on the grid's right edge.
  const grid = await box(page.locator('[data-slot="wide-rows"]').first());
  expect(Math.abs(f.x + f.width - (grid.x + grid.width))).toBeLessThanOrEqual(1);
});

test("a Space keeps its column when a session in another Space changes state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let calm = true;
  await serveWith(page, () => (calm ? wideSnapshot({ spaces: 12 }) : wideSnapshot({ spaces: 12, ...WAITING })));
  await page.goto("/");
  await expect(spaces(page)).toHaveCount(12);
  await expect(band(page)).toHaveCount(0);
  const x0 = await Promise.all(Array.from({ length: 12 }, (_, i) => box(spaces(page).nth(i)).then((b) => b.x)));
  calm = false;
  // The next poll brings three waiting sessions: the band opens above the grid.
  await expect(band(page)).toBeVisible({ timeout: 20_000 });
  const x1 = await Promise.all(Array.from({ length: 12 }, (_, i) => box(spaces(page).nth(i)).then((b) => b.x)));
  expect(x1).toEqual(x0);
});
