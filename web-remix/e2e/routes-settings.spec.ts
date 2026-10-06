import { expect, test, type Page } from "@playwright/test";

import { en } from "@web/lib/i18n/messages/en";
import { asJsonBoolean, asJsonNumber, asJsonObject, parseJsonObject, type JsonObject } from "@web/lib/json";

import { installRoutesApi, type RoutesStub } from "./routes-api";
import { settingsStub, type SettingsStubState } from "./routes-settings-api";

// Wave 4, Settings: the index and every section claim the Shell's header with the override row (the
// ArrowLeft and the h1), back goes UP one level, and the cards read and write what they should. The
// bridge is the stub in routes-settings-api.ts; the service worker is blocked so none can answer for
// another case.

test.use({ serviceWorkers: "block" });

let stub: RoutesStub;
let state: SettingsStubState;
const errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  const settings = settingsStub();
  state = settings.state;
  stub = await installRoutesApi(page, [settings.handler]);
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

/** A stored JSON object, as the pref readers decode it. */
async function stored(page: Page, key: string): Promise<JsonObject> {
  const raw = await page.evaluate((k) => localStorage.getItem(k), key);
  return parseJsonObject(raw ?? "") ?? {};
}

async function expectOverrideHeader(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId("header-back")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
}

test("the index claims the header, and back goes up to the dashboard", async ({ page }) => {
  await page.goto("/settings");
  await expectOverrideHeader(page, en["settings.title"]);
  for (const id of ["appearance", "device", "alerts", "system", "machines"]) {
    await expect(page.getByTestId(`settings-row-${id}`)).toBeVisible();
  }
  // Experiments holds nothing, so its row is absent.
  await expect(page.getByTestId("settings-row-experiments")).toHaveCount(0);
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/$/u);
  // The dashboard is another wave's: all this spec needs is that the index is gone.
  await expect(page.getByTestId("settings-row-appearance")).toHaveCount(0);
});

for (const section of ["appearance", "device", "alerts", "system"] as const) {
  test(`${section} claims the header, and back goes up to the index`, async ({ page }) => {
    await page.goto(`/settings/${section}`);
    await expectOverrideHeader(page, en[`settings.section.${section}.title`]);
    await page.getByTestId("header-back").click();
    await expect(page).toHaveURL(/\/settings$/u);
    await expectOverrideHeader(page, en["settings.title"]);
  });
}

test("the index opens a section as a push and back returns onto the index entry", async ({ page }) => {
  await page.goto("/settings");
  await page.getByTestId("settings-row-alerts").click();
  await expect(page).toHaveURL(/\/settings\/alerts$/u);
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/settings$/u);
  // Up stepped back onto the parent entry, so nothing of ours is behind it: no pushed parent left
  // behind the child for the next edge swipe to walk into.
  expect(await page.evaluate(() => window.navigation.currentEntry?.index)).toBe(0);
});

test("experiments stays routable and says what its contract is", async ({ page }) => {
  await page.goto("/settings/experiments");
  await expectOverrideHeader(page, en["settings.section.experiments.title"]);
  await expect(page.getByText(en["settings.experiments.contract"])).toBeVisible();
});

test("alerts: a notify switch POSTs the single key and the merged view comes back", async ({ page }) => {
  await page.goto("/settings/alerts");
  const card = page.getByTestId("notify-card");
  const done = card.getByRole("switch", { name: en["settings.notify.done.label"] });
  await expect(done).toBeEnabled();
  await expect(done).toHaveAttribute("aria-checked", "false");
  await done.click();
  await expect(done).toHaveAttribute("aria-checked", "true");
  const write = stub.writes().find((c) => c.path === "/api/notifications/prefs");
  expect(write?.body).toEqual({ done: true });
  expect(state.prefs.done).toBe(true);
  // The watched panes are listed under the switches and one can be dropped.
  await expect(page.getByTestId("watched-list").getByRole("listitem")).toHaveCount(2);
  await page.getByRole("button", { name: en["settings.notify.watched.removeAria"].replace("{label}", "build") }).click();
  await expect(page.getByTestId("watched-list").getByRole("listitem")).toHaveCount(1);
  expect(stub.writes().some((c) => c.path === "/api/notifications/cache-watch/forget")).toBe(true);
});

test("alerts: a failed notify write puts the switch back and says why", async ({ page }) => {
  await page.route("**/api/notifications/prefs", async (route) => {
    if (route.request().method() === "POST") return route.fulfill({ status: 500, body: "bridge says no" });
    return route.fallback();
  });
  await page.goto("/settings/alerts");
  const blocked = page.getByTestId("notify-card").getByRole("switch", { name: en["settings.notify.blocked.label"] });
  await expect(blocked).toBeEnabled();
  await blocked.click();
  await expect(blocked).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("bridge says no")).toBeVisible();
});

test("alerts: snooze POSTs a deadline, shows it, and resumes", async ({ page }) => {
  await page.goto("/settings/alerts");
  const card = page.getByTestId("snooze-card");
  await card.getByRole("button", { name: en["settings.snooze.preset.hour1"] }).click();
  await expect(card.getByRole("button", { name: en["settings.snooze.resume"] })).toBeVisible();
  const first = stub.writes().find((c) => c.path === "/api/notifications/snooze");
  expect(asJsonNumber(asJsonObject(first?.body)?.snoozedUntil) ?? 0).toBeGreaterThan(Date.now() + 50 * 60_000);
  await card.getByRole("button", { name: en["settings.snooze.resume"] }).click();
  await expect(card.getByRole("button", { name: en["settings.snooze.preset.hour1"] })).toBeVisible();
  const last = stub.writes().findLast((c) => c.path === "/api/notifications/snooze");
  expect(asJsonObject(last?.body)?.snoozedUntil).toBeNull();
});

