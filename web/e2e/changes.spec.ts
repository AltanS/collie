import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureAgents } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// THE CHANGES VIEW ON A SMALL PHONE (ADR 0065). The list and one file's diff at 375x812, the
// narrowest iPhone still sold, in a real engine: jsdom cannot say whether a long diff line wraps or
// pushes the page sideways, and that is the one layout claim this view makes. The API is the
// shared fixture (`src/test/handlers.ts`), routed by `fixtures/api.ts`.

test.use({ serviceWorkers: "block", viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no pane route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const PANE = fixtureAgents[0]!;

/** No box on the page is wider than the viewport: nothing scrolls sideways. */
async function noSidewaysScroll(page: Page) {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.scrollingElement!.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width);
}

// EXPERIMENT (operator, 2026-09-23): the entry is a pill on the belt's pinned block, immediately
// left of the switcher mark, no longer a row in the pane menu.
test("the belt's Changes pill opens Changes, the list groups by repo, and a diff wraps", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}`);
  const pill = page.getByRole("button", { name: en["chat.changes.label"] });
  const switcher = page.getByRole("button", { name: en["chat.switcher.aria"] });
  await expect(pill).toBeVisible();
  const [p, s] = [(await pill.boundingBox())!, (await switcher.boundingBox())!];
  // Same box as the mark, on the same line, directly to its left: 37px square at the belt's default
  // 1.15 scale (it was 32px before the belt scaled, 2026-09-23).
  expect(p.width).toBe(37);
  expect(p.height).toBe(s.height);
  expect(p.y).toBe(s.y);
  expect(p.x + p.width).toBeLessThanOrEqual(s.x);
  expect(s.x - (p.x + p.width)).toBeLessThanOrEqual(8);
  expect(p.height).toBe(37);
  // The pane menu no longer carries it.
  await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: en["chat.changes.label"] })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await pill.click();

  await expect(page).toHaveURL(/\/changes$/);
  await expect(page.getByText("webapp · 3 files")).toBeVisible();
  await expect(page.getByText("api · 2 files")).toBeVisible();
  await noSidewaysScroll(page);

  // Every row is a 44px target.
  const row = page.getByRole("button", { name: /checkout\.tsx/ });
  const box = await row.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await row.click();
  await expect(page).toHaveURL(/\?repo=\.&path=src%2Froutes%2Fcheckout\.tsx$/);
  const long = page.getByText(/including shipping to/);
  await expect(long).toBeVisible();
  // The long line wraps inside the column rather than widening the page.
  const line = await long.boundingBox();
  expect(line!.x + line!.width).toBeLessThanOrEqual(375);
  expect(line!.height).toBeGreaterThan(20);
  await noSidewaysScroll(page);

  const next = page.getByRole("button", { name: en["changes.file.next"] });
  expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await next.click();
  await expect(page.getByText("return items.reduce((sum, item) => sum + item.price, 0);")).toBeVisible();

  // Next replaced the entry, so browser back lands on the list, not on the previous file.
  await page.goBack();
  await expect(page.getByText("webapp · 3 files")).toBeVisible();
  await expect(page).toHaveURL(/\/changes$/);
});

test("a binary file says so and draws no rows", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}/changes?repo=.&path=public%2Flogo.png`);
  await expect(page.getByText(en["changes.file.binary"])).toBeVisible();
  await expect(page.getByRole("button", { name: en["changes.file.prev"] })).toBeEnabled();
});
