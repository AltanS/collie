import { expect, test, type Locator, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";

// THE KEY HINTS (M108). While the prefix waits, each control that an action key would press wears that key on
// its top right corner (components/shortcut-hint-layer.tsx). The cases hold the layer to what a person sees in
// a real engine: the cap sits on the corner of what a person looks at (the icon of a button much larger than
// its icon, else the button) and inside the window, no cap covers a letter, a control that is not seen gets
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
 * The box a cap anchors on: the first icon or picture of a control with no text whose box is more than 12px
 * larger than it, else the control's own box (the rule of `anchorOf`, lib/shortcuts/hints.ts).
 */
async function anchorBox(control: Locator) {
  return control.evaluate((node) => {
    const whole = node.getBoundingClientRect();
    const glyph = node.querySelector("svg, img")?.getBoundingClientRect();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let hasText = false;
    for (let text = walker.nextNode(); text !== null && !hasText; text = walker.nextNode()) {
      hasText = (text.textContent ?? "").trim() !== "" && text.parentElement?.closest("svg") == null;
    }
    const roomy = glyph !== undefined && (whole.width - glyph.width > 12 || whole.height - glyph.height > 12);
    const icon = glyph !== undefined && !hasText && (roomy || node.getAttribute("data-shortcut-icon") === "true");
    const r = icon ? glyph : whole;
    return { x: r.left, y: r.top, width: r.width, height: r.height, icon };
  });
}

/**
 * Every cap on the page against every icon: no cap's box meets the box of an icon or picture (svg, img) on the
 * page, beyond the 2px at which a cap joins its own icon. The layer's own drawings are not icons of the page.
 */
async function expectNoCapOverIcon(page: Page) {
  const covered = await page.evaluate((layerSelector) => {
    const hints = [...document.querySelectorAll(`${layerSelector} [data-slot="shortcut-hint"]`)].map((hint) => ({ text: hint.textContent ?? "", box: hint.getBoundingClientRect() }));
    const found: string[] = [];
    for (const glyph of document.querySelectorAll("svg, img")) {
      if (glyph.closest(layerSelector) !== null || glyph.closest("[aria-hidden='true']:not(button):not(a)") !== null) continue;
      const r = glyph.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const style = getComputedStyle(glyph);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      for (const cap of hints) {
        const meets = cap.box.left < r.right - 2 && cap.box.right > r.left + 2 && cap.box.top < r.bottom - 2 && cap.box.bottom > r.top + 2;
        if (meets) found.push(`cap ${cap.text} covers an icon at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return found;
  }, LAYER);
  expect(covered).toEqual([]);
}

/**
 * Every cap on the page against every letter: no cap's box meets the box of a text that a person reads. The
 * texts are the text nodes outside the layer, the pane's own output aside (a terminal screen is a picture of
 * text that the keys never aim at).
 */
async function expectNoCapOverText(page: Page) {
  const covered = await page.evaluate((layerSelector) => {
    const layer = document.querySelector(layerSelector);
    const hints = [...document.querySelectorAll(`${layerSelector} [data-slot="shortcut-hint"]`)].map((hint) => ({ text: hint.textContent ?? "", box: hint.getBoundingClientRect() }));
    const found: string[] = [];
    // The wordmark is a drawing of letters, so its box counts as text.
    for (const word of document.querySelectorAll("svg.wordmark")) {
      const r = word.getBoundingClientRect();
      for (const cap of hints) {
        if (cap.box.left < r.right && cap.box.right > r.left && cap.box.top < r.bottom && cap.box.bottom > r.top) found.push(`cap ${cap.text} covers the wordmark`);
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || layer?.contains(parent) || (node.textContent ?? "").trim() === "") continue;
      if (parent.closest("script, style, [aria-hidden='true'], .sr-only") !== null) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width === 0 || r.height === 0) continue;
        for (const cap of hints) {
          const meets = cap.box.left < r.right && cap.box.right > r.left && cap.box.top < r.bottom && cap.box.bottom > r.top;
          if (meets) found.push(`cap ${cap.text} covers "${(node.textContent ?? "").trim().slice(0, 30)}"`);
        }
      }
    }
    return found;
  }, LAYER);
  expect(covered).toEqual([]);
}

/**
 * The cap of `action` that belongs to `control`, and the key it shows. A cap on an icon lies outside the icon and
 * touches it (within 3px); a cap on a control's box reaches the box's top right corner (within a cap's reach, since
 * a corner at the window's edge pushes the cap in). Either way it lies wholly inside the window.
 */
async function capOn(page: Page, action: string, control: Locator): Promise<string> {
  const anchor = (await anchorBox(control))!;
  const view = page.viewportSize()!;
  const all = await caps(page, action).evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: node.textContent ?? "" };
    }),
  );
  const near = all.filter((cap) => {
    if (anchor.icon) {
      const gapX = Math.max(anchor.x - cap.right, cap.left - (anchor.x + anchor.width), 0);
      const gapY = Math.max(anchor.y - cap.bottom, cap.top - (anchor.y + anchor.height), 0);
      return gapX <= 3 && gapY <= 3;
    }
    const overlaps = cap.left < anchor.x + anchor.width && cap.right > anchor.x && cap.top < anchor.y + anchor.height && cap.bottom > anchor.y;
    const nearCorner = Math.abs((cap.left + cap.right) / 2 - (anchor.x + anchor.width)) <= 12 && Math.abs((cap.top + cap.bottom) / 2 - anchor.y) <= 14;
    return overlaps && nearCorner;
  });
  expect(near, `a ${action} cap on the control`).toHaveLength(1);
  const [cap] = near;
  expect(cap!.left).toBeGreaterThanOrEqual(0);
  expect(cap!.top).toBeGreaterThanOrEqual(0);
  expect(cap!.right).toBeLessThanOrEqual(view.width);
  expect(cap!.bottom).toBeLessThanOrEqual(view.height);
  if (anchor.icon) {
    const inside = cap.left < anchor.x + anchor.width - 2 && cap.right > anchor.x + 2 && cap.top < anchor.y + anchor.height - 2 && cap.bottom > anchor.y + 2;
    expect(inside, `the ${action} cap covers its own icon`).toBe(false);
  }
  return cap!.text;
}

test("the prefix puts the key of the Actions button, the pane menu's dots and the new tab on them", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w1:p1");
  await expect(page.locator(HINT)).toHaveCount(0);
  await arm(page);
  const header = page.locator('[data-slot="space-header"]').getByRole("button", { name: en["actions.open.aria"], exact: true });
  const belt = page.locator('[data-slot="composer-actions"]').getByRole("button", { name: en["actions.open.aria"], exact: true });
  expect(await capOn(page, "open_actions", header)).toBe("g");
  expect(await capOn(page, "open_actions", belt)).toBe("g");
  expect(await capOn(page, "pane_menu", page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true }))).toBe("m");
  // The name line opens the pane settings, which has no key of its own: it wears no cap.
  await expect(caps(page, "pane_settings")).toHaveCount(0);
  expect(await capOn(page, "new_tab", page.getByRole("button", { name: en["space.tabStrip.new.aria"] }))).toBe("c");
  // The sidebar's foot (the gear, New) stands under the bar at the window's foot, so the probe finds the bar there and they get no cap.
  await expect(caps(page, "settings")).toHaveCount(0);
  await expect(caps(page, "new_space")).toHaveCount(0);
  expect(await capOn(page, "toggle_sidebar", page.locator('[data-slot="sidebar-toggle"]'))).toBe("b");
  // The space chevrons are controls too.
  // The first of two spaces cannot step back, so its previous control is off and wears no cap.
  await expect(caps(page, "previous_space")).toHaveCount(0);
  expect(await capOn(page, "next_space", page.getByRole("button", { name: en["wide.space.next"], exact: true }))).toBe("j");
  await expectNoCapOverText(page);
  await expectNoCapOverIcon(page);
});

test("the mark's cap sits on its top left corner and covers no letter of the wordmark", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w1:p1");
  await arm(page);
  const word = (await page.locator('[data-slot="sidebar-word"] svg.wordmark').boundingBox())!;
  const all = await caps(page, "open_dashboard").evaluateAll((nodes) =>
    nodes.map((node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: node.textContent ?? "" };
    }),
  );
  expect(all).toHaveLength(1);
  const [cap] = all;
  expect(cap!.text).toBe("q");
  const meets = cap!.left < word.x + word.width && cap!.right > word.x && cap!.top < word.y + word.height && cap!.bottom > word.y;
  expect(meets, "the q cap meets the wordmark").toBe(false);
  // The cap touches the mark's icon and covers none of it.
  expect(await capOn(page, "open_dashboard", page.locator('[data-slot="sidebar-mark"] button'))).toBe("q");
  await expectNoCapOverText(page);
  await expectNoCapOverIcon(page);
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
  // One new-tab control and one pane menu stand in the header, and one cap each. The menu's cap is on its dots.
  await expect(caps(page, "pane_menu")).toHaveCount(1);
  await expect(caps(page, "new_tab")).toHaveCount(1);
  expect(await capOn(page, "pane_menu", page.locator("section[data-focused]").getByRole("button", { name: en["chat.paneMenu.aria"], exact: true }))).toBe("m");
  await expectNoCapOverText(page);
  await expectNoCapOverIcon(page);
});

test("with the sidebar folded the rail's controls wear their keys", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await page.addInitScript(() => localStorage.setItem("collie:wide-sidebar:v1", "0"));
  await openPane(page, "w2:p1");
  await expect(page.locator('[data-slot="rail"]')).toBeVisible();
  await arm(page);
  expect(await capOn(page, "toggle_sidebar", page.locator('[data-slot="sidebar-toggle"]'))).toBe("b");
  expect(await capOn(page, "new_space", page.locator('[data-slot="new-space"]'))).toBe("\u21e7N");
  await expectNoCapOverText(page);
  await expectNoCapOverIcon(page);
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
  // The folder with a plus at the head of the Spaces list is the New page's control, and it wears the key of New space.
  expect(await capOn(page, "new_space", page.getByRole("button", { name: en["space.overview.new.aria"], exact: true }))).toBe("\u21e7N");
  await expect(caps(page, "pane_menu")).toHaveCount(0);
  await expect(caps(page, "new_tab")).toHaveCount(0);
  await expectNoCapOverText(page);
  await expectNoCapOverIcon(page);
  // The pane key does nothing here, and the bar says so.
  await page.keyboard.press("m");
  await expect(page.getByText(en["shortcuts.bar.notHere"])).toBeVisible();
  await expect(page.locator('[data-slot="pane-settings"], [role="dialog"]')).toHaveCount(0);
});

test("prefix then m opens the pane menu beside its dots, and the dots wear their open look", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w2:p1");
  const dots = page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true });
  await expect(dots).toHaveAttribute("aria-expanded", "false");
  await arm(page);
  await page.keyboard.press("m");
  const menu = page.locator('[data-presentation="menu"]');
  await expect(menu).toBeVisible();
  await expect(page.locator(LAYER)).toHaveCount(0);
  await expect(dots).toHaveAttribute("aria-expanded", "true");
  // Beside the dots, not centred, not a sheet: the box starts at the dots and is 20rem wide, far from the window's middle.
  const at = (await dots.boundingBox())!;
  const box = (await menu.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.width).toBeLessThanOrEqual(330);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  const gapX = Math.max(box.x - (at.x + at.width), at.x - (box.x + box.width), 0);
  const gapY = Math.max(box.y - (at.y + at.height), at.y - (box.y + box.height), 0);
  expect(Math.max(gapX, gapY), "the menu stands against the dots").toBeLessThanOrEqual(16);
  expect(Math.abs(box.x + box.width / 2 - view.width / 2), "not centred").toBeGreaterThan(100);
});

test("in the pane menu Down moves between the rows, Enter runs one, and Escape gives the focus back to the dots", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w2:p1");
  const dots = page.getByRole("button", { name: en["chat.paneMenu.aria"], exact: true });
  const menu = page.locator('[data-presentation="menu"]');
  await arm(page);
  await page.keyboard.press("m");
  await expect(menu).toBeVisible();
  const rows = menu.locator("button:not([disabled]):not([tabindex='-1'])");
  const labels = await rows.allTextContents();
  expect(labels.length).toBeGreaterThan(2);
  // The focus starts on the first row.
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();
  // Escape closes the menu and the focus is on the dots again.
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(dots).toBeFocused();
  await expect(dots).toHaveAttribute("aria-expanded", "false");
  // Open it again by the key: Down then Enter runs the second row, and the menu closes.
  await arm(page);
  await page.keyboard.press("m");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
});

test("the pane settings keep their row in the pane menu, and no key of their own", async ({ page }, testInfo) => {
  desktopOnly(testInfo);
  await openPane(page, "w2:p1");
  await arm(page);
  await page.keyboard.press("m");
  const settings = page.locator('[data-presentation="menu"]').getByRole("button", { name: en["paneActions.settings.label"], exact: true });
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(page.getByRole("dialog", { name: en["paneSettings.title"] })).toBeVisible();
});

test("a phone that never arms the prefix draws no hint", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-phone", "the touch phone is the app-phone project");
  await page.goto("/pane/w1:p1");
  await expect(page.locator('[data-slot="composer-actions"]')).toBeVisible();
  await expect(page.locator(LAYER)).toHaveCount(0);
  await expect(page.locator(HINT)).toHaveCount(0);
});