test("system: the updates row, the paired devices and the crew card", async ({ page }) => {
  await page.goto("/settings/system");
  await expect(page.getByTestId("updates-row")).toBeVisible();
  // The snapshot names no update block here, so the row reads the plain current line.
  await expect(page.getByTestId("updates-row-status")).toHaveText(en["updates.entry.status.upToDate"]);
  await expect(page.getByTestId("paired-devices")).toBeVisible();
  await expect(page.getByTestId("crew-card")).toBeVisible();
  await expect(page.getByTestId("connection-info")).toContainText(en["settings.connection.bridge.connected"]);
  await page.getByTestId("updates-row").getByRole("button").click();
  await expect(page).toHaveURL(/\/settings\/updates$/u);
  await expectOverrideHeader(page, en["updates.title"]);
  await page.getByTestId("header-back").click();
  await expect(page).toHaveURL(/\/settings\/system$/u);
});

test("system: the crew card opens the crew page, and machines", async ({ page }) => {
  await page.goto("/settings/system");
  await page.getByTestId("crew-card").getByRole("button", { name: en["crew.entry.title"] }).click();
  await expect(page).toHaveURL(/\/crew$/u);
  await expectOverrideHeader(page, en["crew.title"]);
});

test("appearance: the typeface card sets the face on the document and in storage", async ({ page }) => {
  await page.goto("/settings/appearance");
  const select = page.getByTestId("typeface-select");
  await expect(select.locator("option")).toHaveCount(4); // system, grotesk, aldrich, the operator's Fira Sans
  await select.selectOption("grotesk");
  await expect(page.locator("html")).toHaveClass(/font-grotesk/u);
  const face = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-sans"));
  expect(face).toContain("Space Grotesk");
  expect(await page.evaluate(() => localStorage.getItem("collie:design:v1"))).toBe(JSON.stringify({ font: "grotesk" }));
  await select.selectOption("system");
  await expect(page.locator("html")).toHaveClass(/font-system/u);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-sans"))).not.toContain("Space Grotesk");
  // An operator face: the validated row is stored with the choice and its family reaches the variable.
  await select.selectOption("op:fira.woff2");
  await expect(page.locator("html")).toHaveClass(/font-operator/u);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-operator-family"))).toContain("Fira Sans");
});

test("appearance: the terminal font card steps the size and picks a family", async ({ page }) => {
  await page.goto("/settings/appearance");
  const card = page.getByTestId("terminal-font-card");
  const size = card.getByTestId("stepper-value").first();
  await expect(size).toHaveText("10");
  await card.getByRole("button", { name: en["settings.display.textSize.increase"] }).click();
  await expect(size).toHaveText("11");
  await page.getByTestId("terminal-font-select").selectOption("menlo");
  expect(await stored(page, "collie:display-prefs:v4")).toMatchObject({ fontSize: 11, fontFamily: "menlo" });
});

test("appearance: the harness bar switch and the belt size persist under web's keys", async ({ page }) => {
  await page.goto("/settings/appearance");
  await page.getByTestId("harness-bar-card").getByRole("switch").click();
  expect(await page.evaluate(() => localStorage.getItem("collie:harness-bar:v1"))).toBe("0");
  await page.getByTestId("belt-size-card").getByRole("radio", { name: en["settings.beltSize.option.large"], exact: true }).click();
  expect(asJsonNumber((await stored(page, "collie:dash-prefs:v1")).beltScale)).toBe(1.3);
});

test("device: haptics persists, zen's sub-row follows its switch, changes depth is a choice", async ({ page }) => {
  await page.goto("/settings/device");
  await page.getByTestId("haptics-card").getByRole("switch").click();
  expect(await page.evaluate(() => localStorage.getItem("collie:haptics:v1"))).toBe("0");

  const zen = page.getByTestId("zen-card");
  const auto = zen.getByRole("switch", { name: en["settings.zen.auto.label"] });
  await expect(auto).toBeDisabled();
  await zen.getByRole("switch", { name: en["settings.zen.title"] }).click();
  await expect(auto).toBeEnabled();
  await auto.click();
  expect(await page.evaluate(() => [localStorage.getItem("collie:zen-enabled:v1"), localStorage.getItem("collie:auto-zen-enabled:v1")])).toEqual(["1", "1"]);

  const changes = page.getByTestId("changes-card");
  const nested = changes.getByRole("switch", { name: en["settings.changes.nested.label"] });
  // The depth is disabled, not hidden, while nested lookup is off: the stored depth stays visible.
  await nested.click();
  await expect(changes.getByRole("radio").first()).toBeDisabled();
  await nested.click();
  await expect(changes.getByRole("radio").first()).toBeEnabled();
  await changes.getByRole("radio").nth(2).click();
  const dash = await stored(page, "collie:dash-prefs:v1");
  expect(asJsonBoolean(dash.changesNested)).toBe(true);
  expect(asJsonNumber(dash.changesDepth)).toBe(3);
});
