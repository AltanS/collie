import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE LARGE-SCREEN LAYOUT APPEARS ON THE TABLET (ADR 0120). From 600px wide and 480px tall the pane
// screen is a sidebar beside a strip, and the belt's Switch pill is not drawn, because the sidebar is
// the switcher. Large-screen layout set to Off brings the phone pane screen back at the same size.
// `app-tablet` (820x1180) is the one project past that line; the phone pane specs run with Off
// (`fixtures/layout.ts`), so this is where Auto is held to drawing the large-screen layout.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "the large-screen layout starts at 600px wide");
  await installApiStub(page);
});

test("on Auto the pane screen is a sidebar beside a strip, with no Switch pill", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="wide-layout"]')).toBeVisible();
  await expect(page.getByRole("complementary", { name: en["wide.sidebar.label"] })).toBeVisible();
  await expect(page.locator('[data-slot="composer-actions"]')).toBeVisible();
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toHaveCount(0);
});

test("on Off the same window keeps the phone pane screen", async ({ page }) => {
  await keepPhoneLayout(page);
  await page.goto("/pane/w1:p1");
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toBeVisible();
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(0);
});

test("a wide line inside a column never widens the column or the page", async ({ page }) => {
  // 820 less the 320 sidebar leaves 500, under two panes: not wide mode, one column at the strip's width.
  await page.goto("/pane/w1:p1");
  const column = page.locator('[data-slot="wide-layout"] section[data-col-key]').first();
  await expect(column).toBeVisible();
  // A mirror row, a table or a status footer that will not wrap: 2000px of unbreakable text.
  await column.locator('[data-strip-focus]').evaluate((el) => {
    const wide = document.createElement("div");
    wide.style.cssText = "width:2000px;height:8px;flex:none";
    el.prepend(wide);
  });
  const strip = page.locator('[data-slot="wide-layout"] [data-slot="strip"]');
  const widths = await page.evaluate(() => ({
    column: document.querySelector('[data-slot="wide-layout"] section[data-col-key]')!.getBoundingClientRect().width,
    strip: document.querySelector('[data-slot="wide-layout"] [data-slot="strip"]')!.clientWidth,
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(widths.column).toBe(widths.strip);
  expect(widths.page).toBe(widths.view);
  await expect(strip).toBeVisible();
});
