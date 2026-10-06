import { expect, test, type Page } from "@playwright/test";

import { PANES, stubPaneBridge, TERMINAL_TEXT } from "./pane-api";

// The two-step pane mount (routes/pane/pane.tsx, file header): the first commit draws the screen and
// a stand-in of the composer's exact height; the composer and the sheets mount a frame later. The
// no-shift rule (DESIGN.md §2) is what this holds: across the swap the chrome block's top edge and
// height are one value, and the screen's last row does not move.

const path = (paneId: string) => `/pane/${encodeURIComponent(paneId)}`;

interface Frame {
  standIn: boolean;
  composer: boolean;
  top: number;
  height: number;
  /** Bottom edge of the screen's last drawn row (chat block or mirror text), -1 when none yet. */
  tail: number;
}

declare global {
  interface Window {
    __twoStep: Frame[];
  }
}

async function sampleFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    window.__twoStep = frames;
    const tick = (): void => {
      const standIn = document.querySelector('[data-slot="chrome-block-standin"]');
      const composer = document.querySelector('[data-slot="chrome-block"]');
      const block = standIn ?? composer;
      if (block !== null) {
        const box = block.getBoundingClientRect();
        const rows = document.querySelectorAll('[data-testid="chat-stream"] [data-block], [data-testid="pane-text"]');
        const last = rows[rows.length - 1];
        frames.push({
          standIn: standIn !== null,
          composer: composer !== null,
          top: Math.round(box.top * 10) / 10,
          height: Math.round(box.height * 10) / 10,
          tail: last === undefined ? -1 : Math.round(last.getBoundingClientRect().bottom * 10) / 10,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const frames = (page: Page): Promise<Frame[]> => page.evaluate(() => window.__twoStep);

async function terminalPref(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" })));
}

/**
 * Step one painted the stand-in, step two replaced it with the composer, and the chrome block kept one
 * top edge and one height across every frame. `tail: "all"` also holds the screen's last row still in
 * every frame it is drawn; `"swap"` only across the two frames of the swap (a cold load eases the
 * strips in when the snapshot lands, which is Collapse doing its job, not the swap).
 */
function expectNoShift(seen: Frame[], tail: "all" | "swap"): void {
  expect(seen.some((f) => f.standIn && !f.composer)).toBe(true);
  expect(seen.at(-1)?.composer).toBe(true);
  expect(seen.at(-1)?.standIn).toBe(false);
  expect(new Set(seen.map((f) => f.top)).size).toBe(1);
  expect(new Set(seen.map((f) => f.height)).size).toBe(1);
  const swap = seen.findIndex((f) => !f.standIn);
  expect(swap).toBeGreaterThan(0);
  const tails = tail === "all" ? seen : seen.slice(swap - 1, swap + 1);
  expect(new Set(tails.filter((f) => f.tail >= 0).map((f) => f.tail)).size).toBeLessThanOrEqual(1);
}

test("a row tap: the screen paints with the stand-in, the composer lands at its height, nothing moves", async ({ page }) => {
  await terminalPref(page);
  await sampleFrames(page);
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto("/");
  const row = page.locator(`[data-testid="pane-row"][data-pane-id="${PANES.chat}"]`);
  await expect(row).toBeVisible();
  await page.waitForTimeout(300);
  await row.click();
  await expect(page.locator('[data-slot="chat-input"]')).toBeVisible();
  await expect(page.locator('[data-slot="chrome-block-standin"]')).toHaveCount(0);
  await page.waitForTimeout(400);
  const seen = await frames(page);
  // The prefetched text is on screen in step one, beside the stand-in.
  expect(seen.some((f) => f.standIn && f.tail >= 0)).toBe(true);
  expectNoShift(seen, "all");
  // The stand-in never reaches the accessibility tree: one textbox, the composer's.
  await expect(page.getByRole("textbox")).toHaveCount(1);
});

test("Chat with a saved three-line draft: the stand-in sizes to the draft, nothing moves", async ({ page }) => {
  await stubPaneBridge(page, { [PANES.chat]: TERMINAL_TEXT });
  await page.goto(path(PANES.chat));
  const field = page.locator('[data-slot="chat-input"]');
  await field.fill("line one\nline two\nline three");
  await expect(page.getByTestId("chat-stream")).toBeVisible();

  await sampleFrames(page);
  await page.reload();
  await expect(field).toHaveValue("line one\nline two\nline three");
  await page.waitForTimeout(300);
  expectNoShift(await frames(page), "swap");
  // The draft really is taller than the empty field's 36 px, so the one height above is the draft's.
  expect((await field.boundingBox())?.height ?? 0).toBeGreaterThan(60);
});
