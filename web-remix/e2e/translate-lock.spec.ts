import { expect, test, type Locator } from "@playwright/test";

import { PANES, stubPaneBridge, TERMINAL_TEXT } from "./pane-api";

// ACTION-PLAN A.1: `translate="no"` sits on the chrome roots only, the surfaces the UI's own locales
// cover (header, strip band, composer block with belt and keys tray, sheets, Settings, the dashboard's
// UI words). It is never on `<html>`, a screen row, a chat block, a pane title or agent output, so a
// reader can still translate what they came to read.

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

/** Whether the element, or any ancestor up to `<html>`, says `translate="no"`. */
async function locked(target: Locator): Promise<boolean> {
  return target.evaluate((node) => node.closest('[translate="no"]') !== null);
}

/** What the browser's translator sees: `translate` inherits, and a `yes` inside a `no` wins. */
async function translatable(target: Locator): Promise<boolean> {
  return target.evaluate((node) => node instanceof HTMLElement && node.translate);
}

test("dashboard: the header and its UI words are locked, the rows and <html> are not", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto("/");
  await expect(page.getByTestId("pane-row").first()).toBeVisible();
  expect(await locked(page.locator('[data-slot="app-header"]'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.getAttribute("translate"))).toBeNull();
  expect(await page.evaluate(() => document.body.closest('[translate="no"]') !== null)).toBe(false);
  expect(await locked(page.getByTestId("summary-line"))).toBe(true);
  expect(await locked(page.getByTestId("tab-bar").or(page.locator('[data-slot="tab-bar"]')).first())).toBe(true);
  const rows = page.getByTestId("pane-row");
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) expect(await locked(rows.nth(i))).toBe(false);
});

test("pane: header and composer block are locked, the pane title, chat blocks and screen rows are not", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));
  await expect(page.getByTestId("pane-title")).toHaveText("fix flaky test");
  const stream = page.getByTestId("chat-stream");
  await expect(stream).toContainText("Fixed: the test now waits for the poll.");

  expect(await locked(page.locator('[data-slot="app-header"]'))).toBe(true);
  expect(await locked(page.locator('[data-slot="chrome-block"]'))).toBe(true);
  expect(await locked(page.locator('[data-slot="strip-band"]'))).toBe(true);
  // The pane's own name is a name, not a UI word: it stays translatable inside the locked header.
  expect(await translatable(page.getByTestId("pane-title"))).toBe(true);
  expect(await translatable(page.getByTestId("pane-place"))).toBe(true);

  const blocks = stream.locator("[data-block]");
  const count = await blocks.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) expect(await locked(blocks.nth(i))).toBe(false);
  expect(await locked(stream)).toBe(false);

  await page.evaluate(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
  await page.reload();
  const screen = page.getByTestId("pane-text");
  await expect(screen).toContainText("Done in 3.1s");
  expect(await locked(screen)).toBe(false);
  const rows = screen.locator("[data-rows] > div, :scope > div");
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);
  for (let i = 0; i < rowCount; i++) expect(await locked(rows.nth(i))).toBe(false);
});

test("a sheet is locked, and so is Settings", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.plain]: "ready\n> " });
  await page.goto(path(PANES.plain));
  await page.getByTestId("header-menu").click();
  const sheet = page.getByTestId("bottom-sheet");
  await expect(sheet).toHaveAttribute("data-state", "open");
  expect(await locked(sheet)).toBe(true);
  await page.goto("/settings");
  await expect(page.getByTestId("route-main")).toBeVisible();
  expect(await locked(page.getByTestId("route-main"))).toBe(true);
});
