import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import { installHeadWorld, trickNames } from "./fixtures/wide-head";
import { wideSnapshot } from "./fixtures/wide-herd";

// THE LARGE-SCREEN DASHBOARD'S HEADER, COMMAND ROW AND EMPTY STATES (ADR 0158, addendum 2026-11-21). No tab bar at
// the foot: the views, and the tricks' items after them, are a control in a header that spans the window, 48px
// tall like the pane view's top strip; the command row with New is sticky under it; every empty state is one
// column centred both ways. The phone keeps its header, its list and its tab bar to the pixel.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  await installApiStub(page);
});

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

const header = (page: Page) => page.locator('[data-slot="app-header"]');
const views = (page: Page) => page.locator('[data-slot="dashboard-views"]');
const commandRow = (page: Page) => page.locator('[data-slot="wide-command-row"]');
const scroller = (page: Page) => page.locator('[data-slot="home-scroller"]');
const footBar = (page: Page) => page.getByRole("navigation", { name: en["home.tabs.aria"] });
const three = () => wideSnapshot({ spaces: 3, blocked: ["w2:p1"], unseen: ["w3:p2"] });

test("at 1440 x 900 there is no tab bar at the foot, and the header spans the window at 48px", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHeadWorld(page, three());
  await page.goto("/");
  await expect(views(page)).toBeVisible();
  await expect(footBar(page)).toHaveCount(0);
  await expect(page.locator('[data-slot="tab-bar"]')).toHaveCount(0);
  const h = await box(header(page));
  expect(h.x).toBe(0);
  expect(h.width).toBe(1440);
  expect(h.height).toBe(48 + 1);
  // The mark's drawing stands on the grid's left edge, the first card's.
  const first = await box(page.locator("[data-space]").first());
  const row = await box(page.locator('[data-slot="header-row"]'));
  expect(Math.abs(row.x + 24 - first.x)).toBeLessThanOrEqual(1);
});

for (const [lines, mux] of [
  ["one line", undefined],
  ["two lines", "Herdr"],
] as const) {
  test(`the identity beside the mark, ${lines}, is centred on the header's middle and inside its box`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    if (mux !== undefined) {
      await page.route(
        (url) => url.pathname === "/api/config",
        (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ push: false, vapidPublicKey: "", mux: { name: mux } }) }),
      );
    }
    await installHeadWorld(page, three());
    await page.goto("/");
    const identity = page.locator('[data-slot="header-identity"]');
    await expect(identity).toBeVisible();
    if (mux !== undefined) await expect(identity).toContainText(mux);
    else await expect(identity).toHaveText("Collie");
    // The ink, not the box: the block's first and last text lines as the engine lays them out.
    const ink = await identity.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((r) => r.height > 0);
      return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    });
    const h = await box(header(page));
    const block = await box(identity);
    // The header's box less its 1px edge underneath.
    const middle = h.y + (h.height - 1) / 2;
    expect(Math.abs(block.y + block.height / 2 - middle)).toBeLessThanOrEqual(1);
    expect(block.y).toBeGreaterThanOrEqual(h.y);
    expect(block.y + block.height).toBeLessThanOrEqual(h.y + h.height - 1);
    expect(ink.top - h.y).toBeGreaterThanOrEqual(4);
    expect(h.y + h.height - 1 - ink.bottom).toBeGreaterThanOrEqual(4);
  });
}

