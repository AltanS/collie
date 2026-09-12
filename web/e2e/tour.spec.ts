import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// The first-launch tour, in a real browser, because the two facts worth proving here are both about
// the ORIGIN rather than about a component: a device that has never run Collie is shown the sheet
// once the snapshot lands, and the same device reloaded is not shown it again. Every other `app` spec
// passes unedited because `installApiStub` pre-spends the tour by default; this one opts out.

test.beforeEach(async ({ page }) => {
  await installApiStub(page, { tour: "fresh" });
});

test("a fresh origin is walked through the tour once the first snapshot lands", async ({ page }) => {
  await page.goto("/");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(en["tour.slide1.title"]);
  await expect(dialog.getByRole("button", { name: en["tour.skip"] })).toBeVisible();
});

test("Start closes it, and a reload does not bring it back", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();

  // Forward to the last slide, then take the primary button, which reads Start there.
  await page.getByRole("button", { name: en["tour.next"] }).click();
  await page.getByRole("button", { name: en["tour.next"] }).click();
  await page.getByRole("button", { name: en["tour.start"] }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
