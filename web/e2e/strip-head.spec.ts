import { expect, test, type Page } from "@playwright/test";

import { SHIPPED_THEME_IDS } from "@/lib/theme/schema";

import { contrast, hex, ink, installStripHeadWorld, lowerEdge, LONG_TAB, openTwoColumns, pixels, shippedLook, wear } from "./fixtures/strip-head";

// THE LARGE SCREEN'S TAB BAR AND PANE HEADER, IN BOTH TAB LOOKS AND EVERY BUNDLED THEME (strip-head round, ADR
// 0171). The bar stands on the firm edge (`--edge-firm`) and a 6px page band; under `folder` the open tab is cut
// from that band, under `plain` it stands on the edge with a 2px bar of ink. Read from the painted pixels: text
// at 4.5:1, marks, icons and the two edges at 3:1, in each theme's own look and in the other one, both halves.
// And the band costs the transcript nothing: the headers are 6px shorter, so every column's body starts where
// it did (111px from the top, 48 + 2 + 61 before the band).

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "sets its own viewport; one project is enough");
  await page.setViewportSize({ width: 1440, height: 900 });
  await installStripHeadWorld(page);
});

const BAR = '[data-slot="space-header"]';
const FOCUSED = '[data-slot="wide-layout"] section[data-focused]';
const OTHER = '[data-slot="wide-layout"] section[data-col-key]:not([data-focused])';

const tab = (page: Page, text: string) => page.locator(`${BAR} nav button`).filter({ hasText: text });
const label = (page: Page, text: string) => tab(page, text).locator("span.grid > span:nth-child(2)");

const CASES = SHIPPED_THEME_IDS.flatMap((id) =>
  (["dark", "light"] as const).flatMap((scheme) => (["folder", "plain"] as const).map((look) => ({ id, scheme, look, own: look === shippedLook(id) }))),
);

for (const { id, scheme, look, own } of CASES) {
  test(`the bar and the header hold their contrast (${id} ${scheme}, ${look}${own ? "" : ", the other look"})`, async ({ page }) => {
    await wear(page, id, scheme, look);
    await openTwoColumns(page);
    const head = page.locator(`${FOCUSED} header[data-slot="app-header"]`);
    const other = page.locator(`${OTHER} [data-slot="column-header"]`);
    const text = {
      "an unselected tab": await ink(label(page, "build")),
      "the selected tab": await ink(label(page, "main")),
      "the pane's name": await ink(head.locator('[data-slot="pane-name"]')),
      "the branch line": await ink(head.locator('[data-slot="branch-label"]')),
      "the place line's machine": await ink(head.locator('[data-slot="pane-meta"] > *').first()),
      "the place line's time": await ink(head.locator('[data-slot="cache-chip"]')),
      "the width": await ink(page.locator(`${FOCUSED} [data-slot="column-width"]`), 4),
      "a name without focus": await ink(other.locator("span.truncate").first()),
    };
    for (const [what, r] of Object.entries(text)) expect(r.ratio, `${what}: ${r.fg} on ${r.bg}`).toBeGreaterThanOrEqual(4.5);
    const marks = {
      "a working tab's mark": await ink(tab(page, "build").locator("> span").first()),
      "an idle tab's ring": await ink(tab(page, LONG_TAB).locator("> span").first()),
      "a needs-you tab's mark": await ink(tab(page, "review").locator("> span").first()),
      "the pane menu": await ink(head.getByRole("button", { name: "Pane actions" }).locator("svg")),
      "remove from view": await ink(page.locator(`${FOCUSED} [data-slot="column-remove"] svg`)),
      "new tab": await ink(page.locator(BAR).getByRole("button", { name: "New tab" }).locator("svg")),
    };
    for (const [what, r] of Object.entries(marks)) expect(r.ratio, `${what}: ${r.fg} on ${r.bg}`).toBeGreaterThanOrEqual(3);

    // The bar's edge, away from the tabs, and the two headers' lower edges: 3:1 against both sides.
    const bar = page.locator(BAR);
    const barBox = (await bar.boundingBox())!;
    const edges = {
      "the bar": await lowerEdge(page, bar, barBox.x + barBox.width * 0.6),
      "the focused header": await lowerEdge(page, head, ((await head.boundingBox())?.x ?? 0) + 8),
      "the header without focus": await lowerEdge(page, other, ((await other.boundingBox())?.x ?? 0) + 8),
    };
    for (const [what, e] of Object.entries(edges)) {
      expect(e.above, `${what}'s edge ${e.line} against the ground above`).toBeGreaterThanOrEqual(3);
      expect(e.below, `${what}'s edge ${e.line} against the ground below`).toBeGreaterThanOrEqual(3);
    }

    // The open tab: under `folder` its fill runs through the edge into the band in one colour; under `plain` a
    // 2px bar of ink stands on the edge. The edge is the theme's border width (Nightwatch draws 2px).
    const open = (await tab(page, "main").boundingBox())!;
    const bottom = barBox.y + barBox.height;
    const w = await bar.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderBottomWidth));
    const column = await pixels(page, { x: Math.round(open.x + open.width / 2), y: bottom - 8, width: 1, height: 12 });
    // The column is 12 CSS pixels tall at whatever scale the screenshot comes back in; read the middle of a CSS row.
    const scale = column.length / 12;
    const at = (cssDy: number) => column[Math.floor((8 + cssDy + 0.5) * scale)] ?? [0, 0, 0];
    const trace = column.map(hex).join(" ");
    if (look === "folder") {
      expect(contrast(at(-1), at(3)), `the folder's fill and the band are one colour, no edge between them: ${trace}`).toBeLessThan(1.05);
    } else {
      expect(contrast(at(-w - 1), at(-w - 4)), `the bar of ink against the tab's own ground: ${trace}`).toBeGreaterThanOrEqual(3);
    }
  });
}

test("the band costs the transcript nothing: both bodies start 110px down, a pixel higher with the 1px frame", async ({ page }) => {
  await wear(page, "collie", "dark", "folder");
  await openTwoColumns(page);
  const band = (await page.locator('[data-slot="space-band"]').boundingBox())!;
  expect(band.y).toBe(48);
  expect(band.height).toBe(6);
  const focused = await page.locator(`${FOCUSED} header[data-slot="app-header"]`).evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
  const other = await page.locator(`${OTHER} [data-slot="column-header"]`).evaluate((el) => Math.round(el.getBoundingClientRect().bottom));
  // 111 with the old 2px frame; the hairline of ADR 0174 is 1px, so the column's content starts a pixel higher.
  expect(focused).toBe(110);
  // A column without focus has no 1px of its own header border under the row: 109.
  expect(other).toBe(109);
});

test("the bar reads as three groups: the controls stand behind one hairline", async ({ page }) => {
  await wear(page, "collie", "dark", "folder");
  await openTwoColumns(page);
  const group = page.locator(`${BAR} [data-slot="space-controls"]`);
  await expect(group.locator('[data-slot="space-position"]')).toHaveText("space 1 of 5");
  await expect(group.getByRole("button", { name: "Actions" })).toBeVisible();
  await expect(group.getByRole("button", { name: /previous space/i })).toBeVisible();
  await expect(group.getByRole("button", { name: /next space/i })).toBeVisible();
  expect(await group.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("1px");
});
