import { expect, test, type Page } from "@playwright/test";

import { CONFIG, SNAPSHOT, paneBody } from "./fixtures";

// The B1 smoke: the dashboard draws the stub herd by workspace, a row opens its pane IN-PAGE (no
// document load), back returns to the list, and the idle lock covers the app after a shortened
// timeout and lets go on Resume with the tree still mounted.

const IDLE_MS = 1500;

async function stubBridge(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/snapshot") return route.fulfill({ json: SNAPSHOT });
    if (url.pathname === "/api/config") return route.fulfill({ json: CONFIG });
    const pane = /^\/api\/pane\/(.+)$/u.exec(url.pathname);
    if (pane?.[1] !== undefined) return route.fulfill({ json: paneBody(decodeURIComponent(pane[1])) });
    return route.fulfill({ status: 404, json: { error: "not stubbed" } });
  });
}

test.beforeEach(async ({ page }) => {
  await stubBridge(page);
});

test("home draws workspace rows, a row opens its pane in-page, back returns", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");

  const groups = page.getByTestId("workspace-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).getByRole("heading")).toContainText("collie");
  await expect(groups.nth(1).getByRole("heading")).toContainText("website");
  await expect(page.getByTestId("pane-row")).toHaveCount(4);
  await expect(page.getByTestId("summary-line")).toContainText("1");

  // A marker on the window survives an in-page navigation and dies with a document load.
  await page.evaluate(() => {
    Object.assign(window, { __sameDocument: true });
  });
  await page.locator('[data-testid="pane-row"][data-pane-id="w1:p2"]').click();
  await expect(page).toHaveURL(/\/pane\/w1%3Ap2$/u);
  await expect(page.getByTestId("pane-title")).toBeVisible();
  await expect(page.getByTestId("pane-text")).toContainText("stub mirror of w1:p2");
  expect(await page.evaluate(() => "__sameDocument" in window)).toBe(true);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByTestId("workspace-group")).toHaveCount(2);
  expect(await page.evaluate(() => "__sameDocument" in window)).toBe(true);
  expect(errors).toEqual([]);
});

test("the idle lock covers the app after the timeout and Resume recovers it", async ({ page }) => {
  await page.addInitScript((ms) => {
    Object.assign(globalThis, { __collieIdleMs: ms });
  }, IDLE_MS);
  await page.goto("/");
  await expect(page.getByTestId("pane-row")).toHaveCount(4);

  const lock = page.getByTestId("idle-lock");
  await expect(lock).toBeVisible({ timeout: IDLE_MS * 4 });
  await expect(page.locator('[data-slot="app"]')).toHaveAttribute("inert", /.*/u);

  // Polls stop while locked: count snapshot reads for a while and expect none.
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/snapshot")) reads++;
  });
  await page.waitForTimeout(1500);
  expect(reads).toBe(0);

  await lock.getByRole("button").click();
  await expect(lock).toBeHidden();
  await expect(page.locator('[data-slot="app"]')).not.toHaveAttribute("inert", /.*/u);
  expect(reads).toBeGreaterThan(0);
  await page.locator('[data-testid="pane-row"][data-pane-id="w1:p1"]').click();
  await expect(page).toHaveURL(/\/pane\/w1%3Ap1$/u);
});
