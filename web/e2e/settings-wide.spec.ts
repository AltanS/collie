import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub, pinLocale } from "./fixtures/api";
import { stillMarkState } from "./fixtures/still-mark";
import type { Screen } from "./screens/list";
import { installScreenStubs, SETUPS } from "./screens/setups";

// SETTINGS ON A LARGE SCREEN (components/settings-shell.tsx, ADR 0158 addendum 2026-11-21). From 900px the list of
// sections stands at the window's left edge on the navigation's recess and the chosen section beside it, under one
// header that spans the window. jsdom lays nothing out, so a real engine checks that the two stand side by side inside
// the window, that a row changes the column and the address and leaves the list where it was, that Back returns to the
// section before, that the arrows walk the list, and that a deep page names its path. At 390px the page is the phone's.
//
// With `SETTINGS_SHOTS=<dir>` one more case writes every section at 1440x900 into that folder, for a person to look at.

test.use({ serviceWorkers: "block" });

const SHOTS = process.env.SETTINGS_SHOTS;
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

function onlyOnce(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports and input; one project is enough");
}

/** A page at `size`, with a mouse, the fixtures and the stubs the screen list uses. */
async function openAt(browser: Browser, testInfo: TestInfo, size: { width: number; height: number }, touch = false): Promise<Page> {
  const baseURL = String(testInfo.project.use.baseURL);
  const context = await browser.newContext({ baseURL, viewport: size, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1, serviceWorkers: "block", storageState: stillMarkState(baseURL) });
  const page = await context.newPage();
  await pinLocale(page, "en");
  await installApiStub(page);
  await installScreenStubs(page);
  return page;
}

/** Open `path` in one of the screen list's worlds (`tricks`, `accounts`). */
async function openIn(page: Page, setup: "tricks" | "accounts", path: string): Promise<void> {
  const screen: Screen = { id: "settings-wide", route: "settings", path, title: "Settings on a large screen", wide: "designed" };
  await SETUPS[setup](page, screen);
}

const list = (page: Page) => page.locator('[data-slot="settings-list"]');
const column = (page: Page) => page.locator('[data-slot="settings-section"]');
const row = (page: Page, id: string) => page.locator(`[data-settings-row="${id}"]`);
const title = (page: Page) => column(page).locator("h1").first();

for (const size of WIDTHS) {
  test(`at ${String(size.width)}px the list and the section stand side by side, and a row changes the section`, async ({ browser }, testInfo) => {
    onlyOnce(testInfo);
    test.setTimeout(90_000);
    const page = await openAt(browser, testInfo, size);
    try {
      await page.goto("/");
      await page.waitForSelector("#root *");
      await page.goto("/settings");
      await expect(page).toHaveURL(/\/settings\/appearance$/u);
      await expect(row(page, "appearance")).toHaveAttribute("aria-current", "page");

      const a = (await list(page).boundingBox())!;
      const b = (await column(page).boundingBox())!;
      expect(a.x).toBe(0);
      expect(Math.abs(a.x + a.width - b.x)).toBeLessThanOrEqual(1);
      expect(b.x + b.width).toBeLessThanOrEqual(size.width + 0.5);
      expect(a.y).toBeCloseTo(b.y, 0);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(sideways).toBeLessThanOrEqual(0);

      // The list is one element for the whole visit: a mark on it survives every row, and so does its scroll.
      await list(page).evaluate((el) => {
        el.setAttribute("data-e2e-kept", "1");
        el.scrollTop = 24;
      });
      const before = await list(page).evaluate((el) => el.scrollTop);
      const ids = await page.locator("[data-settings-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-settings-row") ?? ""));
      for (const id of ids.filter((each) => each !== "machines")) {
        await row(page, id).click();
        await expect(page).toHaveURL(new RegExp(`/settings/${id}$`, "u"));
        await expect(row(page, id)).toHaveAttribute("aria-current", "page");
        await expect(title(page)).toBeVisible();
        await expect(list(page)).toHaveAttribute("data-e2e-kept", "1");
        expect(await list(page).evaluate((el) => el.scrollTop)).toBe(before);
      }

      // The browser's Back returns to the section before.
      await row(page, "device").click();
      await expect(page).toHaveURL(/\/settings\/device$/u);
      await row(page, "voice").click();
      await expect(page).toHaveURL(/\/settings\/voice$/u);
      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/device$/u);
      await expect(row(page, "device")).toHaveAttribute("aria-current", "page");
      await expect(title(page)).toHaveText("Device");

      // The header's Back leaves Settings for where it was opened from, past every section walked through.
      await page.getByRole("banner").getByRole("button", { name: en["settings.nav.back"] }).click();
      await expect(page).toHaveURL(/\/$/u);
    } finally {
      await page.context().close();
    }
  });
}

