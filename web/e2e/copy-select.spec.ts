import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureKiroChat, fixtureKiroHistory, fixtureKiroSnapshot, KIRO_PANE_ID } from "@/test/handlers";

import { installApiStub, installPaneWorld, paneCapture, pinLocale } from "./fixtures/api";

// SELECT TEXT OPENS A SHEET, AND A COPY SHOWS WHAT IT COPIED (2026-11-23). On the built app over the api stub, in the
// Kiro world, whose last answer is swapped for a long reply with a code block. A phone (390, touch) and a desk (1440,
// a mouse). The unit layer has the rules (`components/block-text-sheet.test.tsx`, `lib/copied-flash.test.ts`); what only
// an engine shows is the range a Selection can hold in the sheet, a long reply scrolling inside it, the tint on the
// block and the fade, and that a flash moves no box.

test.use({ serviceWorkers: "block" });

// The stub clipboard's two facts, on the page.
declare global {
  interface Window {
    __copied: string[];
    __refuse: boolean;
  }
}

const PANE_URL = `/pane/${encodeURIComponent(KIRO_PANE_ID)}`;
const TAIL = "tail-marker-end";
const NUMBERS = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n");
const CODE = "const retries = 3;";
const LONG_REPLY = `${NUMBERS}\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\n${TAIL}`;

const NOTES = process.env.COPY_SELECT_SHOTS;

/** The Kiro chat with its last assistant text swapped for the long reply. */
function longChat() {
  const upserts = fixtureKiroChat.upserts.map((entry) => ({ ...entry }));
  const last = upserts.findLast((entry) => entry.role === "assistant" && entry.parts.some((part) => part.kind === "text"));
  if (last === undefined) throw new Error("the Kiro journal holds no assistant text");
  last.parts = [{ kind: "text", text: LONG_REPLY }];
  return { ...fixtureKiroChat, upserts };
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("app-phone") || testInfo.project.name.includes("webkit"), "one run per viewport below");
  await pinLocale(page, "en");
  await installApiStub(page);
  // A clipboard that records what it is given, or refuses when the case says so.
  await page.addInitScript(() => {
    window.__copied = [];
    window.__refuse = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (window.__refuse) throw new Error("denied");
          window.__copied.push(text);
        },
      },
    });
  });
  await installPaneWorld(page, {
    paneId: KIRO_PANE_ID,
    snapshot: fixtureKiroSnapshot,
    chat: longChat(),
    history: fixtureKiroHistory,
    screens: { idle: paneCapture("kiro--v3-idle-w120") },
    start: "idle",
  });
});

const replyBlock = (page: Page) => page.locator("[data-block]").filter({ hasText: TAIL });
const copied = (page: Page): Promise<string[]> => page.evaluate(() => window.__copied);
const textArea = (page: Page) => page.getByRole("region", { name: en["pins.textSheet.aria"] });

