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
