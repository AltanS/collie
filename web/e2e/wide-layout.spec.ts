import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import { keepPhoneLayout } from "./fixtures/layout";

// THE LARGE-SCREEN LAYOUT APPEARS ON THE TABLET (ADR 0120). From 600px wide and 480px tall the pane
// screen is a sidebar beside a strip, and the belt's Switch pill is not drawn, because the sidebar is
// the switcher. Large-screen layout set to Off brings the phone pane screen back at the same size.
// `app-tablet` (820x1180) is the one project past that line; the phone pane specs run with Off
// (`fixtures/layout.ts`), so this is where Auto is held to drawing the large-screen layout.

test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "the large-screen layout starts at 600px wide");
  await installApiStub(page);
});

test("on Auto the pane screen is a sidebar beside a strip, with no Switch pill", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="wide-layout"]')).toBeVisible();
  await expect(page.getByRole("complementary", { name: en["wide.sidebar.label"] })).toBeVisible();
  await expect(page.locator('[data-slot="composer-actions"]')).toBeVisible();
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toHaveCount(0);
});

test("on Off the same window keeps the phone pane screen", async ({ page }) => {
  await keepPhoneLayout(page);
  await page.goto("/pane/w1:p1");
  await expect(page.getByRole("button", { name: en["chat.switcher.aria"] })).toBeVisible();
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(0);
});

test("a wide line inside a column never widens the column or the page", async ({ page }) => {
  // 820 less the medium sidebar leaves a strip under two panes: not wide mode, one column at the strip's width.
  await page.goto("/pane/w1:p1");
  const column = page.locator('[data-slot="wide-layout"] section[data-col-key]').first();
  await expect(column).toBeVisible();
  // A mirror row, a table or a status footer that will not wrap: 2000px of unbreakable text.
  await column.locator('[data-strip-focus]').evaluate((el) => {
    const wide = document.createElement("div");
    wide.style.cssText = "width:2000px;height:8px;flex:none";
    el.prepend(wide);
  });
  const strip = page.locator('[data-slot="wide-layout"] [data-slot="strip"]');
  const widths = await page.evaluate(() => ({
    column: document.querySelector('[data-slot="wide-layout"] section[data-col-key]')!.getBoundingClientRect().width,
    strip: document.querySelector('[data-slot="wide-layout"] [data-slot="strip"]')!.clientWidth,
    page: document.documentElement.scrollWidth,
    view: document.documentElement.clientWidth,
  }));
  expect(widths.column).toBe(widths.strip);
  expect(widths.page).toBe(widths.view);
  await expect(strip).toBeVisible();
});

