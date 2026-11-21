import { mkdirSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// FILES AND CHANGES ON A LARGE SCREEN (ADR 0173). From 900px Files and Changes are two columns
// under one header: the tree or the list of changes on the navigation's recess at the left, the open file at the right.
// jsdom lays nothing out, so a real engine checks that both columns stand inside the window, that a click on a file
// changes the right column and the address and leaves the tree where it was, that Back returns, that the arrows walk the
// tree, the split rule at 1199 and 1200px of column width, and the dashboard's Files view. At 390px the screen is the
// phone's, box for box.
//
// With `WIDE_FILES_SHOTS=<dir>` one more case writes every state at 1440x900 and 1920x1080 into that folder.

test.use({ serviceWorkers: "block" });

const SHOTS = process.env.WIDE_FILES_SHOTS;
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports; one project is enough");
  await installApiStub(page);
});

const PANE = "/pane/w1%3Ap1/changes";

/** The device's Files choice: Changes only (the list) or All files (the tree). */
async function changesOnly(page: Page, on: boolean) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: value }));
  }, on);
}

const left = (page: Page) => page.locator("aside").filter({ has: page.getByRole("tree").or(page.locator("nav")) }).first();
const leftScroll = (page: Page) => left(page).locator("nav");
const right = (page: Page) => page.locator('[data-slot="files-right"]');
const row = (page: Page, path: string) => page.locator(`[data-tree-path="${path}"]`);

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

for (const size of WIDTHS) {
  test(`at ${String(size.width)}px the tree and the file stand side by side, and a click changes the file`, async ({ page }) => {
    await page.setViewportSize(size);
    await changesOnly(page, false);
    await page.goto(`${PANE}/files`);
    await expect(row(page, "src")).toBeVisible();
    await expect(right(page)).toContainText(en["files.nothingChosen"]);

    const a = await box(left(page));
    const b = await box(right(page));
    expect(a.width).toBe(360);
    expect(Math.abs(a.x + a.width - b.x)).toBeLessThanOrEqual(1);
    expect(b.x + b.width).toBeLessThanOrEqual(size.width + 0.5);
    expect(a.y).toBeCloseTo(b.y, 0);
    expect(a.y + a.height).toBeLessThanOrEqual(size.height + 0.5);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(0);

    // The folders open in place: the address stays.
    await row(page, "src").click();
    await row(page, "src/lib").click();
    await expect(page).toHaveURL(/\/changes\/files$/u);

    // The tree is one element for the whole visit, and keeps its scroll across a file.
    await leftScroll(page).evaluate((el) => {
      el.setAttribute("data-e2e-kept", "1");
      el.scrollTop = 12;
    });
    const before = await leftScroll(page).evaluate((el) => el.scrollTop);
    await row(page, "src/lib/cart.ts").click();
    await expect(page).toHaveURL(/path=src%2Flib%2Fcart\.ts/u);
    await expect(row(page, "src/lib/cart.ts")).toHaveAttribute("aria-current", "page");
    await expect(right(page).getByText("cart.ts").first()).toBeVisible();
    await expect(leftScroll(page)).toHaveAttribute("data-e2e-kept", "1");
    expect(await leftScroll(page).evaluate((el) => el.scrollTop)).toBe(before);

    await row(page, "src/cart.ts").click();
    await expect(page).toHaveURL(/path=src%2Fcart\.ts/u);
    // Back returns to the file before, and the folders stay open.
    await page.goBack();
    await expect(page).toHaveURL(/path=src%2Flib%2Fcart\.ts/u);
    await expect(row(page, "src/lib/cart.ts")).toHaveAttribute("aria-current", "page");
  });
}

test("the arrow keys walk the tree", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await changesOnly(page, false);
  await page.goto(`${PANE}/files`);
  await row(page, "src").focus();
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "src")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "src/lib")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(() => document.activeElement?.getAttribute("data-tree-path"));
  expect(second?.startsWith("src/")).toBe(true);
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "src")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "src")).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/changes\/files$/u);
});

test("a diff opens side by side from 1200px of column width, in one column at 1199px, until a choice", async ({ page }) => {
  await changesOnly(page, true);
  const at = `${PANE}?repo=.&path=src%2Froutes%2Fcheckout.tsx`;
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(at);
  await expect(page.locator('[data-slot="diff"]')).toBeVisible();
  const column = await right(page).evaluate((el) => el.clientWidth);
  // The window that gives the column exactly 1200px, and one px less.
  const wide = 1920 - (column - 1200);
  await page.setViewportSize({ width: wide, height: 1080 });
  await expect.poll(() => right(page).evaluate((el) => el.clientWidth)).toBe(1200);
  await expect(page.locator('[data-slot="diff"][data-split]')).toBeVisible();
  await page.setViewportSize({ width: wide - 1, height: 1080 });
  await expect.poll(() => right(page).evaluate((el) => el.clientWidth)).toBe(1199);
  await expect(page.locator('[data-slot="diff"][data-split]')).toHaveCount(0);
  // At 1440 the default is one column; a choice holds there, and after a reload.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-slot="diff"][data-split]')).toHaveCount(0);
  await page.getByRole("radio", { name: en["changes.diffLayout.split"] }).click();
  await expect(page.locator('[data-slot="diff"][data-split]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-slot="diff"][data-split]')).toBeVisible();
  // Previous and Next sit in the file's row; the foot bar is gone.
  await expect(page.getByRole("button", { name: en["changes.file.prev"] })).toHaveCount(1);
  await expect(page.locator('[data-slot="file-steps"]')).toBeVisible();
});