test("the arrow keys walk the list, Enter opens a row and the section's title takes the focus", async ({ browser }, testInfo) => {
  onlyOnce(testInfo);
  const page = await openAt(browser, testInfo, WIDTHS[0]);
  try {
    await page.goto("/settings/device");
    await expect(row(page, "device")).toHaveAttribute("tabindex", "0");
    await row(page, "device").focus();
    await page.keyboard.press("ArrowDown");
    await expect(row(page, "voice")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("[data-settings-row]:focus")).toHaveAttribute("data-settings-row", /^(harnesses|accounts)$/u);
    await page.keyboard.press("Home");
    await expect(row(page, "updates")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/appearance$/u);
    await expect(title(page)).toBeFocused();
    // One tab stop: Tab from the chosen row leaves the list.
    await row(page, "appearance").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("[data-settings-row]:focus")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("a trick's details name their path in the header, and Back beside the title goes up to Tricks", async ({ browser }, testInfo) => {
  onlyOnce(testInfo);
  const page = await openAt(browser, testInfo, WIDTHS[0]);
  try {
    await openIn(page, "tricks", "/settings/tricks/lodge%3Aci");
    await expect(page.locator('[data-slot="settings-path"]')).toHaveText("/Tricks/CI");
    await expect(row(page, "tricks")).toHaveAttribute("aria-current", "page");
    await expect(column(page).getByRole("heading", { level: 1 })).toHaveText("CI");
    await page.locator('[data-slot="settings-page-head"]').getByRole("button", { name: en["settings.nav.back"] }).click();
    await expect(page).toHaveURL(/\/settings\/tricks$/u);
    await expect(page.locator('[data-slot="settings-path"]')).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("a profile's Change login names its path in the header, and Back beside the title goes up to the profile", async ({ browser }, testInfo) => {
  onlyOnce(testInfo);
  const page = await openAt(browser, testInfo, WIDTHS[0]);
  try {
    await openIn(page, "accounts", "/settings/accounts/acct-work/login");
    await expect(page.locator('[data-slot="settings-path"]')).toHaveText(`/${en["accounts.title"]}/Work/${en["accounts.changeLogin.action"]}`);
    await expect(row(page, "accounts")).toHaveAttribute("aria-current", "page");
    await page.locator('[data-slot="settings-page-head"]').getByRole("button", { name: en["settings.nav.back"] }).click();
    await expect(page).toHaveURL(/\/settings\/accounts\/acct-work$/u);
  } finally {
    await page.context().close();
  }
});

// THE PHONE IS UNCHANGED. The boxes below are the ones `stage/next` drew at 390x844 before this layout (measured on
// a36fd0bc5): the header and the first three rows of the index. The layout route draws only its outlet there.
const PHONE_BOXES = {
  header: { x: 0, y: 0, width: 390, height: 61 },
  rows: [
    { x: 17, y: 78, width: 356, height: 77 },
    { x: 17, y: 155, width: 356, height: 77 },
    { x: 17, y: 232, width: 356, height: 77 },
  ],
} as const;

const round = (b: { x: number; y: number; width: number; height: number } | null) => b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };

test("at 390px Settings is the phone's index, box for box", async ({ browser }, testInfo) => {
  onlyOnce(testInfo);
  const page = await openAt(browser, testInfo, { width: 390, height: 844 }, true);
  try {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings$/u);
    const rows = page.locator("main [data-slot=list-group] > button");
    await expect(rows.first()).toBeVisible();
    await expect(list(page)).toHaveCount(0);
    expect(round(await page.locator("header").boundingBox())).toEqual(PHONE_BOXES.header);
    expect([round(await rows.nth(0).boundingBox()), round(await rows.nth(1).boundingBox()), round(await rows.nth(2).boundingBox())]).toEqual(PHONE_BOXES.rows);
  } finally {
    await page.context().close();
  }
});

// ── The shots for a person ──────────────────────────────────────────────────────────────────────────────────────
const SHOT_PAGES: { name: string; path: string; setup?: "tricks" | "accounts" }[] = [
  { name: "01-updates", path: "/settings/updates" },
  { name: "02-appearance", path: "/settings/appearance" },
  { name: "03-harnesses", path: "/settings/harnesses" },
  { name: "04-profiles", path: "/settings/accounts", setup: "accounts" },
  { name: "05-device", path: "/settings/device" },
  { name: "06-voice", path: "/settings/voice" },
  { name: "07-alerts", path: "/settings/alerts" },
  { name: "08-system", path: "/settings/system" },
  { name: "09-experiments", path: "/settings/experiments" },
  { name: "10-tricks", path: "/settings/tricks", setup: "tricks" },
  { name: "11-trick-details", path: "/settings/tricks/lodge%3Aci", setup: "tricks" },
  { name: "12-profile", path: "/settings/accounts/acct-work", setup: "accounts" },
  { name: "13-change-login", path: "/settings/accounts/acct-work/login", setup: "accounts" },
  { name: "14-profile-add", path: "/settings/accounts/add", setup: "accounts" },
  { name: "15-voice-host", path: "/settings/voice/host" },
  { name: "16-voice-model", path: "/settings/voice/model" },
  { name: "17-character", path: "/settings/appearance/character" },
  { name: "18-install-count", path: "/settings/system/install-count" },
];

test("shots: every section at 1440x900, and three sheets", async ({ browser }, testInfo) => {
  onlyOnce(testInfo);
  test.skip(SHOTS === undefined, "set SETTINGS_SHOTS=<dir> to write the shots");
  test.setTimeout(240_000);
  const dir = SHOTS!;
  mkdirSync(dir, { recursive: true });
  for (const shot of SHOT_PAGES) {
    const page = await openAt(browser, testInfo, WIDTHS[0]);
    try {
      if (shot.setup === undefined) await page.goto(shot.path);
      else await openIn(page, shot.setup, shot.path);
      await page.waitForSelector('[data-slot="settings-list"] [data-settings-row]');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(dir, `${shot.name}.png`) });
    } finally {
      await page.context().close();
    }
  }
  // Three sheets opened from a section: each must stand as a centred dialog on this width.
  const sheets: { name: string; path: string; open: string }[] = [
    { name: "20-sheet-theme-browse", path: "/settings/appearance", open: en["theme.browse"] },
    { name: "21-sheet-theme-paste", path: "/settings/appearance", open: en["theme.paste"] },
    { name: "22-sheet-report", path: "/settings/system", open: en["settings.report.open"] },
  ];
  for (const sheet of sheets) {
    const page = await openAt(browser, testInfo, WIDTHS[0]);
    try {
      await page.goto(sheet.path);
      await page.waitForSelector('[data-slot="settings-list"] [data-settings-row]');
      await column(page).getByRole("button", { name: sheet.open, exact: true }).first().click();
      const head = page.locator('[data-slot="sheet-title-row"]').first();
      await head.waitFor({ state: "visible" });
      await page.waitForTimeout(600);
      // Centred in the window, with no grab handle, and not glued to its foot as a bottom sheet would be.
      const top = (await head.boundingBox())!;
      const body = (await page.locator('[data-slot="sheet-body"]').first().boundingBox())!;
      expect(Math.abs(top.x + top.width / 2 - WIDTHS[0].width / 2)).toBeLessThanOrEqual(2);
      expect(top.y).toBeGreaterThan(8);
      expect(WIDTHS[0].height - (body.y + body.height)).toBeGreaterThan(8);
      await expect(page.locator('[data-slot="sheet-handle"]')).toHaveCount(0);
      await page.screenshot({ path: join(dir, `${sheet.name}.png`) });
    } finally {
      await page.context().close();
    }
  }
});