test("the views control switches the view by mouse and by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHeadWorld(page, three());
  await page.goto("/");
  const tabs = views(page).getByRole("tablist", { name: en["home.tabs.aria"] });
  const dash = tabs.getByRole("tab", { name: new RegExp(`^${en["home.tabs.dashboard"]}`, "u") });
  const files = tabs.getByRole("tab", { name: en["files.title"] });
  await expect(dash).toHaveAttribute("aria-selected", "true");
  // The blocked count rides on the Dashboard segment as a number.
  await expect(dash.locator('[data-slot="segmented-badge"]')).toHaveText("1");
  await files.click();
  await expect(files).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-space]")).toHaveCount(0);
  await expect(commandRow(page)).toHaveCount(0);
  // Back by keyboard: focus the Dashboard segment and press Enter.
  await dash.focus();
  await page.keyboard.press("Enter");
  await expect(dash).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-space]")).toHaveCount(3);
  // And Space on the Files segment.
  await files.focus();
  await page.keyboard.press(" ");
  await expect(files).toHaveAttribute("aria-selected", "true");
});

for (const [state, arrange] of [
  [
    "not paired",
    (page: Page) =>
      page.route((url) => url.pathname === "/api/snapshot", (route) => route.fulfill({ status: 403, contentType: "text/plain", body: "device not paired" })),
  ],
  ["paired with no Spaces", (page: Page) => installHeadWorld(page, wideSnapshot({ spaces: 0 }))],
] as const) {
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
  ] as const) {
    test(`${state} at ${width}: one column centred both ways within 1px, with nothing beside it`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await arrange(page);
      await page.goto("/");
      const main = page.getByRole("main");
      const block =
        state === "not paired"
          ? main.locator("div", { has: page.getByText(en["settings.devices.pair.title"], { exact: true }) }).last()
          : main.getByRole("button", { name: new RegExp(en["newPage.first.title"], "u") });
      await expect(block).toBeVisible();
      await expect(page.getByText(en["space.readOnly.notPaired"])).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Spaces/u })).toHaveCount(0);
      await expect(page.locator('[data-slot="fab"]')).toHaveCount(0);
      const b = await box(block);
      const m = await box(main);
      expect(Math.abs(b.x + b.width / 2 - width / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(b.y + b.height / 2 - (m.y + m.height / 2))).toBeLessThanOrEqual(1);
    });
  }
}

test("the command row stays under the header while the grid scrolls, and New stays in reach", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHeadWorld(page, wideSnapshot({ spaces: 14, blocked: ["w2:p1"] }));
  await page.goto("/");
  await expect(page.locator("[data-space]")).toHaveCount(14);
  const h = await box(header(page));
  const before = await box(commandRow(page));
  await scroller(page).evaluate((el) => el.scrollTo(0, 400));
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
  const after = await box(commandRow(page));
  expect(after.y).toBe(h.y + h.height);
  expect(after.y).toBeLessThanOrEqual(before.y);
  await expect(commandRow(page).getByRole("button", { name: en["home.new.label"] })).toBeInViewport();
});

test("a row brought into view by keyboard focus stops below the command row, its focus ring clear", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHeadWorld(page, wideSnapshot({ spaces: 14 }));
  await page.goto("/");
  await expect(page.locator("[data-space]")).toHaveCount(14);
  // Scroll past the first Spaces, then move focus back to a row above the view, as Shift+Tab would.
  await scroller(page).evaluate((el) => el.scrollTo(0, 1200));
  const row = page.locator('[data-space$="w1"]').getByRole("button", { name: /work in space-01/u }).first();
  await row.focus();
  const r = await box(row);
  const c = await box(commandRow(page));
  // The ring is 2px outside the row with a 2px offset: the row's top must clear the row's foot by 4px.
  expect(r.y - 4).toBeGreaterThanOrEqual(c.y + c.height - 0.5);
});

test("with a short list the command row does not move", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHeadWorld(page, wideSnapshot({ spaces: 1 }));
  await page.goto("/");
  await expect(page.locator("[data-space]")).toHaveCount(1);
  const a = await box(commandRow(page));
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(200);
  const b = await box(commandRow(page));
  expect(b.y).toBe(a.y);
});

