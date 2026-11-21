import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE HAND CURSOR (operator, 2026-11-19: "on a desktop the buttons do not show the pointer"). Tailwind 4's
// preflight no longer gives a button the pointer, so `index.css` carries ONE low-specificity rule in the base
// layer that names what a person can click. jsdom computes no cascade from the real stylesheet, so each case
// reads `getComputedStyle(el).cursor` in a real engine, on the shipped bundle. A touch screen has no cursor,
// so nothing here can change it.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
  await keepPhoneLayout(page);
});

function cursor(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).cursor);
}

// A text field keeps the browser's own cursor, and the engines name it differently: Chromium's built-in
// stylesheet sets `text`, WebKit's sets nothing and resolves `auto` to the I-beam at paint time. Either value
// is the browser's own; the requirement is that the app's hand rule never reaches a text field.
const TEXT_FIELD_CURSOR = /^(text|auto)$/;

async function cursorOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((el) => getComputedStyle(el).cursor);
}

test("the real controls of the app show the hand", async ({ page }) => {
  await page.goto("/");
  const home = page.getByRole("button", { name: en["nav.home.aria.default"] });
  await expect(home).toBeVisible();

  // A header button, and a list row (a whole-row button on the dashboard).
  expect(await cursor(home)).toBe("pointer");
  expect(await cursor(page.getByRole("button", { name: en["home.needsYouOnly"] }))).toBe("pointer");
  expect(await cursor(page.locator('[data-slot="list-group"] button').first())).toBe("pointer");
  // A tab of the space strip, and a native select.
  expect(await cursor(page.getByRole("button", { name: /^New tab in / }).first())).toBe("pointer");
  expect(await cursor(page.getByRole("combobox").first())).toBe("pointer");

  // Settings: a switch, a radio of a segmented control, and a link.
  await page.goto("/settings/keys");
  expect(await cursor(page.getByRole("switch", { name: en["settings.harnessBar.title"] }))).toBe("pointer");
  await page.goto("/settings/look");
  expect(await cursor(page.getByRole("radio", { name: "Dark", exact: true }))).toBe("pointer");
  expect(await cursor(page.getByRole("link", { name: en["settings.appearance.intro.docs"] }))).toBe("pointer");

  // A pane: the Send button, and the text field, which keeps the browser's own cursor.
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  expect(await cursor(page.getByRole("button", { name: en["composer.send.sendAria"], exact: true }))).toBe("pointer");
  expect(await cursor(page.locator("textarea").first())).toMatch(TEXT_FIELD_CURSOR);
});

test("a disabled control, a text field and a component's own cursor keep theirs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: en["nav.home.aria.default"] })).toBeVisible();
  // A probe of every selector in the rule, appended to the real page so the real stylesheet answers.
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "cursor-probe";
    host.innerHTML = `
      <button id="on">on</button>
      <button id="off" disabled>off</button>
      <fieldset disabled><button id="fs">in a disabled fieldset</button></fieldset>
      <a id="link" href="/x">link</a>
      <a id="bare">no href</a>
      <details><summary id="summary">summary</summary>body</details>
      <select id="select"><option>a</option></select>
      <select id="select-off" disabled><option>a</option></select>
      <label id="label-for" for="box">for a box</label>
      <label id="label-wrap"><input id="box" type="checkbox"> wraps a box</label>
      <label id="label-text"><input id="text-in-label" type="text"> wraps a text field</label>
      <label id="label-off"><input type="checkbox" disabled> wraps a disabled box</label>
      <input id="checkbox" type="checkbox"><input id="radio" type="radio"><input id="range" type="range">
      <input id="file" type="file"><input id="submit" type="submit"><input id="submit-off" type="submit" disabled>
      <input id="text" type="text"><textarea id="area"></textarea>
      <div id="r-button" role="button">b</div><div id="r-link" role="link">l</div><div id="r-tab" role="tab">t</div>
      <div id="r-switch" role="switch">s</div><div id="r-checkbox" role="checkbox">c</div><div id="r-radio" role="radio">r</div>
      <div id="r-menuitem" role="menuitem">m</div><div id="r-option" role="option">o</div>
      <div id="r-off" role="button" aria-disabled="true">disabled role</div>
      <button id="own" class="cursor-grab">own class</button>
      <button id="own-off" class="disabled:cursor-not-allowed" disabled>own class, disabled</button>
      <div id="plain">plain</div>`;
    document.body.append(host);
  });
  const hand = ["on", "link", "summary", "select", "label-for", "label-wrap", "checkbox", "radio", "range", "file", "submit",
    "r-button", "r-link", "r-tab", "r-switch", "r-checkbox", "r-radio", "r-menuitem", "r-option"];
  for (const id of hand) expect(await cursorOf(page, `#cursor-probe #${id}`), id).toBe("pointer");

  // Disabled, or not a control: the browser's own cursor (`default` on a button, `auto` elsewhere), never the hand.
  for (const id of ["off", "fs", "bare", "select-off", "label-text", "label-off", "submit-off", "r-off", "plain"]) {
    expect(await cursorOf(page, `#cursor-probe #${id}`), id).toMatch(/^(default|auto)$/);
  }
  // A text field keeps the browser's own cursor (`text` on Chromium, `auto` on WebKit), never the hand.
  expect(await cursorOf(page, "#cursor-probe #text")).toMatch(TEXT_FIELD_CURSOR);
  expect(await cursorOf(page, "#cursor-probe #area")).toMatch(TEXT_FIELD_CURSOR);
  // The rule adds no specificity: a utility class on the element still wins.
  expect(await cursorOf(page, "#cursor-probe #own")).toBe("grab");
  expect(await cursorOf(page, "#cursor-probe #own-off")).toBe("not-allowed");
});