/** Opens the actions sheet of the long reply: on a phone a tap and the ⋯, on a desk a right click. */
async function openActions(page: Page, desk: boolean): Promise<Locator> {
  const block = replyBlock(page);
  await expect(block).toBeVisible();
  await block.scrollIntoViewIfNeeded();
  const heading = block.getByText(TAIL, { exact: false });
  if (desk) {
    await heading.click({ button: "right" });
  } else {
    await heading.click();
    await block.getByRole("button", { name: en["pins.action.more"] }).click();
  }
  const sheet = page.getByRole("dialog", { name: en["pins.sheet.kind.reply"] });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** The box of `target` once it has stopped moving (a sheet's entrance runs a moment), read the same twice in a row. */
async function settled(target: Locator) {
  let last = await target.boundingBox();
  await expect
    .poll(async () => {
      const now = await target.boundingBox();
      const same = JSON.stringify(now) === JSON.stringify(last);
      last = now;
      return same;
    })
    .toBe(true);
  return last;
}

/** A box and the box of the text in it, read now. */
async function boxes(block: Locator) {
  return { block: await block.boundingBox(), text: await block.locator("p").last().boundingBox() };
}

for (const mode of [
  { name: "phone, touch", desk: false, viewport: { width: 390, height: 844 }, hasTouch: true },
  { name: "desk, mouse", desk: true, viewport: { width: 1440, height: 900 }, hasTouch: false },
]) {
  test.describe(mode.name, () => {
    test.use({ viewport: mode.viewport, hasTouch: mode.hasTouch });

    test("Select text opens the text sheet: a range can be selected there, the block takes no select mode, a long reply scrolls inside it", async ({ page }) => {
      await page.goto(PANE_URL);
      const sheet = await openActions(page, mode.desk);
      const userSelectBefore = await replyBlock(page).evaluate((el) => getComputedStyle(el).userSelect);

      await sheet.getByRole("button", { name: en["pins.action.selectText"], exact: true }).click();

      // The actions sheet gave way to the text sheet, the same words Copy text writes.
      await expect(page.getByRole("button", { name: en["pins.action.pin"], exact: true })).toHaveCount(0);
      const area = textArea(page);
      await expect(area).toBeVisible();
      await expect(area).toContainText(TAIL);
      expect(await area.evaluate((el) => getComputedStyle(el).userSelect)).toBe("text");

      // The block under the sheet is in no select mode: no attribute, and its selection rule is what it was.
      await expect(page.locator("[data-selectable]")).toHaveCount(0);
      expect(await replyBlock(page).evaluate((el) => getComputedStyle(el).userSelect)).toBe(userSelectBefore);

      // A long reply scrolls inside the sheet, and the foot stays in view.
      const room = await area.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      expect(room.scroll).toBeGreaterThan(room.client);
      await area.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect(await area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(page.getByRole("button", { name: en["pins.action.copyAll"] })).toBeInViewport();

      // A range inside the text, set with the Selection API, is what the selection holds.
      await area.evaluate((el) => {
        el.scrollTop = 0;
        const node = el.firstChild!;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 11);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("line 1\nline");
      if (NOTES !== undefined) await page.screenshot({ path: `${NOTES}/text-sheet-${mode.desk ? "1440" : "390"}.png` });

      // Closing clears the selection.
      await page.getByRole("button", { name: en["common.closeAria"] }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
    });

    test("Copy all writes the whole text and flashes the text area, which moves no box", async ({ page }) => {
      await page.clock.install();
      await page.goto(PANE_URL);
      const sheet = await openActions(page, mode.desk);
      await sheet.getByRole("button", { name: en["pins.action.selectText"], exact: true }).click();
      const area = textArea(page);
      await expect(area).toBeVisible();
      await page.clock.pauseAt(new Date(Date.now() + 60_000));
      const before = await settled(area);

      await page.getByRole("button", { name: en["pins.action.copyAll"] }).click();
      await expect(area).toHaveAttribute("data-copied", "");
      expect((await copied(page))[0]).toContain(TAIL);
      expect(await area.boundingBox()).toEqual(before);
      // The sheet stays open, and the button wears the copied word.
      await expect(page.getByRole("button", { name: en["copyable.done"] })).toBeVisible();

      await page.clock.runFor(800);
      await expect(area).not.toHaveAttribute("data-copied");
    });

    test("Copy text flashes the block it copied, moves no box, and the tint is gone after its time", async ({ page }) => {
      await page.clock.install();
      await page.goto(PANE_URL);
      const sheet = await openActions(page, mode.desk);
      await page.clock.pauseAt(new Date(Date.now() + 60_000));
      const block = replyBlock(page);
      const before = await boxes(block);

      await sheet.getByRole("button", { name: en["pins.action.copy"], exact: true }).click();
      await expect(block).toHaveAttribute("data-copied", "");
      expect((await copied(page))[0]).toContain(TAIL);
      // Only that block flashes, and the box of the block and of its text did not move.
      await expect(page.locator("[data-copied]")).toHaveCount(1);
      expect(await boxes(block)).toEqual(before);

      if (NOTES !== undefined && !mode.desk) {
        // The middle of the fade, held there for the picture.
        await block.evaluate((el) => {
          for (const animation of document.getAnimations()) {
            if (animation.effect instanceof KeyframeEffect && animation.effect.target === el) {
              animation.pause();
              animation.currentTime = 300;
            }
          }
        });
        await page.screenshot({ path: `${NOTES}/block-flash-390.png` });
      }

      await page.clock.runFor(800);
      await expect(block).not.toHaveAttribute("data-copied");
    });

    test("a code block's Copy flashes the code block, not the button, and a refused copy flashes nothing", async ({ page }) => {
      await page.clock.install();
      await page.goto(PANE_URL);
      const block = replyBlock(page);
      await expect(block).toBeVisible();
      const code = block.locator("pre").filter({ hasText: CODE }).locator("xpath=..");
      await code.scrollIntoViewIfNeeded();
      await page.clock.pauseAt(new Date(Date.now() + 60_000));
      const button = code.getByRole("button", { name: en["copyable.copy"] });

      // A refused copy: no flash.
      await page.evaluate(() => {
        window.__refuse = true;
      });
      await button.click();
      await expect(code.getByRole("button", { name: en["copyable.failed"] })).toBeVisible();
      await expect(page.locator("[data-copied]")).toHaveCount(0);

      // A copy that works: the code block flashes, the button does not.
      await page.evaluate(() => {
        window.__refuse = false;
      });
      const before = await boxes(block);
      await page.clock.runFor(2000);
      await code.getByRole("button").click();
      await expect(code).toHaveAttribute("data-copied", "");
      await expect(code.getByRole("button")).not.toHaveAttribute("data-copied");
      expect(await copied(page)).toEqual([CODE]);
      expect(await boxes(block)).toEqual(before);
      await page.clock.runFor(800);
      await expect(code).not.toHaveAttribute("data-copied");
    });
  });
}
