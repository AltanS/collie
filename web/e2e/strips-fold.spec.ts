import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE FOLD OF THE TAB AND PANE ROWS, in a real engine, on the two claims jsdom cannot carry:
// the preference survives a reload of the shipped bundle, and a shrinking visual viewport (what a
// soft keyboard does to the page) moves nothing. The rows used to fold on their own the moment the
// composer's keyboard came up, and come back when it left; the operator read that as a layout
// shift under his eyes and as his choice being undone (2026-10-16). Now the rows are as the last
// tap left them, and the keyboard is not a state of the fold at all.
//
// The keyboard is a viewport resize here: `useKeyboardOpen` watches `visualViewport.height`, and
// Chromium fires its resize event on a window resize too, so 844 to 460 with the composer focused
// is exactly what the hook sees on a phone (-384px, past the 150px threshold).

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no pane route");
  await installApiStub(page);
  // The fold bar is the phone pane screen's; a large-screen strip drops it (ADR 0120).
  await keepPhoneLayout(page);
  // The fixture's shell pane moved into the `code` tab, so the pane row draws too.
  const twoPanes = {
    ...fixtureSnapshot,
    shellPanes: fixtureSnapshot.shellPanes.map((p) => Object.assign({}, p, { tabId: "w2:t1" })),
  };
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(twoPanes) }),
  );
});

const KEY = "collie:strips-collapsed:v1";
const tabNav = (page: Page) => page.getByRole("navigation", { name: en["space.tabStrip.title"] });
const paneNav = (page: Page) => page.getByRole("navigation", { name: en["space.paneStrip.title"] });
const foldButton = (page: Page) => page.getByRole("button", { name: en["chat.strips.hide.both"] });
const summaryBar = (page: Page) => page.getByRole("button", { name: /^Show tabs and panes/ });

async function openPane(page: Page) {
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(tabNav(page)).toBeVisible();
  await expect(paneNav(page)).toBeVisible();
}

/** Where the mirror starts: the first edge under the chrome that a fold would move. */
function mirrorTop(page: Page) {
  return page.locator('div[role="presentation"].border-rule').first().evaluate(
    (el) => Math.round(el.getBoundingClientRect().top),
  );
}

test("a fold is remembered across a reload, and an expand is too", async ({ page }) => {
  await openPane(page);
  await foldButton(page).click();
  await expect(summaryBar(page)).toBeVisible();
  await expect(tabNav(page)).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("1");

  await page.reload();
  await expect(summaryBar(page)).toBeVisible();
  await expect(tabNav(page)).toHaveCount(0);

  await summaryBar(page).click();
  await expect(tabNav(page)).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("0");

  await page.reload();
  await expect(tabNav(page)).toBeVisible();
  await expect(summaryBar(page)).toHaveCount(0);
});

test("the keyboard moves nothing: shown rows stay shown, and the mirror's edge does not move", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "app-tablet", "a phone case; a width change re-baselines the keyboard hook");
  await openPane(page);
  const before = await mirrorTop(page);

  await page.locator('textarea[data-slot="chat-input"]').focus();
  await page.setViewportSize({ width: 390, height: 460 });
  // Past the fold's own 240ms exit and a frame or two more: if the band ever started closing, the
  // rows would be gone by now.
  await page.waitForTimeout(400);
  await expect(tabNav(page)).toBeVisible();
  await expect(paneNav(page)).toBeVisible();
  await expect(summaryBar(page)).toHaveCount(0);
  expect(await mirrorTop(page)).toBe(before);

  // And a fold taken with the keyboard up is a choice like any other: written, and kept when the
  // keyboard closes.
  await foldButton(page).click();
  await expect(summaryBar(page)).toBeVisible();
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await expect(summaryBar(page)).toBeVisible();
  await expect(tabNav(page)).toHaveCount(0);
});
