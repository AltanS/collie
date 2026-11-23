import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE POINTER ON THE PILL-STYLE CHOICES (Asks build 5, 2026-11-23). Belt size, Light or dark, the Changes depth and the Chat
// and Pane views are radio groups of their own pills, not `Segmented`. On a large screen with a mouse an item that is not
// chosen takes the house hover (`--state-hover`, `PILL_HOVER` in ui/button.tsx); the chosen pill does not change; no box
// moves. The fill is read as the computed colour in a real engine, on the shipped bundle: jsdom has no cascade and no
// `(hover: hover)`.

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 }, hasTouch: false });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewport and pointer; one project is enough");
  await installApiStub(page);
});

function background(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).backgroundColor);
}

/** The computed colour of the `--state-hover` the element stands under, read through a probe that is removed again. */
function hoverToken(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--state-hover)";
    (el.parentElement ?? el).appendChild(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
}

async function boxOf(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b).not.toBeNull();
  return b!;
}

async function check(page: Page, label: string, shot?: string) {
  await page.goto("/settings/look");
  const group = page.getByRole("radiogroup", { name: label });
  await expect(group).toBeVisible();
  const chosen = group.locator('[role="radio"][aria-checked="true"]');
  const other = group.locator('[role="radio"][aria-checked="false"]').first();
  await expect(chosen).toHaveCount(1);
  await other.scrollIntoViewIfNeeded();
  const token = await hoverToken(other);
  const rest = await background(other);
  const chosenRest = await background(chosen);
  const otherBox = await boxOf(other);
  const chosenBox = await boxOf(chosen);
  // The hover must show on its ground and must not be the chosen pill's fill.
  expect(token).not.toBe(rest);
  expect(token).not.toBe(chosenRest);
  await other.hover();
  await expect.poll(() => background(other)).toBe(token);
  expect(await boxOf(other)).toEqual(otherBox);
  const dir = process.env.ASKS_HOVER_SHOTS;
  if (shot !== undefined && dir !== undefined && dir !== "") await page.screenshot({ path: `${dir}/${shot}` });
  await chosen.hover();
  await expect.poll(() => background(other)).toBe(rest);
  expect(await background(chosen)).toBe(chosenRest);
  expect(await boxOf(chosen)).toEqual(chosenBox);
}

test("Belt size: the unchosen pill takes the hover token, the chosen one does not change, the boxes are equal", async ({ page }) => {
  await check(page, en["settings.beltSize.label"], "belt-size-pointer-on-unchosen-pill.png");
});

test("Light or dark: the unchosen pill takes the hover token, the chosen one does not change, the boxes are equal", async ({ page }) => {
  await check(page, en["settings.lightDark.title"]);
});
