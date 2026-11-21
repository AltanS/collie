import { expect, test, type Page } from "@playwright/test";

import { STILL_MARK } from "./fixtures/still-mark";
import { installWideChatWorld, openColumns } from "./fixtures/wide-chat";

// THE LARGE SCREEN'S THREE PLANES (DESIGN.md §4). The navigation stands on the recess, a column without
// focus on the page, the focused column on the paper, and the paper is the lightest of the three in both
// halves of every shipped theme, so the eye lands on the work. jsdom computes no colour, so the order is
// read here: each plane's background composited from the root down, as the screen shows it, then held to
// recess <= page < paper in OKLCH lightness. The frame around the focused column, a 1px hairline in the derived
// `--pane-active` (ADR 0174), holds 3:1 against the paper inside it, the recess at its left and the page at its
// right, read from the painted pixels; a focus change recolours and moves no box; and the phone draws nothing from
// the planes.

test.use({ serviceWorkers: "block" });

const VIEW = { width: 1440, height: 900 } as const;

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-tablet", "sets its own viewports; one project is enough");
  await installWideChatWorld(page);
});

async function wear(page: Page, scheme: "dark" | "light", theme?: string): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript(
    ([s, t]) => {
      localStorage.setItem("collie:theme:v1", s);
      localStorage.setItem("collie:design:v1", JSON.stringify(t === "" ? { markMoves: false } : { markMoves: false, theme: t }));
    },
    [scheme, theme ?? ""] as const,
  );
}

type Rgb = [number, number, number];

/** What the screen shows under each of these elements: every background from the root down, composited. */
function grounds(page: Page, selectors: Record<string, string>): Promise<Record<string, Rgb>> {
  return page.evaluate((sel) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (layers: string[]): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      for (const layer of layers) {
        ctx.fillStyle = layer;
        ctx.fillRect(0, 0, 1, 1);
      }
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    };
    const out: Record<string, [number, number, number]> = {};
    for (const [name, selector] of Object.entries(sel)) {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`no ${selector}`);
      const layers: string[] = [];
      for (let e: Element | null = el; e !== null; e = e.parentElement) layers.unshift(getComputedStyle(e).backgroundColor);
      out[name] = paint(layers);
      // A frame's edge: its own border colour over its ground.
      if (name.endsWith(":edge")) out[name] = paint([...layers, getComputedStyle(el).borderTopColor]);
    }
    return out;
  }, selectors);
}

/**
 * The colour the screen PAINTS at one point, read back from a screenshot: a computed style can name a colour
 * the border never shows (a `light-dark()` around a relative colour computed fine and painted as the paper).
 */
