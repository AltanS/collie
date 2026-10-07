import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// THE PANE SCREEN'S TWO STRIPS, measured in a real engine (option 3 of the 2026-09-23 top-bar
// deck). The tab row is 30px and the pane row 26px, and neither draws a tap floor's worth of
// height, so the floor is an invisible `::before` that hangs DOWN out of each row (it cannot go
// up: the route's scroller clips at the header's bottom edge). jsdom lays nothing out, so only a
// real engine can say what a thumb actually hits. Every probe here is `elementFromPoint`.
//
// The numbers (1.18.0): the tap areas were limited to their own rows, because a floor that hung
// 14 to 18px below the row sat over the first line of the content and a path link there opened a
// tab instead (CHANGELOG, "A link right under the tab row takes the tap"). A tab answers its own
// 30px row and a pane pill its own 26px row; the width stays at least 44px (the `before:-inset-x`
// reach, `TAB_ROW_SQUARE_TAP_TARGET`). Nothing below a row answers its pill.
//
// A tab that holds two panes is the fixture's shell pane moved into the `code` tab: derived from
// the shared fixture, not invented.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("states"), "the playground has no pane route");
  await installApiStub(page);
});

const twoPaneSnapshot = {
  ...fixtureSnapshot,
  shellPanes: fixtureSnapshot.shellPanes.map((p) => Object.assign({}, p, { tabId: "w2:t1" })),
};

const tabNav = (page: Page) => page.getByRole("navigation", { name: en["space.tabStrip.title"] });
const paneNav = (page: Page) => page.getByRole("navigation", { name: en["space.paneStrip.title"] });

/** The run of pixels, straight down through the button's centre, that land on the button. */
function hitSpan(nav: Locator, name: string) {
  // Anchored at the end: a tab's name opens with its status in words ("working code").
  const named = new RegExp(`(^| )${name}$`);
  return nav.getByRole("button", { name: named }).evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const on = (py: number) => button.contains(document.elementFromPoint(x, py));
    let top = y;
    let bottom = y;
    while (top > 0 && on(top - 1)) top -= 1;
    while (bottom < window.innerHeight && on(bottom + 1)) bottom += 1;
    // And the same probe sideways, through the button's centre line.
    const onX = (px: number) => button.contains(document.elementFromPoint(px, y));
    let left = x;
    let right = x;
    while (left > 0 && onX(left - 1)) left -= 1;
    while (right < window.innerWidth && onX(right + 1)) right += 1;
    return { top, bottom, height: bottom - top + 1, left, right, width: right - left + 1 };
  });
}

async function rowHeights(page: Page) {
  const tabs = await tabNav(page).boundingBox();
  const panes = (await paneNav(page).count()) > 0 ? await paneNav(page).boundingBox() : null;
  return { tabs: tabs!.height, panes: panes?.height ?? null, tabsBottom: tabs!.y + tabs!.height };
}

test("a tab alone answers its own row, all of it below the header", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(tabNav(page)).toBeVisible();

  const { tabs, panes, tabsBottom } = await rowHeights(page);
  expect(panes).toBeNull();
  expect(tabs).toBeCloseTo(30, 0);

  for (const name of ["code", "shell", en["space.tabStrip.new.aria"]]) {
    const span = await hitSpan(tabNav(page), name);
    // The hit area is the row: it ends at the row's own bottom edge, and nothing below answers.
    expect(span.height, name).toBeCloseTo(tabs, 0);
    // Sideways a text tab answers its drawn box (`min-w-11`), less the few pixels at its trailing
    // edge that the "+" reach (-9px, past a 6px gap) takes; the "+" answers its full 44.
    expect(span.width, name).toBeGreaterThanOrEqual(name === en["space.tabStrip.new.aria"] ? 44 : 40);
    expect(span.bottom + 1, name).toBeLessThanOrEqual(tabsBottom + 0.5);
    // Not one pixel of the header: its own 44px buttons keep theirs.
    expect(span.top, name).toBeGreaterThanOrEqual(tabsBottom - tabs - 0.5);
  }
});

test("under a pane row, the boundary is the rows' shared edge and a pill answers its own row", async ({ page }) => {
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(twoPaneSnapshot) }),
  );
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(paneNav(page)).toBeVisible();

  const { tabs, panes, tabsBottom } = await rowHeights(page);
  expect(tabs).toBeCloseTo(30, 0);
  expect(panes).toBeCloseTo(26, 0);

  // The tab keeps its own row and gives up the reach: the pane row owns every pixel of its box.
  const tab = await hitSpan(tabNav(page), "code");
  expect(Math.abs(tab.bottom + 1 - tabsBottom)).toBeLessThanOrEqual(1);
  const row = (await paneNav(page).boundingBox())!;
  for (const probeX of [row.x + 4, row.x + row.width / 2, row.x + row.width - 4]) {
    const owner = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest("nav")?.getAttribute("aria-labelledby") ?? null,
      [probeX, tabsBottom + 1] as const,
    );
    expect(owner, `x=${probeX}`).not.toBeNull();
  }

  for (const name of ["codex", "shell"]) {
    const pill = await hitSpan(paneNav(page), name);
    expect(pill.height, name).toBeCloseTo(panes!, 0);
    expect(pill.width, name).toBeGreaterThanOrEqual(44);
    // It starts on the shared edge, never inside the tab row.
    expect(pill.top, name).toBeGreaterThanOrEqual(tabsBottom - 1);
    // It ends at the pane row's own bottom edge: the first line of content under the row is not
    // the pill's.
    expect(pill.bottom + 1, name).toBeLessThanOrEqual(row.y + row.height + 0.5);
    const below = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest("nav")?.getAttribute("aria-labelledby") ?? null,
      [(pill.left + pill.right) / 2, row.y + row.height + 1] as const,
    );
    expect(below, `${name} below the row`).toBeNull();
  }

  // Beside the pills the reach is not claimed: the mirror under the row's blank stretch still
  // takes the tap.
  const blank = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest("nav") ?? null,
    [row.x + row.width - 20, tabsBottom + 30] as const,
  );
  expect(blank).toBeNull();
});

test("neither strip scrolls vertically", async ({ page }) => {
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(twoPaneSnapshot) }),
  );
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(paneNav(page)).toBeVisible();

  for (const nav of [tabNav(page), paneNav(page)]) {
    const box = await nav.evaluate((navEl) => {
      const el = [...navEl.children].find((c) => getComputedStyle(c).overflowX === "auto")!;
      el.scrollTop = 20;
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
    });
    expect(box.scrollHeight).toBe(box.clientHeight);
    expect(box.scrollTop).toBe(0);
  }
});

test("opening a tab moves no neighbour", async ({ page }) => {
  await page.goto(`/pane/${encodeURIComponent("w2:p1")}`);
  await expect(tabNav(page).getByRole("button", { name: /code$/ })).toHaveAttribute("aria-current", "true");

  // Semibold is wider than medium: each label reserves its semibold width, so the row holds still.
  const widths = () =>
    tabNav(page)
      .getByRole("button")
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width * 10) / 10));
  const before = await widths();
  await page.goto(`/pane/${encodeURIComponent("w2:p2")}`);
  await expect(tabNav(page).getByRole("button", { name: "shell" })).toHaveAttribute("aria-current", "true");
  expect(await widths()).toEqual(before);
});
