import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE TOP OF THE DASHBOARD, measured in a real engine (2026-10-07, "One control bar"). Under the
// header: ONE line of state words with the needs-you switch at its right end, then ONE row holding
// the workspace select and the order select (`components/agent-list.tsx`, `dash-selects.tsx`).
//
// The line must stay one line at 360, 390 and 412px. jsdom has no layout, so the degrade rule is
// unit-tested against a fake one (`status-counts.test.tsx`); this is the engine that settles it:
// the row never overflows its slot, every visible count sits on one baseline, and the page never
// scrolls sideways. This replaced the filter strip's case, whose subject (a sideways chip scroller)
// is gone.
//
// Selectors are a role and an accessible name, never a class and never a testid.

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no dashboard route");
  test.skip(testInfo.project.name === "app-tablet", "a phone-width case; the tablet run would repeat it");
  await installApiStub(page);
});

const workspace = (page: Page) => page.getByRole("combobox", { name: en["home.workspaceFilter.aria"] });
const order = (page: Page) => page.getByRole("combobox", { name: en["paneOrder.aria"] });
const needsYou = (page: Page) => page.getByRole("button", { name: en["home.needsYouOnly"] });
const summary = (page: Page) => page.getByRole("main").getByRole("button", { name: /^(\d+ needs you|Nothing needs you)/u });

for (const width of [360, 390, 412]) {
  test(`the summary is one line, and the two selects share one row, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(workspace(page)).toBeVisible();
    await expect(summary(page)).toBeVisible();

    const row = await summary(page).evaluate((button) => {
      const counts = button.querySelector<HTMLElement>("span.tabular-nums");
      if (counts === null) throw new Error("no counts row");
      const items = Array.from(counts.children).filter((c) => !c.classList.contains("sr-only"));
      return {
        overflows: counts.scrollWidth - counts.clientWidth > 1,
        tops: new Set(items.map((c) => Math.round(c.getBoundingClientRect().top))).size,
        height: counts.getBoundingClientRect().height,
        pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(row.overflows).toBe(false);
    // One top for every visible count: nothing wrapped onto a second line.
    expect(row.tops).toBe(1);
    expect(row.height).toBeLessThan(24);
    expect(row.pageScrolls).toBe(false);

    // The switch ends the summary's row; both selects share the row under it, workspace first.
    const [sum, sw, ws, ord] = await Promise.all([summary(page), needsYou(page), workspace(page), order(page)].map((l) => l.boundingBox()));
    expect(sw!.x).toBeGreaterThan(sum!.x);
    expect(Math.abs(sw!.y + sw!.height / 2 - (sum!.y + sum!.height / 2))).toBeLessThan(4);
    expect(ws!.y).toBeGreaterThan(sum!.y + sum!.height - 1);
    expect(Math.abs(ws!.y - ord!.y)).toBeLessThan(1);
    expect(ord!.x).toBeGreaterThan(ws!.x + ws!.width - 1);
    expect(ws!.height).toBeGreaterThanOrEqual(44);
    expect(ord!.height).toBeGreaterThanOrEqual(44);
    expect(ord!.x + ord!.width).toBeLessThanOrEqual(width);
  });
}

test("the workspace select shows one workspace alone and the order select re-ranks, both remembered", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "webapp" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "collie" })).toBeVisible();

  const collie = await workspace(page).getByRole("option", { name: /^collie/u }).textContent();
  await workspace(page).selectOption({ label: collie! });
  await expect(page.getByRole("heading", { name: "webapp" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "collie" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "webapp" })).toHaveCount(0);

  await workspace(page).selectOption("all");
  await order(page).selectOption("activity");
  await expect(page.getByRole("heading", { name: new RegExp(`^${en["paneOrder.recent"]}`, "u") })).toBeVisible();
  await page.reload();
  await expect(order(page)).toHaveValue("activity");
});