async function painted(page: Page, x: number, y: number): Promise<Rgb> {
  const png = (await page.screenshot({ clip: { x, y, width: 1, height: 1 }, animations: "disabled", caret: "hide" })).toString("base64");
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const rgb: Rgb = [d[0]!, d[1]!, d[2]!];
    return rgb;
  }, png);
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** OKLCH lightness of an sRGB colour. */
function lightness([r, g, b]: Rgb): number {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363282 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** WCAG contrast of two sRGB colours. */
function contrast(a: Rgb, b: Rgb): number {
  const y = ([r, g, bl]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
  const [hi, lo] = [Math.max(y(a), y(b)), Math.min(y(a), y(b))];
  return (hi + 0.05) / (lo + 0.05);
}

const FOCUSED = '[data-slot="wide-layout"] section[data-focused] [data-slot="column-frame"]';
const OTHER = '[data-slot="wide-layout"] section[data-col-key]:not([data-focused]) [data-slot="column-frame"]';
const PLANES = {
  recess: '[data-slot="wide-sidebar"]',
  tabs: '[data-slot="space-header"]',
  page: OTHER,
  paper: FOCUSED,
  "paper:edge": FOCUSED,
  header: `${FOCUSED} header[data-slot="app-header"]`,
  belt: `${FOCUSED} [data-slot="composer-actions"]`,
  otherBelt: `${OTHER} [data-slot="composer-actions"]`,
};

for (const [scheme, theme] of [
  ["dark", undefined],
  ["light", undefined],
  ["dark", "harbour"],
  ["dark", "nightwatch"],
  ["light", "daylight"],
  ["light", "harbour"],
  ["light", "nightwatch"],
  ["dark", "daylight"],
] as const) {
  test(`the focused column is the lightest plane, inside a 3:1 hairline (${scheme}${theme ? `, ${theme}` : ""})`, async ({ page }) => {
    await page.setViewportSize(VIEW);
    await wear(page, scheme, theme);
    await openColumns(page, ["w1:p1", "w1:p2"], "w1:p1");
    await expect(page.locator(FOCUSED)).toContainText("Six tests pass");
    const g = await grounds(page, PLANES);
    const L = (name: keyof typeof PLANES) => lightness(g[name]!);

    // The order: recess at or under the page (a black page clamps the recess to it), the paper above both
    // (a near-white page, Daylight's, leaves the paper a small step: white clamps it, and the frame and
    // the recess carry the rest).
    expect(L("recess")).toBeLessThanOrEqual(L("page") + 0.001);
    expect(L("paper")).toBeGreaterThan(L("page") + 0.01);
    expect(L("paper")).toBeGreaterThan(L("recess") + 0.05);
    // In dark the paper is a small lift, half the card's step (2026-11-21: the full step, 0.12 on Collie and
    // 0.21 on a black page, read as too bright a sheet); the frame marks the focus.
    if (scheme === "dark") expect(L("paper") - L("page")).toBeLessThan(0.11);
    expect(L("tabs")).toBeCloseTo(L("recess"), 2);
    // The pane's own header is the paper too: the column is one sheet.
    expect(L("header")).toBeCloseTo(L("paper"), 2);
    // The Belt is never the lightest fill: on the paper and on the page it stays under the paper.
    expect(L("belt")).toBeLessThanOrEqual(L("paper") + 0.001);
    expect(L("otherBelt")).toBeLessThanOrEqual(L("paper") + 0.001);
    // The frame carries the focus where the paper cannot, against both surfaces it touches.
    expect(contrast(g["paper:edge"]!, g.paper!)).toBeGreaterThanOrEqual(3);
    expect(contrast(g["paper:edge"]!, g.page!)).toBeGreaterThanOrEqual(3);
    expect(contrast(g["paper:edge"]!, g.recess!)).toBeGreaterThanOrEqual(3);
    // And the screen paints it, 1px wide: the left edge, halfway down, against the paper inside and the recess beside
    // it (the sidebar); the right edge against the page of the column beside it.
    const box = (await page.locator(FOCUSED).boundingBox())!;
    const mid = Math.floor(box.y + box.height / 2);
    const left = await painted(page, Math.round(box.x), mid);
    const right = await painted(page, Math.round(box.x + box.width) - 1, mid);
    expect(contrast(left, g.paper!)).toBeGreaterThanOrEqual(3);
    expect(contrast(left, g.recess!)).toBeGreaterThanOrEqual(3);
    expect(contrast(right, g.paper!)).toBeGreaterThanOrEqual(3);
    expect(contrast(right, g.page!)).toBeGreaterThanOrEqual(3);
    // One pixel: the next pixel in is the paper, not a second row of the frame.
    expect(contrast(await painted(page, Math.round(box.x) + 1, mid), g.paper!)).toBeLessThan(1.1);
  });
}

test("one column is the paper inside the frame too", async ({ page }) => {
  await page.setViewportSize(VIEW);
  await wear(page, "dark");
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await expect(page.locator('[data-slot="wide-layout"] section[data-col-key]')).toHaveCount(1);
  const g = await grounds(page, { recess: PLANES.recess, paper: FOCUSED, "paper:edge": FOCUSED });
  expect(lightness(g.paper!)).toBeGreaterThan(lightness(g.recess!) + 0.08);
  expect(contrast(g["paper:edge"]!, g.paper!)).toBeGreaterThanOrEqual(3);
});

test("a focus change recolours the columns and moves no box", async ({ page }) => {
  await page.setViewportSize(VIEW);
  await wear(page, "dark");
  await openColumns(page, ["w1:p1", "w1:p2"], "w1:p1");
  const boxes = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="wide-layout"] section[data-col-key], [data-slot="column-frame"], [data-slot="wide-sidebar"], [data-slot="space-header"]')].map((el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      }),
    );
  const before = await boxes();
  const second = page.locator('[data-slot="wide-layout"] section[data-col-key]').nth(1);
  await expect(second).not.toHaveAttribute("data-focused");
  await second.getByText("There are no warnings left").click();
  await expect(second).toHaveAttribute("data-focused", "");
  await expect(second.locator('[data-slot="column-frame"]')).toHaveClass(/bg-surface-paper/);
  expect(await boxes()).toEqual(before);
});

test("the phone draws nothing from the planes", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, colorScheme: "dark", serviceWorkers: "block" });
  const page = await context.newPage();
  await page.addInitScript((design) => {
    localStorage.setItem("collie:theme:v1", "dark");
    localStorage.setItem("collie:design:v1", design);
  }, JSON.stringify(STILL_MARK));
  await installWideChatWorld(page);
  await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
  await expect(page.getByText("Six tests pass")).toBeVisible();
  await expect(page.locator('[data-slot="wide-layout"]')).toHaveCount(0);
  await page.mouse.move(0, 0);
  const shot = () => page.screenshot({ animations: "disabled", caret: "hide" });
  const plain = await shot();
  // Paint both planes in a colour no theme has: a phone that read either token would show it.
  await page.addStyleTag({ content: ":root { --surface-recess: #ff00ff !important; --surface-paper: #00ff00 !important; }" });
  expect(await shot()).toEqual(plain);
  await context.close();
});
