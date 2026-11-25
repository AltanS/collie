import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import type { SnapshotResponse } from "@/lib/types";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { openSwitcher } from "./fixtures/actions";

// THE PENCIL ON A PANE'S ROW (ui/draft-mark.tsx): a pane that holds an unsent draft on this device wears a small
// muted pencil on its row in every list of panes. Two things are asked of a real browser. One: the mark follows the
// composer live, with no reload, as a person types, walks back to the list, and clears. Two: with a long pane name
// at 390 and 360 px, and in the sidebar at its narrowest, the NAME is what gives way: the pencil's slot is kept, so
// nothing beside it moves, and nothing overlaps. jsdom has no layout, so the boxes are measured here.

test.use({ serviceWorkers: "block" });

const PANE_A = `/pane/${encodeURIComponent("w1:p1")}`;
const DRAFT_KEY = "collie:draft:v2:default:w1:p1";
const LONG = "a pane name that is much too long for one row of a phone, so it has to be cut";

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no routes");
  // The phone cases run in the phone project and set their own widths; the large-screen case sets its own
  // viewport, so one project is enough for it.
  const phoneCase = testInfo.titlePath.includes("on a phone");
  test.skip(phoneCase && testInfo.project.name !== "app-phone", "a phone case");
  test.skip(!phoneCase && testInfo.project.name !== "app-tablet", "a large-screen case");
  await installApiStub(page);
});

/** A snapshot whose first pane has a name that cannot fit. */
async function withLongName(page: Page): Promise<void> {
  const snapshot: SnapshotResponse = structuredClone(fixtureSnapshot);
  snapshot.agents[0]!.paneLabel = LONG;
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
}

/** Another tab of this browser saves a draft for the pane: the disk write and the `storage` event it sends. */
function otherTabSaves(page: Page): Promise<void> {
  return page.evaluate((key) => {
    localStorage.setItem(key, JSON.stringify({ text: "typed in another tab", at: Date.now() }));
    window.dispatchEvent(new StorageEvent("storage", { key }));
  }, DRAFT_KEY);
}

/** The boxes of a row and of its name and pencil, in CSS px. `nameSel` finds the name inside the row. */
function boxes(row: Locator, nameSel: string) {
  return row.evaluate((el, sel) => {
    const name = el.querySelector<HTMLElement>(sel)!;
    const mark = el.querySelector('[data-slot="draft-mark"]')!;
    const first = (el.querySelector('[data-slot="agent-row-title"]')?.firstElementChild ?? name).getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const n = name.getBoundingClientRect();
    const m = mark.getBoundingClientRect();
    return {
      rowHeight: r.height,
      rowRight: r.right,
      first: first.left,
      nameLeft: n.left,
      nameRight: n.right,
      nameWidth: n.width,
      cut: name.scrollWidth > name.clientWidth,
      markLeft: m.left,
      markRight: m.right,
      markWidth: m.width,
      on: mark.getAttribute("data-on"),
    };
  }, nameSel);
}

const rowOf = (page: Page, agent: "claude" | "codex") =>
  page.getByRole("main").getByRole("button", { name: new RegExp(`^${agent} logo ${agent}`, "u") });
const pencil = (within: Locator) => within.getByRole("img", { name: en["pane.draftMark"] });

