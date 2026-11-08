import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { installApiStub, pinLocale } from "./fixtures/api";
import { collieHalves } from "./fixtures/collie-theme";

// TRY A THEME (M59 spec 08). jsdom holds the trial's rules (lib/theme/trial.test.ts) and the ribbon's
// buttons (components/theme-trial-ribbon.test.tsx); only an engine can say the rest. A theme that
// paints every token one colour is tried from the paste preview, and the case reads what the browser
// computed: the ribbon keeps its own colours over it, sits on the bottom edge across the full width,
// and the composer ends above it instead of under it. A reload of the tab keeps the trial, a new tab
// does not see it, and Back puts the device's own ground back.

test.use({ serviceWorkers: "block" });

const PAINT = "#ff00ff";
const PAINT_RGB = "rgb(255, 0, 255)";
const paintAll = (half: Readonly<Record<string, string>>) => Object.fromEntries(Object.keys(half).map((token) => [token, PAINT]));

/** Every token in both halves is one colour: text, grounds, rules and buttons all vanish into it. */
const ONE_COLOUR = {
  version: 1,
  id: "one-colour",
  name: "One colour",
  author: "Test",
  light: paintAll(collieHalves.light),
  dark: paintAll(collieHalves.dark),
};

const ribbon = (page: Page) => page.getByRole("region", { name: en["theme.trial.region"] });

async function tryFromPaste(page: Page): Promise<void> {
  await page.goto("/settings/appearance");
  await page.getByRole("button", { name: en["theme.paste"], exact: true }).click();
  await page.getByRole("textbox", { name: en["theme.paste.label"] }).fill(JSON.stringify(ONE_COLOUR));
  await page.getByRole("button", { name: en["theme.paste.read"], exact: true }).click();
  await page.getByRole("dialog", { name: en["theme.preview.title"] }).getByRole("button", { name: en["theme.trial.try"], exact: true }).click();
  await expect(ribbon(page)).toBeVisible();
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the trial runs in the shipped app only");
  await pinLocale(page, "en");
  await installApiStub(page);
});

test("the ribbon stands over Chat in its own colours, and the composer ends above it", async ({ page }) => {
  await tryFromPaste(page);
  // A navigation is a reload of this tab: the trial comes back from sessionStorage.
  await page.goto("/pane/w1:p1");
  const bar = ribbon(page);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("status")).toHaveText(`Trying ${ONE_COLOUR.name}`);
  const composer = page.getByRole("textbox", { name: en["composer.placeholder.reply"] });
  await expect(composer).toBeVisible();

  const html = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
  expect(html).toContain(PAINT);

  const look = await bar.evaluate((el) => {
    const style = getComputedStyle(el);
    const button = el.querySelector("button");
    const box = el.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      color: style.color,
      position: style.position,
      zIndex: style.zIndex,
      bottom: box.bottom,
      left: box.left,
      width: box.width,
      height: box.height,
      buttonBackground: button === null ? "" : getComputedStyle(button).backgroundColor,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(look.background).toBe("rgb(17, 17, 17)");
  expect(look.color).toBe("rgb(255, 255, 255)");
  expect(look.buttonBackground).not.toBe(PAINT_RGB);
  expect(look.position).toBe("fixed");
  expect(look.zIndex).toBe("2147483647");
  expect(look.bottom).toBe(look.viewport.height);
  expect(look.left).toBe(0);
  expect(look.width).toBe(look.viewport.width);
  expect(look.height).toBeGreaterThanOrEqual(40);

  // The app is 40px shorter while the ribbon shows: the composer's box ends at or above its top edge.
  const composerBottom = await composer.evaluate((el) => el.getBoundingClientRect().bottom);
  expect(composerBottom).toBeLessThanOrEqual(look.viewport.height - look.height);

  // The point under the ribbon's Back button is the button, whatever the page drew there.
  const back = bar.getByRole("button", { name: en["theme.trial.back"], exact: true });
  const hit = await back.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === el;
  });
  expect(hit).toBe(true);

  await page.screenshot({ path: test.info().outputPath("ribbon-over-chat.png") });
});

test("a new tab does not see the trial, and Back puts the device's own theme on again", async ({ page, context }) => {
  await tryFromPaste(page);
  const other = await context.newPage();
  await other.goto("/settings/appearance");
  await expect(other.getByRole("combobox", { name: en["theme.title"] })).toBeVisible();
  await expect(ribbon(other)).toHaveCount(0);
  await other.close();

  await ribbon(page).getByRole("button", { name: en["theme.trial.back"], exact: true }).click();
  await expect(ribbon(page)).toHaveCount(0);
  const ground = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
  expect(ground).not.toContain(PAINT);
  const kept = await page.evaluate(() => [localStorage.getItem("collie:themes:v1"), sessionStorage.getItem("collie:theme-trial:v1")]);
  expect(kept).toEqual([null, null]);
});