test("the dashboard's Files view is one line a space, at most 720px from the grid's left edge, and scrolls with the page", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const snapshot = wideSnapshot({ spaces: 14 });
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
  await page.goto("/");
  await expect(page.locator("[data-space]").first()).toBeVisible();
  const gridLeft = (await box(page.locator("[data-space]").first())).x;
  await page.evaluate(() => window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ dashView: "changes" })));
  await page.reload();
  const list = page.getByRole("list", { name: en["home.changes.listAria"] });
  await expect(list.getByRole("listitem")).toHaveCount(14);
  const b = await box(list);
  expect(b.width).toBeLessThanOrEqual(720);
  expect(Math.abs(b.x - gridLeft)).toBeLessThanOrEqual(1);
  const select = await box(page.getByRole("button", { name: new RegExp(en["home.workspaceFilter.all"]) }).first());
  expect(select.width).toBeLessThanOrEqual(320);
  // One line a row: the label and the counts share a top edge.
  const first = list.getByRole("listitem").first();
  expect((await box(first)).height).toBeLessThanOrEqual(60);
  // The list scrolls with the page: its last row is below the window until the page scrolls.
  const last = list.getByRole("listitem").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

test("a tree row is 36px with a mouse and 44px with a finger", async ({ browser }, testInfo) => {
  for (const [touch, height] of [
    [false, 36],
    [true, 44],
  ] as const) {
    const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), viewport: { width: 1440, height: 900 }, hasTouch: touch, serviceWorkers: "block" });
    const page = await context.newPage();
    await installApiStub(page);
    await changesOnly(page, false);
    await page.goto(`${PANE}/files`);
    await expect(row(page, "src")).toBeVisible();
    expect((await box(row(page, "src"))).height).toBe(height);
    await context.close();
  }
});

// THE PHONE IS UNCHANGED. The boxes below are the ones `stage/next` drew at 390x844 before this layout (measured on
// c6990e73f): the header, the first file row of the tree, and a diff's Previous / Next bar.
const PHONE_BOXES = {
  header: { x: 0, y: 0, width: 390, height: 61 },
  treeRow: { x: 17, y: 183, width: 356, height: 44 },
  prev: { x: 8, y: 792, width: 137, height: 44 },
} as const;

const round = (b: { x: number; y: number; width: number; height: number } | null) => b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };

test("at 390 x 844 Files and Changes are the phone's, box for box", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await changesOnly(page, false);
  await page.goto(`${PANE}/files`);
  const first = page.getByRole("button", { name: /^docs, folder/ });
  await expect(first).toBeVisible();
  await expect(page.getByRole("tree")).toHaveCount(0);
  expect(round(await page.locator("header").first().boundingBox())).toEqual(PHONE_BOXES.header);
  expect(round(await first.boundingBox())).toEqual(PHONE_BOXES.treeRow);
  await page.goto(`${PANE}?repo=.&path=src%2Froutes%2Fcheckout.tsx`);
  const prev = page.getByRole("button", { name: en["changes.file.prev"] });
  await expect(prev).toBeVisible();
  await expect(page.getByRole("radio", { name: en["changes.diffLayout.split"] })).toHaveCount(0);
  expect(round(await prev.boundingBox())).toEqual(PHONE_BOXES.prev);
});

// ── The shots for a person ──────────────────────────────────────────────────────────────────────────────────────
const SHOT_STATES: { name: string; path: string; only: boolean | null; split?: boolean; spaces?: number }[] = [
  { name: "01-tree-nothing", path: `${PANE}/files`, only: false },
  { name: "02-tree-file", path: `${PANE}/files?path=src%2Fcart.ts`, only: false },
  { name: "03-tree-diff", path: `${PANE}/files?path=src%2Froutes%2Fcheckout.tsx`, only: false },
  { name: "04-changes-list", path: PANE, only: true },
  { name: "05-changes-diff", path: `${PANE}?repo=.&path=src%2Froutes%2Fcheckout.tsx`, only: true },
  { name: "06-changes-split", path: `${PANE}?repo=.&path=src%2Froutes%2Fcheckout.tsx`, only: true, split: true },
  { name: "07-changes-new-file", path: `${PANE}?repo=.&path=src%2Flib%2Fcart.ts`, only: true },
  { name: "08-space-changes", path: "/space/w1/changes", only: true },
  { name: "09-dashboard-files", path: "/", only: null, spaces: 14 },
];

test("shots: every state at 1440x900 and 1920x1080", async ({ browser }, testInfo) => {
  test.skip(SHOTS === undefined, "WIDE_FILES_SHOTS names the folder");
  test.setTimeout(180_000);
  mkdirSync(SHOTS!, { recursive: true });
  for (const size of WIDTHS) {
    for (const state of SHOT_STATES) {
      // A mouse: the project's touch would draw the 44px rows of a touch tablet.
      const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), viewport: size, hasTouch: false, serviceWorkers: "block" });
      const page = await context.newPage();
      await installApiStub(page);
      await page.addInitScript(
        ({ only, split }) => {
          window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify(only === null ? { dashView: "changes" } : { changesOnly: only }));
          if (split) window.localStorage.setItem("collie:diff-layout:v1", "split");
        },
        { only: state.only, split: state.split === true },
      );
      if (state.spaces !== undefined) {
        const snapshot = wideSnapshot({ spaces: state.spaces, blocked: ["w2:p1"], unseen: ["w3:p2"] });
        await page.route(
          (url) => url.pathname === "/api/snapshot",
          (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
        );
      }
      await page.goto(state.path);
      await page.locator('[data-slot="app-header"]').waitFor();
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${SHOTS}/${state.name}-${String(size.width)}.png` });
      await context.close();
    }
  }
});
