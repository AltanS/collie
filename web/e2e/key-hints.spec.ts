import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE KEY HINTS (M108). While the prefix waits, each control that an action key would press wears that key on
// its top right corner (components/shortcut-hint-layer.tsx). The cases hold the layer to what a person sees in
// a real engine: the cap sits on the control's corner and inside the window, a control that is not seen gets
// none, and Esc takes them all away. A phone that never arms the prefix draws nothing.

test.use({ serviceWorkers: "block" });

const DESKTOP = { width: 1440, height: 900 } as const;
const HINT = '[data-slot="shortcut-hint"]';
const LAYER = '[data-slot="shortcut-hint-layer"]';

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
});

function desktopOnly(testInfo: { project: { name: string } }) {
  test.skip(testInfo.project.name !== "app-tablet", "the desktop cases set their own window; the phone case runs on the phone project");
}

async function openPane(page: Page, paneId: string) {
  await page.setViewportSize(DESKTOP);
  await page.goto(`/pane/${encodeURIComponent(paneId)}`);
  await expect(page.locator('[data-slot="wide-layout"]')).toBeVisible();
}

async function arm(page: Page) {
  await page.keyboard.press("Control+b");
  await expect(page.locator(LAYER)).toBeAttached();
}

const caps = (page: Page, action: string) => page.locator(`${HINT}[data-action="${action}"]`);

/**
 * The cap of `action` that sits on `control`: it overlaps the control's box, reaches the control's top right
 * corner (within a cap's reach, since a corner at the window's edge pushes the cap in), and lies wholly inside
 * the window. Returns the key it shows.
 */
async function capOn(page: Page, action: string, control: Locator): Promise<string> {
  const box = (await control.boundingBox())!;
  const view = page.viewportSize()!;
  const all = await caps(page, action).evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: node.textContent ?? "" };
    }),
  );
  const on = all.filter((cap) => {
    const overlaps = cap.left < box.x + box.width && cap.right > box.x && cap.top < box.y + box.height && cap.bottom > box.y;
    const nearCorner = Math.abs((cap.left + cap.right) / 2 - (box.x + box.width)) <= 12 && Math.abs((cap.top + cap.bottom) / 2 - box.y) <= 14;
    return overlaps && nearCorner;
  });
  expect(on, `a ${action} cap on the control`).toHaveLength(1);
  const [cap] = on;
  expect(cap!.left).toBeGreaterThanOrEqual(0);
  expect(cap!.top).toBeGreaterThanOrEqual(0);
  expect(cap!.right).toBeLessThanOrEqual(view.width);
  expect(cap!.bottom).toBeLessThanOrEqual(view.height);
  return cap!.text;
}

test("the prefix puts the key of the Actions button, the pane settings and the new tab on them", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w1:p1");
  await expect(page.locator(HINT)).toHaveCount(0);
  await arm(page);
  const header = page.locator('[data-slot="space-header"]').getByRole("button", { name: en["actions.open.aria"], exact: true });
  const belt = page.locator('[data-slot="composer-actions"]').getByRole("button", { name: en["actions.open.aria"], exact: true });
  expect(await capOn(page, "open_actions", header)).toBe("g");
  expect(await capOn(page, "open_actions", belt)).toBe("g");
  expect(await capOn(page, "pane_settings", page.locator('[data-slot="pane-identity-name"]'))).toBe("m");
  expect(await capOn(page, "new_tab", page.getByRole("button", { name: en["space.tabStrip.new.aria"] }))).toBe("c");
  // The sidebar's foot (the gear, New) stands under the bar at the window's foot, so the probe finds the bar there and they get no cap.
  await expect(caps(page, "settings")).toHaveCount(0);
  await expect(caps(page, "new_space")).toHaveCount(0);
  expect(await capOn(page, "toggle_sidebar", page.locator('[data-slot="sidebar-toggle"]'))).toBe("b");
});

test("a numbered cap sits on each tab, and a tab scrolled out of its strip shows none", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w2:p1");
  const strip = page.getByRole("navigation", { name: en["space.tabStrip.title"] });
  await arm(page);
  await expect(caps(page, "switch_tab")).toHaveText(["1", "2"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(LAYER)).toHaveCount(0);
  // The strip shows one tab's width: the second is out of its scroller.
  const scroller = strip.locator(".overflow-x-auto").first();
  await scroller.evaluate((node) => {
    node.style.cssText += ";flex:none;width:90px";
  });
  await arm(page);
  await expect(caps(page, "switch_tab")).toHaveText(["1"]);
  // Scroll to the end: the hints follow while the prefix waits.
  await scroller.evaluate((node) => node.scrollTo({ left: node.scrollWidth }));
  await expect(caps(page, "switch_tab")).toHaveText(["2"]);
});

test("Escape takes every hint away", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w2:p1");
  await arm(page);
  await expect(page.locator(HINT).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(LAYER)).toHaveCount(0);
  await expect(page.locator(HINT)).toHaveCount(0);
});

