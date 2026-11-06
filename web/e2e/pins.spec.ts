import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureKiroChat, fixtureKiroHistory, fixtureKiroSnapshot, KIRO_PANE_ID } from "@/test/handlers";

import { fill, installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";

// A CHAT BLOCK CAN BE PINNED (M90). On the built app, over the api stub: tap the block's ⋯, Pin, and the block wears
// its mark and the belt shows the Pins mark with the count; tap the mark and the sheet lists the pin; tap the row and
// the detail layer shows the whole text; Unpin there, and the sheet closes and the mark goes. The rules of what is
// pinnable and what a refusal says are the unit layer's (`lib/message-pins.test.ts`, `bridge/pins/*.test.ts`); what
// only an engine shows is that the ⋯ takes a tap on a real touch screen, the sheets stack and close, and the belt's
// new mark draws in the room it is given.
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

test("a block is pinned from its ⋯, listed in the sheet, read in full and unpinned", async ({ page }) => {
  // Given: the pane open on Chat, the answer on screen and nothing pinned.
  await page.goto(PANE_URL);
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: en["pins.mark"] })).toHaveCount(0);
  await expect(page.locator('[data-slot="belt-pins"]')).toHaveCount(0);

  // When: the ⋯ on the answer is tapped and Pin is chosen.
  await answerBlock(page).getByRole("button", { name: en["pins.action.more"] }).click();
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
