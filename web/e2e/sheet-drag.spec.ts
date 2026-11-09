import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// A SLOW DRAG DOWN ON THE OPEN SWITCH PANE SHEET FOLLOWS THE FINGER, frame by frame, through a poll.
//
// The bug (2026-11-06, Android Chrome): the sheet's drag effect listed `onClose` in its deps, and the
// switcher passes an inline arrow, so every re-render of the pane (a poll, every 1.5s while an agent
// works) re-ran the effect, and its `setDragY(0)` snapped the held sheet back to the top. The next
// touchmove put it back under the finger: a flicker on each poll. `ui/sheet.tsx` now reads `onClose`
// through a ref; `sheet.test.tsx` pins that cause in jsdom.
//
// This case asks the engine: one finger, driven through Chromium's own touch pipeline by CDP
// (`Input.dispatchTouchEvent`), moves down 3px every 80ms for about 2.4s, long enough to span the
// stub pane's poll. Every animation frame records the panel's top and the backdrop's opacity. No frame
// may move the panel up by more than 1px, the panel ends where the finger is, and the backdrop never
// changes. Chromium phone only: CDP touch is Chromium's, and the Switch pill is the phone layout's.

test.use({ serviceWorkers: "block" });

interface SheetFrame {
  top: number;
  opacity: string;
}

declare global {
  interface Window {
    sheetFrames?: SheetFrame[];
    sheetFramesStop?: boolean;
  }
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "a Chromium phone case: CDP touch, one viewport");
  await installApiStub(page);
  await keepPhoneLayout(page);
});

test("a slow drag down on the open switcher follows the finger through a poll", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await page.getByRole("button", { name: en["chat.switcher.aria"] }).click();
  const dialog = page.getByRole("dialog", { name: en["chat.switcher.title"] });
  await expect(dialog).toBeVisible();
  const panel = dialog.locator(':scope > div[tabindex="-1"]');
  // The slide-in entrance is 200ms; wait until the panel has stopped moving before the finger lands.
  await expect
    .poll(async () => {
      const a = await panel.boundingBox();
      await page.waitForTimeout(100);
      const b = await panel.boundingBox();
      return a !== null && b !== null && a.y === b.y;
    })
    .toBe(true);
  const box = await panel.boundingBox();
  if (box === null) throw new Error("the panel has no box");

  await page.evaluate(() => {
    const frames: SheetFrame[] = [];
    window.sheetFrames = frames;
    window.sheetFramesStop = false;
    const tick = () => {
      const dlg = document.querySelector('[role="dialog"]');
      const p = dlg?.querySelector(':scope > div[tabindex="-1"]');
      const b = dlg?.querySelector(":scope > button");
      if (p && b) frames.push({ top: p.getBoundingClientRect().top, opacity: getComputedStyle(b).opacity });
      if (!window.sheetFramesStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const cdp = await page.context().newCDPSession(page);
  const x = Math.round(box.x + box.width / 2);
  // On the grab handle row, the top of the sheet, where a pull-down engages.
  const y0 = Math.round(box.y + 12);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }],
    });

  const TRAVEL = 84;
  await touch("touchStart", y0);
  for (let dy = 3; dy <= TRAVEL; dy += 3) {
    await touch("touchMove", y0 + dy);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(100);
  const frames = await page.evaluate(() => {
    window.sheetFramesStop = true;
    return window.sheetFrames ?? [];
  });
  // Short of the 90px close threshold: the release snaps the sheet back and it stays open.
  await touch("touchEnd", y0 + TRAVEL);

  expect(frames.length).toBeGreaterThan(60);
  const start = frames[0]!.top;
  const against = frames.flatMap((f, i) => (i > 0 && f.top < frames[i - 1]!.top - 1 ? [`${frames[i - 1]!.top - start} -> ${f.top - start}`] : []));
  expect(against).toEqual([]);
  expect(frames.at(-1)!.top - start).toBeCloseTo(TRAVEL, 0);
  expect(new Set(frames.map((f) => f.opacity))).toEqual(new Set([frames[0]!.opacity]));
  await expect(dialog).toBeVisible();
});
