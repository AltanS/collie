import { expect, test, type Page } from "@playwright/test";

import { en } from "@web/lib/i18n/messages/en";

import { changesStub } from "./routes-changes-api";
import { installRoutesApi, type RoutesStub } from "./routes-api";

// Wave 4, Changes and Files: every level of /pane/:id/changes and /space/:id/changes claims the
// Shell's header with the override row (the arrow and the h1), back goes UP one level, and the list,
// the file diff, the commit view, the folder tree and a file of the tree read what the stub bridge
// (routes-changes-api.ts) answers. The service worker is blocked so none can answer for another case.

test.use({ serviceWorkers: "block" });

const errors: string[] = [];
let stub: RoutesStub;

test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** The device's Changes segment on, so the root shows the list of changes and not the folder tree. */
async function changesOnly(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("collie:dash-prefs:v1") === null) {
      window.localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ changesOnly: true }));
    }
  });
}

async function expectOverrideHeader(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("header-back")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
}

test("the list claims the header, and back goes up out of Changes", async ({ page }) => {
  await changesOnly(page);
  stub = await installRoutesApi(page, [changesStub()]);
  await page.goto("/pane/w1:p1/changes");
  await expectOverrideHeader(page, en["files.title"]);
  await expect(page.getByTestId("changes-list")).toBeVisible();
  await expect(page.getByRole("button", { name: /checkout\.tsx/u })).toBeVisible();
  await expect(page.getByRole("button", { name: /cart\.ts/u })).toBeVisible();
  await page.getByTestId("header-back").click();
  await expect(page).not.toHaveURL(/\/changes/u);
});

test("list to file to diff, Next steps sideways, and back returns to the list", async ({ page }) => {
  await changesOnly(page);
  stub = await installRoutesApi(page, [changesStub()]);
  await page.goto("/pane/w1:p1/changes");
  await page.getByRole("button", { name: /checkout\.tsx/u }).click();
  await expect(page).toHaveURL(/changes\?.*repo=\.&path=src%2Froutes%2Fcheckout\.tsx/u);
  await expect(page.locator('[data-slot="diff"]')).toBeVisible();
  await expect(page.locator('[data-row="add"]').first()).toBeVisible();
  await expectOverrideHeader(page, en["files.title"]);
  await page.getByTestId("next-file").click();
  await expect(page).toHaveURL(/path=src%2Flib%2Fcart\.ts/u);
  await expect(page.locator('[data-slot="diff"]')).toContainText("cartTotal");
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/changes$/u);
  await expect(page.getByTestId("changes-list")).toBeVisible();
  // The list was read again on the way in and kept: no skeleton comes back.
  await expect(page.locator('[data-slot="changes-skeleton"]')).toHaveCount(0);
});

test("the commit view of a clean repo, a file of it, and back goes up level by level", async ({ page }) => {
  await changesOnly(page);
  stub = await installRoutesApi(page, [changesStub({ clean: true })]);
  await page.goto("/pane/w1:p1/changes");
  await page.getByTestId("show-commit").click();
  await expect(page).toHaveURL(/\/changes\/commit\?.*repo=\./u);
  await expectOverrideHeader(page, en["changes.commit.title"]);
  await expect(page.getByTestId("commit-view")).toContainText("Move the cart total into its own helper");
  await page.getByRole("button", { name: /cart\.ts/u }).click();
  await expect(page).toHaveURL(/\/changes\/commit\?.*path=src%2Flib%2Fcart\.ts/u);
  await expect(page.locator('[data-slot="diff"]')).toBeVisible();
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/changes\/commit\?repo=\.$/u);
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/changes$/u);
});

test("the folder tree goes down by ?dir= and back goes up one folder at a time", async ({ page }) => {
  stub = await installRoutesApi(page, [changesStub()]);
  await page.goto("/pane/w1:p1/changes");
  await expectOverrideHeader(page, en["files.title"]);
  await expect(page.getByTestId("files-folder")).toBeVisible();
  // The change set marks the folder that holds changes: a count on its row.
  await expect(page.locator('[data-entry="src"] [data-slot="folder-mark"]')).toContainText("2");
  await page.locator('[data-entry="src"]').click();
  await expect(page).toHaveURL(/dir=src$/u);
  await page.locator('[data-entry="routes"]').click();
  await expect(page).toHaveURL(/dir=src%2Froutes$/u);
  await expect(page.locator('[data-entry="checkout.tsx"]')).toBeVisible();
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/dir=src$/u);
  await page.getByTestId("header-back").click();
  await expect(page).not.toHaveURL(/dir=/u);
  await expect(page.locator('[data-entry="README.md"]')).toBeVisible();
});

test("a file under the tree opens on its preview, a changed one on its diff", async ({ page }) => {
  stub = await installRoutesApi(page, [changesStub()]);
  await page.goto("/pane/w1:p1/changes");
  await page.locator('[data-entry="README.md"]').click();
  await expect(page).toHaveURL(/path=README\.md$/u);
  await expect(page.getByTestId("files-file")).toBeVisible();
  await expect(page.locator('[data-slot="file-markdown"]')).toContainText("A small shop");
  await page.getByRole("radio", { name: en["files.view.source"] }).click();
  await expect(page.locator('[data-slot="file-source"]')).toContainText("# Webapp");
  await page.getByTestId("header-back").click();
  await expect(page).not.toHaveURL(/path=/u);

  await page.goto("/pane/w1:p1/changes/files?path=src%2Froutes%2Fcheckout.tsx");
  await expect(page.locator('[data-slot="diff"]')).toBeVisible();
  await page.getByRole("radio", { name: en["files.view.source"] }).click();
  await expect(page.locator('[data-slot="file-source"]')).toContainText("Checkout");
});

test("a space target reads the workspace endpoints and shows the same screen", async ({ page }) => {
  await changesOnly(page);
  stub = await installRoutesApi(page, [changesStub()]);
  await page.goto("/space/w1/changes");
  await expectOverrideHeader(page, en["files.title"]);
  await expect(page.getByRole("button", { name: /checkout\.tsx/u })).toBeVisible();
  expect(stub.calls.some((c) => c.path === "/api/workspace/w1/changes")).toBe(true);
  expect(stub.calls.some((c) => c.path.startsWith("/api/pane/"))).toBe(false);
  await page.getByRole("button", { name: /cart\.ts/u }).click();
  await expect(page).toHaveURL(/\/space\/w1\/changes\?.*path=src%2Flib%2Fcart\.ts/u);
  await expect(page.locator('[data-slot="diff"]')).toBeVisible();
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/space\/w1\/changes$/u);
  await page.goto("/space/w1/changes/files?dir=src");
  await expect(page.locator('[data-entry="lib"]')).toBeVisible();
});
