import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// The first-run screen, in a real browser, because the two facts worth proving here are both about
// the ORIGIN rather than about a component: a device that has never run Collie is shown the screen
// once the snapshot lands, and the same device reloaded is not shown it again. Every other `app` spec
// passes unedited because `installApiStub` pre-spends it by default; this one opts out.

test.beforeEach(async ({ page }) => {
  await installApiStub(page, { tour: "fresh" });
});

test("a fresh origin is shown the first-run screen once the first snapshot lands", async ({
  page,
}) => {
  await page.goto("/");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName(en["tour.title"]);
  await expect(dialog.getByRole("button", { name: en["tour.skip"] })).toBeVisible();
  // The six lines are the part that is the same on every install, so they are what a browser case
  // can assert without pinning this fixture's own pane count.
  await expect(dialog.getByText(en["tour.can.mirror"])).toBeVisible();
});

test("the footer button closes it, and a reload does not bring it back", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();

  // Whichever way out this fixture's herd earns — a blocked pane opens that pane, anything else
  // lands on the dashboard. Both leave the screen shut.
  const footer = page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(`${en["tour.done.pane"]}|${en["tour.done.dashboard"]}`) });
  await footer.click();
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.reload();
  // The reload can land on either screen the footer button sent it to. The dashboard has a
  // `<main>` landmark; the pane screen has none, so it waits for the composer textbox instead.
  // Either element only appears once the post-reload snapshot has landed.
  await expect(
    page
      .getByRole("main")
      .or(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
