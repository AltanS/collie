import { expect, test, type Page } from "@playwright/test";

import { installApiStub } from "./fixtures/api";
import { wideSnapshot } from "./fixtures/wide-herd";

// THE SIDEBAR'S HEAD ON A LARGE SCREEN (2026-11-21). Under the 48px brand row, one sticky block holds the
// filter field and the summary row: two 36px rows in 8px steps, closed by the one rule, 24px above the
// first group heading. Boxes stand on the list's 8px edge, text and icons on 16, the field's magnifier on
// the rows' icon axis and its text on the rows' names. Every control still reaches 44px. jsdom has no
// layout, so the grid is measured here, at the two widths the sidebar has.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "sets its own viewports; one project is enough");
  await installApiStub(page);
  const snapshot = wideSnapshot({ spaces: 6, blocked: ["w2:p1"], unseen: ["w4:p2", "w5:p2"] });
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(snapshot) }),
  );
});

/** Every box the grid is made of, and the hit area of every control in the head. */
function measure(page: Page) {
  return page.evaluate(() => {
    const side = document.querySelector('[data-slot="wide-sidebar"]')!;
    const box = (sel: string) => side.querySelector(sel)!.getBoundingClientRect();
    const input = side.querySelector<HTMLInputElement>('[data-slot="session-filter"] input')!;
    const row = side.querySelector('[data-slot="pane-row"]')!;
    const rowIcon = row.firstElementChild!.getBoundingClientRect();
    const fieldIcon = box('[data-slot="session-filter"] svg');
    const field = input.getBoundingClientRect();
    const controls = [
      side.querySelector('[data-slot="session-filter"] label')!,
      side.querySelector('[data-slot="sidebar-summary-row"] > button')!,
      ...side.querySelectorAll('[data-slot="sidebar-summary-row"] [role="radio"]'),
    ];
    return {
      width: side.getBoundingClientRect().width,
      brand: box('[data-slot="sidebar-top"]'),
      block: box('[data-slot="sidebar-head-block"]'),
      field,
      summary: box('[data-slot="sidebar-summary-row"]'),
      views: box('[data-slot="sidebar-summary-row"] [role="radiogroup"]'),
      heading: box("section"),
      mark: box('[data-slot="sidebar-mark"] button svg'),
      summaryDot: box('[data-slot="sidebar-summary-row"] > button span span'),
      headingText: box("section h3 span"),
      rowIconX: rowIcon.left,
      rowRight: row.getBoundingClientRect().right,
      rowIconAxis: rowIcon.left + rowIcon.width / 2,
      fieldIconAxis: fieldIcon.left + fieldIcon.width / 2,
      fieldIconSize: fieldIcon.width,
      fieldTextX: field.left + Number.parseFloat(getComputedStyle(input).borderLeftWidth) + Number.parseFloat(getComputedStyle(input).paddingLeft),
      rowNameX: row.querySelector(".font-medium")!.getBoundingClientRect().left,
      // A control's hit area: its box, grown by a transparent `::before` when it has one.
      hits: controls.map((el) => {
        const b = el.getBoundingClientRect();
        const before = getComputedStyle(el, "::before");
        if (before.content === "none" || before.position !== "absolute") return { w: b.width, h: b.height };
        const [l, r, t, u] = [before.left, before.right, before.top, before.bottom].map((v) => Number.parseFloat(v) || 0);
        return { w: b.width - l! - r!, h: b.height - t! - u! };
      }),
    };
  });
}

for (const [label, width, height, sidebar] of [
  ["expanded", 1440, 900, 320],
  ["medium", 820, 1180, 264],
] as const) {
  test(`on a ${label} window (${width} x ${height}) the head stands on the sidebar's grid`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/pane/w1:p1");
    await expect(page.locator('[data-slot="wide-sidebar"] [data-slot="pane-row"]').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const m = await measure(page);
    expect(m.width).toBe(sidebar);

    // The heights: the brand row as tall as the tab strip, two 36px rows in 8px steps, the rule, 24px of air.
    expect(m.brand.top).toBe(0);
    expect(m.brand.height).toBe(48);
    expect(m.block.top).toBe(48);
    expect(m.block.height).toBe(97);
    expect(m.field.top).toBe(56);
    expect(m.field.height).toBe(36);
    expect(m.summary.top).toBe(100);
    expect(m.summary.height).toBe(36);
    expect(m.heading.top - m.block.bottom).toBe(24);

    // One left edge for the ink, one for the boxes, and the same two on the right.
    expect(m.mark.left).toBe(16);
    expect(m.summaryDot.left).toBe(16);
    expect(m.headingText.left).toBe(16);
    expect(m.rowIconX).toBe(17);
    expect(m.field.left).toBe(8);
    // The sidebar's own 1px border is on its right, so the box edge there is 8px inside it, where the rows end.
    expect(m.field.right).toBe(sidebar - 9);
    expect(m.views.right).toBe(sidebar - 9);
    expect(m.rowRight).toBe(sidebar - 9);
    // The magnifier is 16px, on the rows' icon axis; the field's text starts on the rows' names.
    expect(m.fieldIconSize).toBe(16);
    expect(m.fieldIconAxis).toBe(m.rowIconAxis);
    expect(m.fieldTextX).toBe(m.rowNameX);

    // Every control in the head reaches 44px both ways.
    for (const h of m.hits) {
      expect(h.w).toBeGreaterThanOrEqual(44);
      expect(h.h).toBeGreaterThanOrEqual(44);
    }

    // Filtering: the count stands inside the field, beside the clear button, and the head keeps its height.
    const input = page.locator('[data-slot="wide-sidebar"] [data-slot="session-filter"] input');
    await input.fill("space-0");
    const count = page.locator('[data-slot="wide-sidebar"] [data-slot="session-filter-count"]');
    await expect(count).toHaveText(/\d+ of \d+/);
    const countBox = (await count.boundingBox())!;
    const fieldBox = (await input.boundingBox())!;
    expect(countBox.y).toBeGreaterThanOrEqual(fieldBox.y);
    expect(countBox.y + countBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height);
    const clear = page.locator('[data-slot="wide-sidebar"] [data-slot="session-filter"] button');
    const clearHit = await clear.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const before = getComputedStyle(el, "::before");
      return { w: b.width - 2 * Number.parseFloat(before.left), h: b.height - 2 * Number.parseFloat(before.top), right: b.right };
    });
    expect(clearHit.w).toBeGreaterThanOrEqual(44);
    expect(clearHit.h).toBeGreaterThanOrEqual(44);
    expect(countBox.x + countBox.width).toBeLessThanOrEqual(clearHit.right - 36);
    expect((await measure(page)).block.height).toBe(97);
  });
}