test("the layer is not a control: tap-through and out of the accessibility tree", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w2:p1");
  await arm(page);
  const layer = page.locator(LAYER);
  await expect(layer).toHaveAttribute("aria-hidden", "true");
  expect(await layer.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
  // A cap sits over the corner of the Actions button, and the button is still what a pointer hits at its centre.
  const button = page.locator('[data-slot="space-header"]').getByRole("button", { name: en["actions.open.aria"], exact: true });
  const box = (await button.boundingBox())!;
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest("button")?.getAttribute("aria-label"), [box.x + box.width - 3, box.y + 3]);
  expect(hit).toBe(en["actions.open.aria"]);
  // The button's accessible name is what it was.
  await expect(button).toHaveAccessibleName(en["actions.open.aria"]);
});

test("a row of two panes hints the focused pane's remove control only", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.setViewportSize(DESKTOP);
  await page.goto("/pane/w2%3Ap1");
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(1);
  await page.evaluate(() => {
    type Stored = { cols: { key: string; preset: string }[]; focus: string | null };
    const key = "collie:wide-layout:v1";
    // SAFETY: the app wrote this entry on the visit above, in this shape (lib/wide-layout-store.ts).
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, Stored>;
    const [space, strip] = Object.entries(stored).find(([, s]) => s.cols.some((c) => c.key.endsWith("w2:p1")))!;
    const first = strip.cols[0]!.key;
    const keyOf = (paneId: string) => first.slice(0, first.length - "w2:p1".length) + paneId;
    stored[space] = { cols: [{ key: keyOf("w2:p1"), preset: "half" }, { key: keyOf("w2:p2"), preset: "half" }], focus: keyOf("w2:p1") };
    localStorage.setItem(key, JSON.stringify(stored));
  });
  await page.goto("/pane/w2%3Ap1");
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(2);
  await arm(page);
  const focused = page.locator("section[data-focused]").locator('[data-slot="column-remove"]');
  await expect(caps(page, "remove_from_view")).toHaveCount(1);
  expect(await capOn(page, "remove_from_view", focused)).toBe("x");
  // One new-tab and one pane-settings control stand in the header, and one cap each.
  await expect(caps(page, "pane_settings")).toHaveCount(1);
  await expect(caps(page, "new_tab")).toHaveCount(1);
});

test("with the sidebar folded the rail's controls wear their keys", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.addInitScript(() => localStorage.setItem("collie:wide-sidebar:v1", "0"));
  await openPane(page, "w2:p1");
  await expect(page.locator('[data-slot="rail"]')).toBeVisible();
  await arm(page);
  expect(await capOn(page, "toggle_sidebar", page.locator('[data-slot="sidebar-toggle"]'))).toBe("b");
  expect(await capOn(page, "new_space", page.locator('[data-slot="new-space"]'))).toBe("ShiftN");
});

test("with the Actions palette off the Actions button's cap is the pane list's key", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.addInitScript(() => {
    localStorage.setItem("collie:actions-palette:v1", "off");
    localStorage.setItem("collie:wide-sidebar:v1", "0");
  });
  await openPane(page, "w2:p1");
  await arm(page);
  await expect(page.locator('[data-slot="space-header"]').getByRole("button", { name: en["actions.open.aria"], exact: true })).toHaveCount(0);
  // The key runs Switch pane, and a control that stands for it would wear that key; the Belt keeps no button here.
  await expect(caps(page, "open_actions")).toHaveCount(0);
});

test("the dashboard hints the Actions button and the gear, and says the pane key is not on this screen", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await expect(page.getByRole("button", { name: en["actions.open.aria"], exact: true })).toBeVisible();
  await arm(page);
  const actions = page.getByRole("button", { name: en["actions.open.aria"], exact: true });
  expect(await capOn(page, "open_actions", actions)).toBe("g");
  expect(await capOn(page, "settings", page.getByRole("button", { name: en["nav.settings.aria"] }))).toBe("s");
  await expect(caps(page, "pane_settings")).toHaveCount(0);
  await expect(caps(page, "new_tab")).toHaveCount(0);
  // The pane key does nothing here, and the bar says so.
  await page.keyboard.press("m");
  await expect(page.getByText(en["shortcuts.bar.notHere"])).toBeVisible();
  await expect(page.locator('[data-slot="pane-settings"], [role="dialog"]')).toHaveCount(0);
});

test("prefix then m opens the pane's settings", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w2:p1");
  await arm(page);
  await page.keyboard.press("m");
  await expect(page.getByRole("dialog", { name: en["paneSettings.title"] })).toBeVisible();
  await expect(page.locator(LAYER)).toHaveCount(0);
});

test("a phone that never arms the prefix draws no hint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "the touch phone is the app-phone project");
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="composer-actions"]')).toBeVisible();
  await expect(page.locator(LAYER)).toHaveCount(0);
  await expect(page.locator(HINT)).toHaveCount(0);
});
