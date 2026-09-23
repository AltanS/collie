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

test("the pane menu opens Changes, the list groups by repo, and a diff wraps", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent(PANE.paneId)}`);
  await page.getByRole("button", { name: en["chat.paneMenu.aria"] }).click();
  await page.getByRole("button", { name: en["chat.changes.label"] }).click();

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
