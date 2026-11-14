import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub, paneCapture } from "./fixtures/api";

// A PERMISSION CARD WITH A LONG SUBJECT FITS THE DOCK, BY LAYOUT (2026-11-12). The dock is a flex
// column (card-dock.tsx) and the card fits it (PromptPanel's `fit`): the caption, the cut line, the
// question, the note lines and every button keep their full height, and the subject box is the one
// part that shrinks, never under three rows, scrolled inside and opened at its bottom. The dock is
// bounded by the column, not by its 55dvh cap (the reading floor above it, agent-chat.tsx #667), so
// only a real layout engine can say whether the buttons are on screen; jsdom has no layout at all.
// The numbers each case measured are printed to the log.

const DOCK = '[data-slot="card-dock"]';

/** The three phone sizes: a common Android, the iPhone 14/15, and a short one (a phone with
 *  Chrome's toolbars out, or a small one). */
const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 360, height: 560 },
] as const;

/** Claude Code 2.1.322: a heredoc command taller than the screen, so its dialog starts above the read.
 *  The subject is the end of the command and the "Dangerous rm" warning under it. */
const CUT_TOP = paneCapture("claude--v2322-permission-bash-cut-top--w160");

/** An uncut dialog with a 40-row subject and three options: the "Create file" permission with its
 *  one-row body made 40 rows long. */
function tallCreateFile(): string {
  const source = paneCapture("claude--permission-edit");
  const rows = source.split("\r\n");
  // The row is styled: its "1" and its "hello" are separate runs.
  const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const at = rows.findIndex((row) => row.replace(sgr, "").trim() === "1 hello");
  if (at < 0) throw new Error("the permission-edit capture lost its one body row");
  const body = Array.from({ length: 40 }, (_, i) => `  ${String(i + 1).padStart(2)} body row ${i + 1} of a long new file`);
  return [...rows.slice(0, at), ...body, ...rows.slice(at + 1)].join("\r\n");
}

async function servePane(page: Page, text: string): Promise<void> {
  await installApiStub(page);
  await page.route(/\/api\/pane\/[^/?]+(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ paneId: "w1:p1", text, truncated: false, revision: 1 }),
    }),
  );
}

/** What the card looks like inside the dock, in CSS px. A part is "in" when its whole box is inside
 *  the dock's box (half a pixel of slack for sub-pixel rounding). */
interface Fit {
  dock: { clientHeight: number; scrollHeight: number; scrollTop: number; top: number; bottom: number };
  viewportHeight: number;
  /** The chat box above the dock, for the log: what the card left of it. */
  readingHeight: number;
  subject: { height: number; scrollTop: number; scrollHeight: number; atBottom: boolean; minHeight: number } | null;
  questionIn: boolean;
  cutLineIn: boolean | null;
  offlineNoteIn: boolean | null;
  warningIn: boolean | null;
  options: { label: string; in: boolean }[];
}

async function measure(page: Page): Promise<Fit> {
  return page.evaluate((dockSelector) => {
    const dock = document.querySelector<HTMLElement>(dockSelector)!;
    const d = dock.getBoundingClientRect();
    // Half a pixel of slack for sub-pixel rounding.
    const slack = 0.5;
    const within = (r: DOMRect, outer: DOMRect) => r.top >= outer.top - slack && r.bottom <= outer.bottom + slack;
    const inDock = (el: Element | null) => (el === null ? null : within(el.getBoundingClientRect(), d));
    const pre = dock.querySelector<HTMLElement>('[data-slot="prompt-subject"] pre');
    // The warning's TEXT, the inner span. The tone span holds the line break that starts its row, and
    // WebKit counts that break as a box on the end of the row above (a row scrolled half out of the
    // subject box), so its bounding rect reaches up past the box while every glyph is inside.
    const warning = dock.querySelector('[data-slot="prompt-subject"] pre [data-tone="warning"] > span');
    // The warning must be on screen twice over: inside the subject box's visible part, and that part
    // inside the dock.
    const warningIn =
      warning === null || pre === null
        ? null
        : within(warning.getBoundingClientRect(), pre.getBoundingClientRect()) && within(pre.getBoundingClientRect(), d);
    const options = [...dock.querySelectorAll<HTMLButtonElement>("button")]
      .filter((b) => !b.matches('[data-slot="card-view-toggle"]'))
      .map((b) => ({ label: (b.textContent ?? "").trim(), in: within(b.getBoundingClientRect(), d) }));
    return {
      dock: { clientHeight: dock.clientHeight, scrollHeight: dock.scrollHeight, scrollTop: dock.scrollTop, top: d.top, bottom: d.bottom },
      viewportHeight: window.innerHeight,
      readingHeight: Math.round(document.querySelector('[data-slot="pane-reading"]')?.getBoundingClientRect().height ?? -1),
      subject:
        pre === null
          ? null
          : {
              height: pre.clientHeight,
              scrollTop: Math.round(pre.scrollTop),
              scrollHeight: pre.scrollHeight,
              atBottom: pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 1,
              minHeight: Number.parseFloat(getComputedStyle(pre.parentElement!).minHeight),
            },
      questionIn: inDock(dock.querySelector('[data-slot="prompt-question"]'))!,
      cutLineIn: inDock(dock.querySelector('[data-slot="prompt-subject-cut"]')),
      offlineNoteIn: inDock(dock.querySelector('[data-slot="prompt-offline-note"]')),
      warningIn,
      options,
    };
  }, DOCK);
}