test("the Hill is an icon button with its count in the header's right cluster", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHeadWorld(page, three(), { hill: 3 });
  await page.goto("/");
  const hill = page.locator('[data-slot="header-hill"]');
  await expect(hill).toBeVisible();
  await expect(hill).toHaveAccessibleName(new RegExp(`^${en["hill.title"]}`, "u"));
  await expect(hill).toContainText("3");
  await hill.click();
  await expect(page).toHaveURL(/\/hill/u);
});

test("two trick items go last in the views control, each with its glyph and its name", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installHeadWorld(page, three(), { tricks: 2 });
  await page.goto("/");
  const items = views(page).locator('[data-slot="views-trick"]');
  await expect(items).toHaveCount(2);
  for (const [n, name] of trickNames(2).entries()) {
    await expect(items.nth(n)).toHaveText(name);
    await expect(items.nth(n).locator("svg")).toHaveCount(1);
  }
  // After the views: the first item starts where the last view ends (they share one edge).
  const lastView = await box(views(page).getByRole("tab").last());
  const firstItem = await box(items.first());
  expect(Math.abs(firstItem.x - (lastView.x + lastView.width - 1))).toBeLessThanOrEqual(1);
  await expect(views(page)).not.toHaveAttribute("data-short");
});

test("six trick items: first the names give way, then the row scrolls; the views keep their words", async ({ page }) => {
  await installHeadWorld(page, three(), { tricks: 6 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const items = views(page).locator('[data-slot="views-trick"]');
  await expect(items).toHaveCount(6);
  await expect(views(page)).not.toHaveAttribute("data-short");

  // Narrower: no room for the names. Each item is its glyph, its name the tooltip and the accessible name.
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(views(page)).toHaveAttribute("data-short", "");
  await expect(items.first()).toHaveText("");
  await expect(items.first()).toHaveAttribute("title", "Deploys");
  await expect(items.first()).toHaveAccessibleName(/Deploys/u);
  await expect(views(page).getByRole("tab", { name: en["files.title"] })).toHaveText(en["files.title"]);

  // Narrower still: the row scrolls inside its own box and never runs under the identity or the right cluster.
  await page.setViewportSize({ width: 940, height: 800 });
  await expect.poll(() => views(page).evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0);
  const v = await box(views(page));
  const id = await box(page.locator('[data-slot="header-identity"]'));
  const right = await box(page.locator('[data-slot="header-right"]'));
  expect(v.x).toBeGreaterThanOrEqual(id.x + id.width);
  expect(v.x + v.width).toBeLessThanOrEqual(right.x);
  await expect(views(page).getByRole("tab", { name: new RegExp(`^${en["home.tabs.dashboard"]}`, "u") })).toContainText(en["home.tabs.dashboard"]);

  // Wide again: the names come back.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(views(page)).not.toHaveAttribute("data-short");
  await expect(items.first()).toHaveText("Deploys");
});

// The phone's boxes at 390 x 844, read from a build of `stage/next` (4566a69a0) with this same world. They must not
// move by a pixel.
const PHONE_BOXES = {
  header: { x: 0, y: 0, width: 390, height: 61 },
  firstHeading: { x: 16, y: 243, width: 252, height: 20 },
  tabBar: { x: 0, y: 788, width: 390, height: 56 },
};

test("the phone at 390 x 844 keeps its header, its list and its tab bar where stage/next drew them", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installHeadWorld(page, three(), { hill: 3, tricks: 2 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "space-01" })).toBeVisible();
  await page.waitForTimeout(800);
  const read = async (l: Locator) => {
    const b = await box(l);
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  };
  const got = {
    header: await read(header(page)),
    firstHeading: await read(page.getByRole("heading", { name: "space-01" })),
    tabBar: await read(page.locator('[data-slot="tab-bar"]')),
  };
  if (process.env.WIDE_HEAD_MEASURE !== undefined) console.log(`PHONE_BOXES ${JSON.stringify(got)}`);
  expect(got).toEqual(PHONE_BOXES);
  await expect(views(page)).toHaveCount(0);
  await expect(page.locator('[data-slot="fab"]')).toBeVisible();
});
