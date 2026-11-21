import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub, pinLocale } from "./fixtures/api";
import { stillMarkState } from "./fixtures/still-mark";
import { installScreenStubs } from "./screens/setups";

// THE SEARCH OF SETTINGS (ADR 0170, components/settings-search.tsx). One field on top of the phone's index and of the
// large screen's list. A result names its row, its page and its group; Enter or a tap opens the page, scrolls the row
// into view and marks it for two seconds; a row of a pane's own sheet says where it is and links nowhere; Escape
// clears the field; `/` puts the cursor in it. A real engine, for the scroll, the focus and the mark.

test.use({ serviceWorkers: "block" });

const SIZES = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "large", width: 1440, height: 900, touch: false },
] as const;

function onlyOnce(testInfo: TestInfo) {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewports and input; one project is enough");
}

async function openAt(browser: Browser, testInfo: TestInfo, size: (typeof SIZES)[number]): Promise<Page> {
  const baseURL = String(testInfo.project.use.baseURL);
  const context = await browser.newContext({ baseURL, viewport: size, hasTouch: size.touch, deviceScaleFactor: size.touch ? 2 : 1, serviceWorkers: "block", storageState: stillMarkState(baseURL) });
  const page = await context.newPage();
  await pinLocale(page, "en");
  await installApiStub(page);
  await installScreenStubs(page);
  return page;
}

const field = (page: Page) => page.getByRole("textbox", { name: en["settings.search.label"] });
const results = (page: Page) => page.locator('[data-slot="settings-search-results"]');
const hit = (page: Page, id: string) => page.locator(`[data-setting-hit="${id}"]`);

/** On the phone the index is `/settings`; on a large screen `/settings` opens the first page beside the list. */
async function openSettings(page: Page) {
  await page.goto("/settings");
  await expect(field(page)).toBeVisible();
}

for (const size of SIZES) {
  test(`${size.name}: a result names its page and group, and Enter opens the page with the row marked`, async ({ browser }, testInfo) => {
    onlyOnce(testInfo);
    test.setTimeout(60_000);
    const page = await openAt(browser, testInfo, size);
    try {
      await openSettings(page);
      await field(page).fill("math");
      await expect(results(page)).toBeVisible();
      const math = hit(page, "look.math");
      await expect(math).toContainText(en["settings.math.title"]);
      await expect(math).toContainText(en["settings.page.look.title"]);
      // While the field holds words the results stand where the list was.
      await expect(page.locator(size.name === "phone" ? 'main [data-slot="list-group"]' : "[data-settings-row]")).toHaveCount(0);
      await field(page).press("Enter");
      await expect(page).toHaveURL(/\/settings\/look#look\.math$/u);
      const slot = page.locator('[data-setting~="look.math"]').first();
      await expect(slot).toHaveAttribute("data-marked", "true");
      await expect(slot).toBeInViewport();
      // The mark goes after two seconds.
      await expect(slot).not.toHaveAttribute("data-marked", "true", { timeout: 4000 });
    } finally {
      await page.context().close();
    }
  });

  test(`${size.name}: a row of a pane's own menu says where it is and has no link`, async ({ browser }, testInfo) => {
    onlyOnce(testInfo);
    const page = await openAt(browser, testInfo, size);
    try {
      await openSettings(page);
      await field(page).fill("pin to top");
      const pin = hit(page, "pane.pinToTop");
      await expect(pin).toContainText(en["paneActions.pin.label"]);
      await expect(pin.locator("button, a")).toHaveCount(0);
      // Enter opens the first result only, and this one has no page.
      await expect(results(page).locator("li").first()).toHaveAttribute("data-setting-hit", "pane.pinToTop");
      const before = page.url();
      await field(page).press("Enter");
      await page.waitForTimeout(300);
      expect(page.url()).toBe(before);
    } finally {
      await page.context().close();
    }
  });

  test(`${size.name}: the diff layout of Files is found by "side by side" and says where it is, with no link`, async ({ browser }, testInfo) => {
    onlyOnce(testInfo);
    const page = await openAt(browser, testInfo, size);
    try {
      await openSettings(page);
      await field(page).fill("side by side");
      const row = hit(page, "files.diffLayout");
      // The matched words are marked, so the label is cut into pieces: read its start.
      await expect(row).toContainText("Unified or");
      await expect(row).toContainText(en["settings.where.filesDiff"]);
      await expect(row.locator("button, a")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test(`${size.name}: Escape clears the field and the list comes back`, async ({ browser }, testInfo) => {
    onlyOnce(testInfo);
    const page = await openAt(browser, testInfo, size);
    try {
      await openSettings(page);
      await field(page).fill("dark");
      await expect(results(page)).toBeVisible();
      await field(page).press("Escape");
      await expect(field(page)).toHaveValue("");
      await expect(results(page)).toHaveCount(0);
      await expect(page.locator('[data-slot="list-group"], [data-slot="settings-list"]').first()).toBeVisible();
    } finally {
      await page.context().close();
    }
  });
}

test("large: / puts the cursor in the field, and a tap on a result opens its page", async ({ browser }, testInfo) => {
  onlyOnce(testInfo);
  const page = await openAt(browser, testInfo, SIZES[1]);
  try {
    await openSettings(page);
    await page.locator("body").click({ position: { x: 900, y: 600 } });
    await page.keyboard.press("/");
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue("");
    await page.keyboard.type("enter sends");
    await hit(page, "keys.enterSends").getByRole("button").click();
    await expect(page).toHaveURL(/\/settings\/keys#keys\.enterSends$/u);
    await expect(page.locator('[data-setting~="keys.enterSends"]').first()).toHaveAttribute("data-marked", "true");
  } finally {
    await page.context().close();
  }
});