/** The rule every case holds: nothing but the subject box gives up height, so with the dock at its
 *  top the question, the warning, the note lines and every button are inside it, and the subject box
 *  shows its last row. */
function expectFits(fit: Fit, want: { options: number; warning: boolean; cut: boolean }): void {
  expect(fit.dock.scrollTop).toBe(0);
  expect(fit.dock.scrollHeight).toBeLessThanOrEqual(fit.dock.clientHeight + 1);
  expect(fit.dock.bottom).toBeLessThanOrEqual(fit.viewportHeight);
  expect(fit.questionIn).toBe(true);
  expect(fit.options).toHaveLength(want.options);
  for (const option of fit.options) expect(option, option.label).toMatchObject({ in: true });
  expect(fit.subject).not.toBeNull();
  expect(fit.subject!.atBottom).toBe(true);
  expect(fit.subject!.height).toBeGreaterThanOrEqual(fit.subject!.minHeight - 1);
  if (want.warning) expect(fit.warningIn).toBe(true);
  if (want.cut) expect(fit.cutLineIn).toBe(true);
  if (fit.offlineNoteIn !== null) expect(fit.offlineNoteIn).toBe(true);
}

async function openCard(page: Page): Promise<void> {
  await page.goto("/pane/w1:p1");
  const dock = page.locator(DOCK);
  await expect(dock.locator('[data-slot="prompt-question"]')).toBeVisible();
  await expect(dock.locator('[data-slot="prompt-subject"] pre')).toBeVisible();
  // The box opens at its bottom in an effect after the first paint; give it a frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// No service worker: once it claims the page, `page.route` no longer sees the pane reads.
test.use({ serviceWorkers: "block" });

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name === "app-tablet", "phone sizes; each case sets its own viewport");
});

for (const viewport of VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;

  test(`${size}: a dialog cut at the top shows its cut line, warning, question and both buttons`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await servePane(page, CUT_TOP);
    await openCard(page);
    const fit = await measure(page);
    console.log(`fit cut-top ${size} ${JSON.stringify(fit)}`);
    expectFits(fit, { options: 2, warning: true, cut: true });
  });

  test(`${size}: offline, the Reconnect line fits too`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await servePane(page, CUT_TOP);
    await openCard(page);
    await context.setOffline(true);
    await expect(page.locator(DOCK).locator('[data-slot="prompt-offline-note"]')).toHaveText(en["prompt.reconnectNote"]);
    const fit = await measure(page);
    console.log(`fit offline ${size} ${JSON.stringify(fit)}`);
    expect(fit.offlineNoteIn).toBe(true);
    expectFits(fit, { options: 2, warning: true, cut: true });
  });

  test(`${size}: an uncut dialog with a 40-row subject shows its question and three buttons`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await servePane(page, tallCreateFile());
    await openCard(page);
    const fit = await measure(page);
    console.log(`fit uncut-40 ${size} ${JSON.stringify(fit)}`);
    expect(fit.cutLineIn).toBeNull();
    expectFits(fit, { options: 3, warning: false, cut: false });
    // The last row of the subject is the one in view.
    await expect(page.locator(DOCK).locator('[data-slot="prompt-subject"] pre')).toContainText("body row 40 of a long new file");
  });
}

// THE KEYBOARD. With the composer focused and the visual viewport shorter (hooks/use-keyboard.ts), the
// dock's cap drops to 40dvh and the reading floor to 20dvh. The same rule holds while the three-row
// minimum fits; below that the buttons keep their size, the subject keeps three rows and the dock
// scrolls, from its top.
test("with the keyboard up the card still fits a 390x844 phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await servePane(page, CUT_TOP);
  await openCard(page);
  await page.getByRole("textbox", { name: en["composer.placeholder.reply"] }).focus();
  // A 336 px keyboard, about Gboard's portrait height on this width.
  await page.setViewportSize({ width: 390, height: 508 });
  await expect(page.locator(DOCK)).toHaveClass(/max-h-\[40dvh\]/);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const fit = await measure(page);
  console.log(`fit keyboard 390x844-336 ${JSON.stringify(fit)}`);
  expectFits(fit, { options: 2, warning: true, cut: true });
});