test.describe("on a phone", () => {
  test("the pencil comes while the composer holds words, and goes when they are cleared", async ({ page }) => {
    await page.goto("/");
    await expect(rowOf(page, "claude")).toBeVisible();
    await expect(pencil(rowOf(page, "claude"))).toHaveCount(0);

    await rowOf(page, "claude").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(PANE_A);
    await page.getByRole("textbox", { name: en["composer.placeholder.reply"] }).fill("a half-written reply");

    // Back to the list, no reload: the row of that pane has the pencil and the other row has none.
    await page.goBack();
    await expect(rowOf(page, "claude")).toBeVisible();
    await expect(pencil(rowOf(page, "claude"))).toHaveCount(1);
    await expect(pencil(rowOf(page, "codex"))).toHaveCount(0);

    // Open the pane, clear the box with its X, go back: the pencil is gone.
    await rowOf(page, "claude").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(PANE_A);
    await page.getByRole("button", { name: en["composer.controls.clear"], exact: true }).click();
    await page.goBack();
    await expect(rowOf(page, "claude")).toBeVisible();
    await expect(pencil(rowOf(page, "claude"))).toHaveCount(0);
  });

  for (const width of [390, 360]) {
    test(`at ${width}px a long name is cut for the dashboard row's pencil and nothing else moves`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await withLongName(page);
      await page.goto("/");
      // Named by its long name now, so not by the agent's word.
      const row = page.getByRole("main").getByRole("button").filter({ hasText: LONG.slice(0, 20) });
      await expect(row).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      const measure = () => boxes(row, '[data-glide="name"]');

      const before = await measure();
      expect(before.on).toBe("false");
      expect(before.cut).toBe(true);

      await otherTabSaves(page);
      await expect(pencil(row)).toHaveCount(1);
      const after = await measure();
      expect(after.on).toBe("true");
      // The name is what is cut, and it ends before the pencil begins.
      expect(after.cut).toBe(true);
      expect(after.nameRight).toBeLessThanOrEqual(after.markLeft + 0.5);
      expect(after.markRight).toBeLessThanOrEqual(after.rowRight);
      // The slot was kept: the row, the first mark, the name and the pencil's box stand where they stood.
      expect(after.rowHeight).toBeCloseTo(before.rowHeight, 1);
      expect(after.first).toBe(before.first);
      expect(after.nameLeft).toBe(before.nameLeft);
      expect(after.nameWidth).toBe(before.nameWidth);
      expect(after.markLeft).toBe(before.markLeft);
      expect(after.markWidth).toBeLessThanOrEqual(12);
    });
  }

  for (const width of [390, 360]) {
    test(`at ${width}px the Switch pane sheet's row cuts the name for the pencil`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await withLongName(page);
      // The open pane is the other one, so the long-named pane is a row of the sheet.
      await page.goto("/pane/w2:p1");
      await openSwitcher(page);
      const sheet = page.getByRole("dialog", { name: en["chat.switcher.aria"] });
      const row = sheet.locator('[data-slot="pane-row"]').filter({ hasText: LONG.slice(0, 20) });
      await expect(row).toBeVisible();
      await page.evaluate(() => document.fonts.ready);

      const measure = () => boxes(row, ".font-medium");
      const before = await measure();
      await otherTabSaves(page);
      await expect(pencil(row)).toHaveCount(1);
      const after = await measure();
      expect(after.cut).toBe(true);
      expect(after.nameRight).toBeLessThanOrEqual(after.markLeft + 0.5);
      expect(after.markRight).toBeLessThanOrEqual(after.rowRight);
      expect(after.rowHeight).toBeCloseTo(before.rowHeight, 1);
      expect(after.nameLeft).toBe(before.nameLeft);
      expect(after.nameWidth).toBe(before.nameWidth);
    });
  }
});

test.describe("on a large screen", () => {
  test("the sidebar's row at its narrowest cuts the name for the pencil, and the open pane's row has none", async ({ page }) => {
    // 820 px wide is the medium window, where the sidebar is 264 px, its narrowest.
    await page.setViewportSize({ width: 820, height: 1180 });
    await withLongName(page);
    await page.goto("/pane/w2:p1");
    const side = page.locator('[data-slot="wide-sidebar"]');
    await expect(side.locator('[data-slot="pane-row"]').first()).toBeVisible();
    expect((await side.boundingBox())!.width).toBe(264);
    await page.evaluate(() => document.fonts.ready);
    const row = side.locator('[data-slot="pane-row"]').filter({ hasText: LONG.slice(0, 20) });

    const measure = () => boxes(row, ".font-medium");
    const before = await measure();
    await otherTabSaves(page);
    await expect(pencil(row)).toHaveCount(1);
    const after = await measure();
    expect(after.cut).toBe(true);
    expect(after.nameRight).toBeLessThanOrEqual(after.markLeft + 0.5);
    expect(after.markRight).toBeLessThanOrEqual(after.rowRight);
    expect(after.rowHeight).toBeCloseTo(before.rowHeight, 1);
    expect(after.nameLeft).toBe(before.nameLeft);
    expect(after.nameWidth).toBe(before.nameWidth);

    // A draft for the pane that is open draws no pencil on its own row: its composer is on screen.
    await page.evaluate(() => {
      const key = "collie:draft:v2:default:w2:p1";
      localStorage.setItem(key, JSON.stringify({ text: "typed here", at: Date.now() }));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    const open = side.locator('[data-slot="pane-row"][aria-current="page"]');
    await expect(open).toHaveCount(1);
    await expect(pencil(open)).toHaveCount(0);
  });
});
