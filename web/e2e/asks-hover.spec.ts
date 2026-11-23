import { expect, test, type Locator, type Page } from "@playwright/test";

import { askDecision } from "@/test/asks-fixtures";

import { installApiStub } from "./fixtures/api";
import { installWorld } from "./hitbox/world";

// THE POINTER ON THE ASKS PAGES (Asks build 5, 2026-11-23). A mouse on a large screen gets the house hover on the answer
// cards and, from the shared `Segmented` (ui/segmented.tsx), on every segmented control, Here / Quiet / Away and Settings'
// Large-screen layout among them: `--state-hover` of the plane (HOVER_FILL), colour only, so no box moves. A
// chosen card keeps its border and its tint and only deepens the tint, so it never reads as a hovered unchosen card. A
// finger leaves nothing behind. The fill is read as the computed colour in a real engine, on the shipped bundle: jsdom has no
// cascade and no `(hover: hover)`.

test.use({ serviceWorkers: "block" });

const NOW = new Date("2026-11-23T12:00:00Z");
const AT = NOW.getTime();

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "sets its own viewport and pointer; one project is enough");
  await page.clock.install({ time: NOW });
});

const FIRST = askDecision({ id: "ak_hover0000001", title: "Keep the old answer route beside the new Send?", address: "local/w1:p1", at: AT - 14 * 3_600_000, recommend: "keep", why: "A phone that did not reload would lose an answer.", root: "w1:p1" });
const SECOND = askDecision({ id: "ak_hover0000002", title: "Drop the flag?", address: "local/w1:p1", at: AT - 3_600_000 });

interface CrewStateBody {
  state: "here" | "quiet" | "away";
  at: number | null;
  by: string | null;
  told: number | null;
}

async function world(page: Page, crewState?: CrewStateBody) {
  await installWorld(page);
  await page.route("**/api/hill", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ v: 1, rev: 1, open: [FIRST, SECOND], closed: [], crewState }) }));
}

const card = (page: Page, intent: string) => page.locator(`[data-slot="ask-card"][data-intent="${intent}"]`);
const face = (page: Page, intent: string) => card(page, intent).getByRole("button");

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

async function openAsk(page: Page) {
  await world(page);
  await page.goto(`/asks/ask/${FIRST.id}`);
  await expect(page.getByRole("heading", { name: FIRST.title })).toBeVisible();
}

/** Mark a card as the answer (tap, Confirm), then move the pointer off it. */
async function choose(page: Page, intent: string) {
  await face(page, intent).scrollIntoViewIfNeeded();
  await face(page, intent).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Confirm" }).click();
  await expect(sheet).toBeHidden();
  await expect(card(page, intent)).toHaveAttribute("data-state", "answered");
  await page.mouse.move(2, 2);
}

