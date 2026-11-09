import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureKiroChat, fixtureKiroHistory, fixtureKiroSnapshot, KIRO_PANE_ID } from "@/test/handlers";

import { fill, installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";

// A CHAT BLOCK CAN BE PINNED (M90). On the built app, over the api stub: tap the block, then its ⋯, Pin, and the block wears
// its mark and the belt shows the Pins mark with the count; tap the mark and the sheet lists the pin; tap the row and
// the detail layer shows the whole text; Unpin there, and the sheet closes and the mark goes. The rules of what is
// pinnable and what a refusal says are the unit layer's (`lib/message-pins.test.ts`, `bridge/pins/*.test.ts`), and so
// is what a tap reveals and what hides it again (`components/stream-block.test.tsx`); what only an engine shows is that
// the ⋯ is not drawn at rest, that showing it moves no box, that it takes a tap on a real touch screen, that the sheets
// stack and close, and that the belt's new mark draws in the room it is given.
//
// The Kiro world is the one journal with a plain reply in it: its answer is the block pinned here.

// No service worker: `page.route` does not see a request the worker makes for the page, and the stub re-serves a
// route the pane polls (`e2e/issue-180.spec.ts` has the whole story).
test.use({ serviceWorkers: "block" });

const PANE_URL = `/pane/${encodeURIComponent(KIRO_PANE_ID)}`;
const ANSWER = "lab_after_compact";

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "pins exercise the shipped app only");
  await pinLocale(page, "en");
  await installApiStub(page);
  await installPaneWorld(page, {
    paneId: KIRO_PANE_ID,
    snapshot: fixtureKiroSnapshot,
    chat: fixtureKiroChat,
    history: fixtureKiroHistory,
    screens: { idle: paneCapture("kiro--v3-idle-w120") },
    start: "idle",
  });
});

/** The Chat block that is the answer and nothing more (the question above it quotes the word, so a substring would find both). */
const answerBlock = (page: Page) => page.locator("[data-block]").filter({ has: page.getByText(ANSWER, { exact: true }) });
const beltMark = (page: Page, count: number) => page.getByRole("button", { name: fill(en["pins.belt.label"], { count }) });

test("a block shows its ⋯ on a tap, and is pinned from it, listed in the sheet, read in full and unpinned", async ({ page }) => {
  // Given: the pane open on Chat, the answer on screen and nothing pinned.
  await page.goto(PANE_URL);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: en["pins.mark"] })).toHaveCount(0);
  await expect(page.locator('[data-slot="belt-pins"]')).toHaveCount(0);

  // At rest the answer's ⋯ is not drawn, and its text is not wrapped round a place for it.
  const more = answerBlock(page).getByRole("button", { name: en["pins.action.more"] });
  await expect(more).toHaveCSS("opacity", "0");
  const text = page.getByText(ANSWER, { exact: true });
  const before = { block: await answerBlock(page).boundingBox(), text: await text.boundingBox() };

  // When: the answer's text is tapped.
  await text.click();
  // Then: its ⋯ shows, and neither the block nor its text moved.
  await expect(answerBlock(page)).toHaveAttribute("data-revealed", "");
  await expect(more).toHaveCSS("opacity", "1");
  expect(await answerBlock(page).boundingBox()).toEqual(before.block);
  expect(await text.boundingBox()).toEqual(before.text);

  // When: the ⋯ is tapped and Pin is chosen.
  await more.click();
  await page.getByRole("dialog").getByRole("button", { name: en["pins.action.pin"], exact: true }).click();

  // Then: the block wears its mark and the belt's Pins mark reads one.
  await expect(answerBlock(page).getByRole("img", { name: en["pins.mark"] })).toBeVisible();
  await expect(beltMark(page, 1)).toBeVisible();
  await expect(page.locator('[data-slot="belt-pins-count"]')).toHaveText("1");

  // When: the mark is tapped.
  await beltMark(page, 1).click();
  // Then: the sheet lists the pin, with its excerpt.
  const sheet = page.getByRole("dialog", { name: en["pins.sheet.title"] });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-slot="pin-row"]')).toHaveCount(1);
  await expect(sheet.locator('[data-slot="pin-excerpt"]')).toContainText(ANSWER);

  // When: the row is tapped.
  await sheet.locator('[data-slot="pin-row"] > button').first().click();
  // Then: the detail layer shows the whole text, with Unpin and Show in Chat.
  const detail = page.locator('[data-slot="pin-detail"]');
  await expect(detail).toContainText(ANSWER);
  await expect(detail.getByRole("button", { name: en["pins.action.show"] })).toBeVisible();

  // When: Unpin is tapped in the detail.
  await detail.getByRole("button", { name: en["pins.action.unpin"] }).click();
  // Then: the sheet closes, and the block's mark and the belt's mark are gone.
  await expect(page.getByRole("dialog", { name: en["pins.sheet.title"] })).toHaveCount(0);
  await expect(page.locator('[data-slot="pin-detail"]')).toHaveCount(0);
  await expect(page.locator('[data-slot="belt-pins"]')).toHaveCount(0);
  await expect(page.getByRole("img", { name: en["pins.mark"] })).toHaveCount(0);
});

