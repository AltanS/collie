import { expect, test, type Page } from "@playwright/test";

import { de } from "@web/lib/i18n/messages/de";
import { en } from "@web/lib/i18n/messages/en";

import { PAIR_CODE, installSettingsApi, type SettingsApi } from "./settings-api";
import { buildId, entryScript, serveBuild } from "./settings-builds";

// Phase B3 in a real browser, against the built bundle: pairing end to end, the QR landing, a
// language switch, the service worker, and a deploy that opens the update sheet.
//
// Every `/api/*` is the stub in settings-api.ts. The settings cases block the service worker, so a
// worker from an earlier case can never answer for this one; the last two cases are the worker's.

const TOKEN_KEY = "collie:device-token";

/** Poll now, as a returning tab does (lib/polling.ts kicks on window focus). */
async function kick(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

/** The worker's scope once it is ready. */
async function registered(page: Page): Promise<string> {
  return page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
}

let api: SettingsApi;

test.beforeEach(async ({ context }) => {
  serveBuild("a");
  api = await installSettingsApi(context);
});

test.describe("settings, worker blocked", () => {
  test.use({ serviceWorkers: "block" });

  test("pair this phone, see it listed as this device, then revoke it", async ({ page }) => {
    await page.goto("/settings/device");
    const card = page.getByTestId("paired-devices");
    await expect(card.getByText(en["settings.devices.description.open"])).toBeVisible();

    await page.getByLabel(en["settings.devices.pair.codeLabel"]).fill(PAIR_CODE.toLowerCase());
    await expect(page.getByLabel(en["settings.devices.pair.codeLabel"])).toHaveValue(PAIR_CODE);
    await page.getByLabel(en["settings.devices.pair.nameLabel"]).fill("test phone");
    await card.getByRole("button", { name: en["settings.devices.pair.title"] }).click();

    // The token lands where lib/api.ts (and web/'s) reads it, under web/'s own key.
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBe("tok-1");
    const row = card.getByTestId("device-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("test phone");
    await expect(row.getByText(en["settings.devices.thisDevice"])).toBeVisible();
    await expect(card.getByText(en["settings.devices.description.enforced"])).toBeVisible();
    await expect(page.getByLabel(en["settings.devices.pair.codeLabel"])).toHaveCount(0);

    // The bootstrap went out with no token; every later read carries the minted one.
    const pair = api.log.find((r) => r.method === "POST" && r.path === "/api/pair");
    expect(pair?.authorization).toBeNull();
    expect(api.log.findLast((r) => r.path === "/api/devices")?.authorization).toBe("Bearer tok-1");

    // Two taps: the second names the consequence, because this is the phone in your hand.
    await row.getByRole("button", { name: en["settings.devices.revokeAria"].replace("{label}", "test phone") }).click();
    await row.getByRole("button", { name: en["settings.devices.unpairSelf"] }).click();

    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
    expect(api.log.find((r) => r.path === "/api/devices/revoke")?.authorization).toBe("Bearer tok-1");
    await expect(card.getByTestId("device-row")).toHaveCount(0);
    await expect(page.getByLabel(en["settings.devices.pair.codeLabel"])).toBeVisible();
  });

  test("a refused code says why, and stores nothing", async ({ page }) => {
    await page.goto("/settings/device");
    await page.getByLabel(en["settings.devices.pair.codeLabel"]).fill("WRONG000");
    await page.getByLabel(en["settings.devices.pair.nameLabel"]).fill("test phone");
    await page.getByTestId("paired-devices").getByRole("button", { name: en["settings.devices.pair.title"] }).click();
    await expect(page.getByText(en["settings.devices.pair.failure.badCode"])).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  });

  test("a scanned pairing link lands on System with the code filled in and the name focused", async ({ page }) => {
    await page.goto("/");
    await page.goto(`/settings?pair=${PAIR_CODE}`);
    await expect(page).toHaveURL(/\/settings\/system\?pair=ABCD2345$/);
    await expect(page.getByLabel(en["settings.devices.pair.codeLabel"])).toHaveValue(PAIR_CODE);
    await expect(page.getByLabel(en["settings.devices.pair.nameLabel"])).toBeFocused();
  });

  test("a language change repaints the screen and persists the pin", async ({ page }) => {
    await page.goto("/settings/appearance");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(en["settings.section.appearance.title"]);
    await page.getByTestId("language-select").selectOption("de");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(de["settings.section.appearance.title"]);
    await expect(page.getByText(de["settings.language.title"], { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("collie:locale:v1"))).toBe("de");
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("de");

    // Another screen, mounted after the change, reads the same store.
    await page.getByRole("button", { name: de["settings.nav.back"] }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(de["settings.title"]);
  });

  test("Updates shows the check read-only", async ({ page }) => {
    await page.goto("/settings/updates");
    const card = page.getByTestId("update-check");
    await expect(card).toContainText("Running v1.17.0");
    await expect(card).toContainText(en["settings.updateCard.upToDate"]);
    expect(api.log.some((r) => r.method !== "GET")).toBe(false);
  });
});

test.describe("service worker and update sheet", () => {
  test.use({ serviceWorkers: "allow" });

  test("the worker registers at the mount and controls the page", async ({ page, baseURL }) => {
    await page.goto("/settings");
    expect(await registered(page)).toBe(`${baseURL ?? ""}/`);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    // The worker precached the shell: the cache list names workbox's precache.
    const caches = await page.evaluate(() => globalThis.caches.keys());
    expect(caches.some((name) => name.includes("precache"))).toBe(true);
  });

  test("a second build opens the update sheet, and Reload lands on it", async ({ page }) => {
    const a = buildId("a");
    const b = buildId("b");
    api.build = a;
    await page.goto("/settings");
    await registered(page);
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
    await expect(page.getByTestId("update-sheet")).toHaveCount(0);

    // The deploy, as the phone sees it first: the header moves while sw.js is unchanged, so nothing
    // can install behind the sheet's back. Two consecutive sightings confirm (build-check.ts).
    api.build = b;
    const sheet = page.getByTestId("update-sheet");
    await expect(async () => {
      await kick(page);
      await expect(sheet).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(sheet.getByRole("heading")).toHaveText(en["pwa.updateAvailable"]);
    await expect(page.getByTestId("update-sheet-server")).toHaveText(b);
    // Modal: focus is inside it.
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-testid=update-sheet]") !== null)).toBe(true);

    // The files land; the tap finds the new worker, follows it, and the swap reloads onto B.
    serveBuild("b");
    await sheet.getByRole("button", { name: en["error.root.reload"] }).click();
    await page.waitForFunction(
      (entry) => document.querySelector(`script[type="module"][src="${entry}"]`) !== null,
      entryScript("b"),
      { timeout: 20_000 },
    );
    // On B, with the bridge stamping B: two more polls, and the sheet stays shut.
    for (const _ of [1, 2]) {
      const polled = page.waitForResponse(/\/api\/snapshot/);
      await kick(page);
      await polled;
    }
    await expect(page.getByTestId("update-sheet")).toHaveCount(0);
  });
});