test.describe("a mouse on a large screen", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });

  for (const intent of ["drop", "own"] as const) {
    test(`the ${intent === "own" ? "Your own answer card" : "option card"} takes the hover token and keeps its box`, async ({ page }) => {
      await openAsk(page);
      const target = face(page, intent);
      await target.scrollIntoViewIfNeeded();
      const hover = await page.evaluate(() => matchMedia("(hover: hover)").matches);
      expect(hover).toBe(true);
      const restBox = await boxOf(target);
      const rest = await background(target);
      const token = await hoverToken(target);
      expect(token).not.toBe(rest);
      await target.hover();
      await expect.poll(() => background(target)).toBe(token);
      expect(await boxOf(target)).toEqual(restBox);
      await page.mouse.move(2, 2);
      await expect.poll(() => background(target)).toBe(rest);
    });
  }

  test("a chosen card under the pointer still differs from an unchosen hovered card, and keeps its border", async ({ page }) => {
    await openAsk(page);
    await choose(page, "keep");
    const chosen = face(page, "keep");
    const other = face(page, "drop");
    await other.scrollIntoViewIfNeeded();
    const restBackground = await background(chosen);
    const restBorder = await chosen.evaluate((el) => getComputedStyle(el).borderTopColor);
    const restBox = await boxOf(chosen);
    await other.hover();
    const token = await hoverToken(other);
    await expect.poll(() => background(other)).toBe(token);
    await chosen.hover();
    await expect.poll(() => background(chosen)).not.toBe(restBackground);
    await expect.poll(() => background(chosen)).not.toBe(token);
    expect(await chosen.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(restBorder);
    await expect(card(page, "keep")).toHaveAttribute("data-state", "answered");
    expect(await boxOf(chosen)).toEqual(restBox);
  });

  test("the keyboard shows the focus ring on a card with Tab", async ({ page }) => {
    await openAsk(page);
    const target = face(page, "drop");
    await target.scrollIntoViewIfNeeded();
    for (let step = 0; step < 40; step++) {
      await page.keyboard.press("Tab");
      if (await target.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(target).toBeFocused();
    // The card eases its outline in (`transition-all`), so the width is read until it settles.
    await expect.poll(() => target.evaluate((el) => `${getComputedStyle(el).outlineWidth} ${getComputedStyle(el).outlineStyle}`)).toBe("2px solid");
  });

  test("an unchosen segment of Here / Quiet / Away takes the hover token, the chosen one does not", async ({ page }) => {
    await world(page, { state: "here", at: null, by: null, told: null });
    await page.goto("/asks");
    const group = page.locator('[data-slot="hill-crew-state"] [role="radiogroup"]');
    await expect(group).toBeVisible();
    const quiet = group.getByRole("radio", { name: "Quiet" });
    const here = group.getByRole("radio", { name: "Here" });
    const token = await hoverToken(quiet);
    const rest = await background(quiet);
    expect(token).not.toBe(rest);
    await quiet.hover();
    await expect.poll(() => background(quiet)).toBe(token);
    await here.hover();
    await expect.poll(() => background(here)).toBe(rest);
  });

  test("a second segmented control, Settings' Large-screen layout, takes the same hover, and the chosen segment does not change", async ({ page }) => {
    await installApiStub(page);
    await page.goto("/settings/look");
    const group = page.getByRole("radiogroup", { name: "Large-screen layout" });
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
    expect(token).not.toBe(rest);
    await other.hover();
    await expect.poll(() => background(other)).toBe(token);
    expect(await boxOf(other)).toEqual(otherBox);
    const dir = process.env.ASKS_HOVER_SHOTS;
    if (dir !== undefined && dir !== "") await page.screenshot({ path: `${dir}/segmented-pointer-on-unchosen-segment.png` });
    await chosen.hover();
    await expect.poll(() => background(other)).toBe(rest);
    expect(await background(chosen)).toBe(chosenRest);
    expect(await boxOf(chosen)).toEqual(chosenBox);
  });

  test("the shots for the lead", async ({ page }) => {
    const dir = process.env.ASKS_HOVER_SHOTS;
    test.skip(dir === undefined || dir === "", "set ASKS_HOVER_SHOTS to a folder to take them");
    await openAsk(page);
    await face(page, "drop").scrollIntoViewIfNeeded();
    await face(page, "drop").hover();
    await expect.poll(async () => (await background(face(page, "drop"))) === (await hoverToken(face(page, "drop")))).toBe(true);
    await page.screenshot({ path: `${dir}/ask-pointer-on-option-2.png` });
    await page.goto("/asks");
    const row = page.locator('[data-slot="asks-row"]').nth(1);
    await expect(row).toBeVisible();
    await row.hover();
    await expect.poll(async () => (await background(row)) === (await hoverToken(row))).toBe(true);
    await page.screenshot({ path: `${dir}/asks-list-pointer-on-row.png` });
  });
});

test.describe("a finger on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tap leaves no hover fill behind", async ({ page }) => {
    await openAsk(page);
    const target = face(page, "drop");
    await target.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => matchMedia("(hover: hover)").matches)).toBe(false);
    const rest = await background(target);
    await target.tap();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel" }).tap();
    await expect(sheet).toBeHidden();
    await expect.poll(() => background(target)).toBe(rest);
    expect(await background(target)).not.toBe(await hoverToken(target));
  });
});