// ONE PANE FILLS A TABLET (1.27.2). With a 360px minimum, wide mode began at a 720px strip, so on these
// three screens a lone column stood at 1/2 beside an empty "Add a pane" of the same width, and on the
// portrait tablet closing the sidebar made the chat narrower. From 440 each draws one full column.
for (const { name, width, height, closed, column } of [
  { name: "a two-screen phone held sideways", width: 1114, height: 705, closed: false, column: 794 },
  { name: "an 11-inch tablet in landscape", width: 1180, height: 820, closed: false, column: 860 },
  { name: "an 11-inch tablet in portrait with the sidebar closed", width: 820, height: 1180, closed: true, column: 764 },
]) {
  test(`on ${name} one pane is the strip's full width, ${column}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    if (closed) await page.addInitScript(() => localStorage.setItem("collie:wide-sidebar:v1", "0"));
    await page.goto("/pane/w1:p1");
    const col = page.locator('[data-slot="wide-layout"] section[data-col-key]').first();
    await expect(col).toBeVisible();
    await expect(page.locator(closed ? '[data-slot="rail"]' : '[data-slot="wide-sidebar"]')).toBeVisible();
    const box = (await col.boundingBox())!;
    expect(Math.round(box.width)).toBe(column);
    // Not wide mode: the column has no width button, and the add column is past the right edge.
    await expect(col.getByRole("button", { name: /^Width / })).toHaveCount(0);
    const add = (await page.locator('[data-slot="add-column"]').boundingBox())!;
    expect(Math.round(add.x)).toBeGreaterThanOrEqual(width);
  });
}

// THE STATUS BAR ON A LARGE PHONE (1.27.1). A foldable draws the page under its status bar, and the
// layout's top rows stood under it: the sidebar's top row and the tab row were cut off, while the
// header docked in the pane column cleared the bar on its own and pushed the pane's title down. The
// operator read it as the page having scrolled. The engine is what lays out `env()`, so the inset is
// emulated here through CDP, and the page is scrolled every way a person would, then measured.
test("on a screen with bars over the page both columns clear them and nothing scrolls the page", async ({ page }) => {
  const INSET = 40;
  const BOTTOM = 30;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: INSET, bottom: BOTTOM } });
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="wide-layout"] header')).toBeVisible();

  const measure = () =>
    page.evaluate(() => {
      const boxes = Object.fromEntries(
        Object.entries({
          layout: '[data-slot="wide-layout"]',
          sidebar: '[data-slot="wide-layout"] aside',
          mark: '[data-slot="sidebar-mark"]',
          tabRow: '[data-slot="wide-layout"] [data-slot="space-header"]',
          title: '[data-slot="space-title"]',
          header: '[data-slot="wide-layout"] header',
          headerRow: '[data-slot="wide-layout"] [data-slot="header-row"]',
          newSpace: '[data-slot="wide-layout"] [data-slot="new-space"]',
          reply: '[data-slot="wide-layout"] section[data-col-key] textarea',
        }).map(([key, selector]) => [key, document.querySelector<HTMLElement>(selector)!.getBoundingClientRect()]),
      );
      // Every box between the layout and the document, scrolled or not.
      let scrolled = 0;
      for (let el: HTMLElement | null = document.querySelector('[data-slot="wide-layout"]'); el; el = el.parentElement) scrolled += el.scrollTop;
      return {
        scrollY: window.scrollY,
        scrolled,
        layout: boxes.layout.top,
        sidebar: boxes.sidebar.top,
        mark: boxes.mark.top,
        tabRow: boxes.tabRow.top,
        tabRowBottom: boxes.tabRow.bottom,
        title: boxes.title.top,
        header: boxes.header.top,
        headerRow: boxes.headerRow.top,
        newSpaceBottom: boxes.newSpace.bottom,
        replyBottom: boxes.reply.bottom,
        view: window.innerHeight,
      };
    });

  // The composer's rows arrive through an animation; read the page once every one has ended. Only the
  // finite ones: the mark runs animations that never finish.
  const settle = () =>
    page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished),
      ),
    );
  await expect(page.locator('[data-slot="composer-actions"]')).toBeVisible();
  await settle();
  const rest = await measure();
  // The layout's top edge is the screen's, and its two top rows hold their controls under the bar.
  expect(rest.layout).toBe(0);
  expect(rest.sidebar).toBe(0);
  expect(rest.tabRow).toBe(0);
  expect(rest.mark).toBeGreaterThanOrEqual(INSET);
  expect(rest.title).toBeGreaterThanOrEqual(INSET);
  // The docked header sits right under the tab row and does not clear the bar a second time.
  expect(rest.header - rest.tabRowBottom).toBeLessThan(INSET);
  expect(rest.headerRow).toBe(rest.header);
  // At the bottom both columns clear the gesture bar, and they end on one line: the reply box and
  // NEW SPACE are within a few pixels of each other, not a bar's height apart.
  expect(rest.newSpaceBottom).toBeLessThanOrEqual(rest.view - BOTTOM);
  expect(rest.replyBottom).toBeLessThanOrEqual(rest.view - BOTTOM);
  expect(Math.abs(rest.newSpaceBottom - rest.replyBottom)).toBeLessThan(BOTTOM / 2);

  const sidebar = (await page.locator('[data-slot="wide-layout"] aside').boundingBox())!;
  const column = (await page.locator('[data-slot="wide-layout"] section[data-col-key]').first().boundingBox())!;
  const drag = async (x: number, y: number, dy: number) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i += 1) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / 6 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  for (const [x, y] of [
    [sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2],
    [column.x + column.width / 2, column.y + column.height / 2],
    [column.x + column.width / 2, column.y + 20],
  ] as const) {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 800);
    await drag(x, y, -300);
    await drag(x, y, 300);
  }
  await settle();
  expect(await measure()).toEqual(rest);
  expect(rest.scrollY).toBe(0);
  expect(rest.scrolled).toBe(0);
});

test("with no inset the tab row and the sidebar foot keep the height they always had", async ({ page }) => {
  await page.goto("/pane/w1:p1");
  const tabRow = page.locator('[data-slot="wide-layout"] [data-slot="space-header"]');
  await expect(tabRow).toBeVisible();
  expect((await tabRow.boundingBox())!.height).toBe(48);
  const header = (await page.locator('[data-slot="wide-layout"] header').boundingBox())!;
  const row = (await page.locator('[data-slot="wide-layout"] [data-slot="header-row"]').boundingBox())!;
  expect(row.y).toBe(header.y);
  // The sidebar's foot: a 1px rule, 4px of air, the 44px buttons, 4px of air.
  expect((await page.locator('[data-slot="sidebar-foot"]').boundingBox())!.height).toBe(53);
});

// THE PAGE ITSELF NEVER SCROLLS (1.27.1, round two). An absolute mark in a sidebar row (a dot's ring,
// a badge) with no positioned box between it and the page had the page as its containing block. Far
// down a long list it escaped the list's scroller and the app's `overflow-hidden` root and made the
// document taller than the screen. A wheel or a drag over the header then scrolled the whole app up
// under the status bar, the operator's screen recording. Which row carries such a mark changes from
// release to release, so the case plants one at the list's end, where a real one sat.
test("a long sidebar list never makes the page taller than the screen, and nothing scrolls it", async ({ page }) => {
  const many = Array.from({ length: 40 }, (_, i) =>
    Object.assign({}, fixtureSnapshot.agents[1], { paneId: `w2:p${i + 10}`, focused: false, status: i % 2 ? "working" : "idle" }),
  );
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...fixtureSnapshot, agents: [...fixtureSnapshot.agents, ...many] }) }),
  );
  await page.goto("/pane/w1:p1");
  const list = page.locator('[data-slot="wide-sidebar"] > div.overflow-y-auto');
  await expect(list).toBeVisible();
  // The list is longer than its box, or this case proves nothing.
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await list.evaluate((el) => {
    const mark = document.createElement("span");
    mark.style.cssText = "position:absolute;width:12px;height:12px";
    el.append(mark);
  });
  const look = () =>
    page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      view: window.innerHeight,
      scrollY: window.scrollY,
      tabRow: document.querySelector('[data-slot="space-header"]')!.getBoundingClientRect().top,
    }));
  const rest = await look();
  expect(rest.height).toBe(rest.view);

  const header = (await page.locator('[data-slot="space-header"]').boundingBox())!;
  const side = (await list.boundingBox())!;
  await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
  await page.mouse.wheel(0, 600);
  await page.mouse.move(side.x + side.width / 2, side.y + side.height / 2);
  // Past the end of the list: the overscroll must not reach the page.
  for (let i = 0; i < 4; i += 1) await page.mouse.wheel(0, 2000);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await look()).toEqual(rest);
  expect(rest.scrollY).toBe(0);
  expect(rest.tabRow).toBe(0);
});

// THE TAB ROW AT THE MEDIUM TIER (1.27.1). On a 705px foldable a long space name and "space 1 of 2"
// left the tabs under 90px: the open tab was cut and its "+" fell off the end. The medium tier gives
// the tabs the room; this is the narrowest real screen it has to hold on.
test("at the medium tier a long space name still leaves the tabs and their + in view", async ({ page }) => {
  const label = "decision-model-eval-harness";
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...fixtureSnapshot,
        workspaces: fixtureSnapshot.workspaces.map((w) => (w.workspaceId === "w1" ? Object.assign({}, w, { label }) : w)),
        agents: fixtureSnapshot.agents.map((a) => (a.workspaceId === "w1" ? Object.assign({}, a, { workspaceLabel: label }) : a)),
      }),
    }),
  );
  await page.setViewportSize({ width: 705, height: 1114 });
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveAttribute("data-width-class", "medium");
  const tabs = page.locator('[data-slot="space-header"] nav').first();
  await expect(tabs).toBeVisible();
  // Every control in the row, the open tab and its "+" too, ends inside the row's own box.
  const fit = await tabs.evaluate((nav) => ({
    right: nav.getBoundingClientRect().right,
    controls: [...nav.querySelectorAll("button")].map((b) => b.getBoundingClientRect().right),
  }));
  expect(fit.controls.length).toBeGreaterThan(1);
  for (const right of fit.controls) expect(right).toBeLessThanOrEqual(fit.right);
  await expect(page.locator('[data-slot="space-title"]')).toContainText("decision");
});

// THE TAB ROW STEPS UP BY WIDTH CLASS (tab-strip.tsx § STEP). The phone keeps its 30px tab; the medium
// tier draws 36px and the expanded tier 40px, fixed steps and never a scale. Measured on the viewports
// this suite's projects use: the phone's 390x844, the tablet's 820x1180, and the tablet turned on its
// side, 1180x820, which is past the expanded line.
test("a tab is 30px on a phone, 36px at the medium tier and 40px at the expanded tier", async ({ page }) => {
  for (const [width, height, widthClass, tall] of [
    [390, 844, "compact", 30],
    [820, 1180, "medium", 36],
    [1180, 820, "expanded", 40],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/pane/w1:p1");
    if (widthClass === "compact") await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(0);
    else await expect(page.locator('[data-slot="wide-layout"]')).toHaveAttribute("data-width-class", widthClass);
    const tab = page.getByRole("navigation", { name: en["space.tabStrip.title"] }).first().getByRole("button").first();
    await expect(tab).toBeVisible();
    expect((await tab.boundingBox())!.height, `${widthClass} at ${width}x${height}`).toBe(tall);
  }
});
