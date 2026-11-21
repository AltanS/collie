import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE OLD SETTINGS ADDRESSES (ADR 0170). Settings had Appearance, Harness configurations, Device, Alerts, Experiments
// and System; a bookmark, a link in a doc or an old QR still names them. Each opens the page that holds most of what it
// held, keeps the query (the scope, a pairing code) and the fragment, and lets an old fragment pick its row's page.
// The redirect replaces its entry, so Back never lands on an address that only forwards. A real browser, because the
// fragment is what a loader-based redirect loses.

test.use({ serviceWorkers: "block", viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no routes");
  test.skip(testInfo.project.name === "app-tablet", "a phone case; the tablet run would repeat it");
  await installApiStub(page);
});

/** The app address the page is on: path, query and fragment. */
function at(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}${url.hash}`;
}

const CASES = [
  ["/settings/appearance", "/settings/look", en["settings.page.look.title"]],
  ["/settings/appearance/character", "/settings/look/character", en["settings.character.title"]],
  ["/settings/harnesses", "/settings/chat", en["settings.page.chat.title"]],
  ["/settings/device", "/settings/keys", en["settings.page.keys.title"]],
  ["/settings/alerts", "/settings/notifications", en["settings.page.notifications.title"]],
  ["/settings/experiments", "/settings/tricks", en["settings.page.tricks.title"]],
  ["/settings/system", "/settings/devices", en["settings.page.devices.title"]],
  ["/settings/system/install-count", "/settings/privacy/install-count", en["telemetry.card.title"]],
  // An old fragment names its row, and the row picks the page.
  ["/settings/device#changes", "/settings/dashboard#changes", en["settings.page.dashboard.title"]],
  ["/settings/system#paired-devices", "/settings/devices#paired-devices", en["settings.page.devices.title"]],
  // The query rides along: a scope, and the pairing code an old QR carries.
  ["/settings/appearance?h=badger", "/settings/look?h=badger", en["settings.page.look.title"]],
  ["/settings/system?pair=ABCD2345", "/settings/devices?pair=ABCD2345", en["settings.page.devices.title"]],
  // The index with an old fragment: the read-only banner of 1.0 to 1.12, the Changes link before 1.25.
  ["/settings#paired-devices", "/settings/devices#paired-devices", en["settings.page.devices.title"]],
  ["/settings#changes", "/settings/dashboard#changes", en["settings.page.dashboard.title"]],
  // A row's id on an old page opens the page that holds the row now (Tool calls moved from Appearance to Chat).
  ["/settings/appearance#chat.toolCalls", "/settings/chat#chat.toolCalls", en["settings.page.chat.title"]],
] as const;

for (const [from, to, heading] of CASES) {
  test(`${from} opens ${to}`, async ({ page }) => {
    await page.goto(from);
    await expect.poll(() => at(page)).toBe(to);
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
  });
}

test("the redirect replaces its entry: Back from the new page is the screen before, never the old address", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: en["settings.title"], level: 1 })).toBeVisible();
  await page.evaluate(() => {
    history.pushState(null, "", "/settings/appearance");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => at(page)).toBe("/settings/look");
  await page.goBack();
  await expect.poll(() => at(page)).toBe("/settings");
});

test("an old fragment of a row still marks that row on its new page", async ({ page }) => {
  await page.goto("/settings/device#changes");
  await expect.poll(() => at(page)).toBe("/settings/dashboard#changes");
  await expect(page.locator('[data-setting~="dashboard.changes.nested"][data-marked="true"]').first()).toBeVisible();
});

test("on a large screen the index with an old fragment opens that row's page too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings#paired-devices");
  await expect.poll(() => at(page)).toBe("/settings/devices#paired-devices");
  await expect(page.locator('[data-setting~="devices.paired"][data-marked="true"]').first()).toBeVisible();
});
