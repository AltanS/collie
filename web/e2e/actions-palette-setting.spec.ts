import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE ACTIONS PALETTE SWITCH (ADR 0165, addendum 2026-11-20). Settings has one switch, stored on the
// device. On, the Belt's pinned button is Actions and opens the palette. Off, it is the Switch pane
// button again and opens the pane list. 390x844, the phone. The large screen's half is in wide-layout.spec.ts.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "a phone case; the large screen's half is in wide-layout.spec.ts");
  await installApiStub(page);
});

const beltButton = (page: Page, name: string) =>
  page.locator('[data-slot="composer-actions"]').getByRole("button", { name, exact: true });

async function flipSetting(page: Page): Promise<void> {
  await page.goto("/settings/appearance");
  await page.getByRole("switch", { name: en["settings.actionsPalette.title"] }).click();
}

test("off, the Belt's pinned button is Switch pane and opens the pane list; on, it is Actions and opens the palette", async ({ page }) => {
  await flipSetting(page);
  await expect(page.getByRole("switch", { name: en["settings.actionsPalette.title"] })).not.toBeChecked();

  await page.goto("/pane/w1:p1");
  await expect(beltButton(page, en["actions.open.aria"])).toHaveCount(0);
  await beltButton(page, en["chat.switcher.aria"]).click();
  await expect(page.getByRole("dialog", { name: en["chat.switcher.title"] })).toBeVisible();
  await expect(page.getByRole("dialog", { name: en["actions.title"] })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await flipSetting(page);
  await expect(page.getByRole("switch", { name: en["settings.actionsPalette.title"] })).toBeChecked();
  await page.goto("/pane/w1:p1");
  await expect(beltButton(page, en["chat.switcher.aria"])).toHaveCount(0);
  await beltButton(page, en["actions.open.aria"]).click();
  await expect(page.getByRole("dialog", { name: en["actions.title"] })).toBeVisible();
});