// THE TAP THAT SHOWS THE ⋯ ENDS THERE (2026-11-06, Altan's phone). The reading area turns a tap on plain text into Tap
// to type, and a chat block is plain text to it, so the tap that showed the chip also raised the keyboard. On a touch
// screen: the tap shows the chip, the composer keeps no focus and the viewport does not move. A tap on the thread's
// own ground, outside every block, still focuses the composer, which is what shows this check can see a focus at all.
test("on a phone, the tap that shows a block's ⋯ raises no keyboard and moves nothing", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("app-phone"), "a phone case");
  await page.goto(PANE_URL);
  const text = page.getByText(ANSWER, { exact: true });
  await expect(text).toBeVisible();
  const view = () => page.evaluate(() => ({ height: visualViewport!.height, top: visualViewport!.offsetTop, y: window.scrollY }));
  const focused = () => page.evaluate(() => document.activeElement?.tagName ?? null);
  const before = await view();

  // When: the answer's text is tapped.
  await text.tap();
  // Then: its ⋯ shows, nothing took the focus, and the viewport is where it was.
  await expect(answerBlock(page)).toHaveAttribute("data-revealed", "");
  expect(await focused()).not.toBe("TEXTAREA");
  expect(await view()).toEqual(before);

  // Control: a tap on the thread's ground, outside every block, is still Tap to type.
  await page.getByText(en["history.startOfConversation"], { exact: true }).tap();
  await expect.poll(focused).toBe("TEXTAREA");
});

// ON A PHONE THE HOLD OPENS THE SHEET, AND SELECT TEXT TURNS SELECTION ON (2026-11-06, Altan's Android phone). The
// hold shows as a tint with no scale, and the block stays tinted while its sheet is open. A
// phone's browser started a selection at its own long-press mark and cancelled the pointer, so the block's hold did
// nothing. Under `pointer: coarse` a pinnable block takes no selection at rest, and the hold opens its sheet. The hold
// is a real touch, sent through the DevTools protocol (`Input.dispatchTouchEvent`, as `sheet-drag.spec.ts` does), so
// Chromium runs its own long-press on it; `locator.tap()` is a tap and could not show this.
test("on a phone, a hold on a block opens its sheet, and Select text lets that block's text be selected", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("app-phone"), "a phone case");
  test.skip(testInfo.project.name.includes("webkit"), "the touch is sent through Chromium's DevTools protocol");
  await page.goto(PANE_URL);
  const text = page.getByText(ANSWER, { exact: true });
  await expect(text).toBeVisible();
  const userSelect = () => answerBlock(page).evaluate((el) => getComputedStyle(el).userSelect);

  // At rest the block takes no selection on a touch screen.
  expect(await userSelect()).toBe("none");

  // When: a finger holds the answer's text past the hold's 650ms.
  const box = (await text.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchEnd", points: { x: number; y: number }[]) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p) => ({ ...p, radiusX: 4, radiusY: 4, force: 1 })) });
  await touch("touchStart", [at]);
  // While it is held, the block shows the hold as a tint and nothing else: no scale squeezes its text.
  await expect(answerBlock(page)).toHaveAttribute("data-holding", "");
  expect(await answerBlock(page).evaluate((el) => getComputedStyle(el).transform)).toBe("none");
  await page.waitForTimeout(900);
  await touch("touchEnd", []);

  // Then: the sheet is open, its block is tinted, no text is selected and the keyboard did not come up.
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("button", { name: en["pins.action.pin"], exact: true })).toBeVisible();
  await expect(answerBlock(page)).toHaveAttribute("data-active", "");
  await expect(answerBlock(page)).not.toHaveAttribute("data-holding");
  expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.tagName ?? null)).not.toBe("TEXTAREA");

  // When: Select text is chosen.
  await sheet.getByRole("button", { name: en["pins.action.selectText"], exact: true }).click();
  // Then: the sheet closes, the hint shows and the block takes a selection.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(answerBlock(page)).not.toHaveAttribute("data-active");
  await expect(page.getByText(en["pins.selectText.hint"], { exact: true })).toBeVisible();
  await expect(answerBlock(page)).toHaveAttribute("data-selectable", "");
  expect(await userSelect()).toBe("text");

  // When: a tap lands outside the block. Then: the block takes no selection again.
  await page.getByText(en["history.startOfConversation"], { exact: true }).tap();
  await expect(answerBlock(page)).not.toHaveAttribute("data-selectable");
  expect(await userSelect()).toBe("none");
});
