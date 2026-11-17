import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// A TAB STAYS WHERE IT WAS TAPPED (operator, 2026-11-17). On the pane screen the tab row scrolls
// sideways when a space holds many tabs. A tap opens another pane, and `DetailRoute` keys the pane
// screen by pane, so the whole screen, tab row included, is built again. The new row started at
// `scrollLeft` 0 and the reveal put the active tab on the right edge: the tapped tab jumped from under
// the finger. The row now remembers its position across that remount (`hooks/use-reveal-active.ts`),
// and a tap on a tab claims the change, so the strip does not scroll for it.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no pane route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case");
  await installApiStub(page);
  await keepPhoneLayout(page);
});

// Sixteen tabs in the space `w2`, each holding one shell pane, so every tab can be opened.
const MANY = 16;
const manyTabs = Array.from({ length: MANY }, (_, i) => ({
  tabId: `w2:x${i}`,
  workspaceId: "w2",
  number: 10 + i,
  label: `tab${i}`,
  focused: false,
  paneCount: 1,
}));
const manySnapshot = {
  ...fixtureSnapshot,
  tabs: [...fixtureSnapshot.tabs, ...manyTabs],
  shellPanes: [
    ...fixtureSnapshot.shellPanes,
    ...manyTabs.map((t, i) => Object.assign({}, fixtureSnapshot.shellPanes[0]!, { paneId: `w2:x${i}p`, tabId: t.tabId })),
  ],
};

const tabRow = (page: Page) => page.getByRole("navigation", { name: en["space.tabStrip.title"] }).locator("> div.overflow-x-auto");
const tabButton = (page: Page, label: string) =>
  page.getByRole("navigation", { name: en["space.tabStrip.title"] }).getByRole("button", { name: new RegExp(`(^| )${label}$`) });

test("a tapped tab stays under the finger and the row does not scroll", async ({ page }) => {
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(manySnapshot) }),
  );
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(tabButton(page, "tab0")).toBeVisible();

  // Scroll the row so a few tabs sit mid-screen, with tabs on both sides out of view.
  await tabRow(page).evaluate((el) => {
    el.scrollLeft = 220;
  });
  await expect.poll(() => tabRow(page).evaluate((el) => el.scrollLeft)).toBeGreaterThan(150);

  const target = tabButton(page, "tab4");
  const beforeScroll = await tabRow(page).evaluate((el) => el.scrollLeft);
  const before = (await target.boundingBox())!;
  expect(before.x).toBeGreaterThan(0);
  expect(before.x + before.width).toBeLessThan(page.viewportSize()!.width);

  await target.tap();
  await expect(page).toHaveURL(/w2%3Ax4p/);
  // Let the remounted row settle, and any (wrong) smooth scroll run its course.
  await page.waitForTimeout(700);

  const after = (await tabButton(page, "tab4").boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((await tabRow(page).evaluate((el) => el.scrollLeft)) - beforeScroll)).toBeLessThanOrEqual(1);
  await expect(tabButton(page, "tab4")).toHaveAttribute("aria-current", "true");
});
