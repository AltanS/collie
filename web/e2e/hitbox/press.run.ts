import { expect, test, type Page } from "@playwright/test";

import type { Target } from "@/playground/hitbox/scan";

import { installScanner, scan } from "./inject";
import { writeKey, type Json } from "./out";
import { SCREENS, setUpWorld } from "./screens";
import { finger, press, sleep, type Finger } from "./touch";
import { installWorld } from "./world";

// PROPOSAL 5, MEASURED: DOES A PRESS SHRINK THE HIT AREA, AND DOES GIVING IT BACK COVER A NEIGHBOUR?
//
//   edge taps   real touches (a point, radius 1) at 0.5, 1.5, 2.5 and 3.5px inside the right edge of the
//               session pill, the floating button and a row, and the click count each gets;
//   press cover every target on the screens below is held down (touchStart, 260ms, then touchCancel so
//               nothing opens), and while it is down every neighbour within 12px is sampled: a point of the
//               neighbour's drawn box that answers with the PRESSED element and did not at rest is a
//               neighbour the pressed element's reach now covers. The pressed target's own hit width is
//               compared with its width at rest.
//
//     HITBOX_OUT=/tmp/x.json HITBOX_TAG=after bunx playwright test -c e2e/hitbox/playwright.config.ts press

const TAG = process.env.HITBOX_TAG ?? "after";
const WATCH = `
window.__hbClicks = [];
window.addEventListener("click", (e) => {
  window.__hbClicks.push({ inside: e.target instanceof Element && e.target.closest("[data-hb-watch]") !== null });
  e.stopImmediatePropagation(); e.preventDefault();
}, true);
`;

const COVER_SCREENS = ["dashboard", "dashboard-crew", "space", "session-terminal", "session-chat", "composer-keys", "settings", "new", "hill", "sheet-row-actions"];
const INSETS = [0.5, 1.5, 2.5, 3.5];
const out: { [key: string]: Json } = {};
const totals = { pressed: 0, shrunk: 0, neighboursCovered: 0 };

async function setWatch(page: Page, sel: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const loc = page.locator(sel).first();
  await loc.evaluate((el) => {
    for (const old of document.querySelectorAll("[data-hb-watch]")) old.removeAttribute("data-hb-watch");
    el.setAttribute("data-hb-watch", "1");
  });
  await sleep(450);
  const b = await loc.boundingBox();
  if (b === null) throw new Error(`no box for ${sel}`);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

test("edge taps on the pill, the floating button and a row", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: "block",
    baseURL: `http://127.0.0.1:${process.env.HITBOX_PORT ?? "5301"}`,
  });
  const page = await context.newPage();
  await page.addInitScript({ content: WATCH });
  await installWorld(page);
  await page.goto("/");
  await page.waitForSelector('[data-glide-origin="pane"]');
  await sleep(1200);
  const f: Finger = { ...(await finger(page)), radius: 1 };
  const edges: { [key: string]: Json } = {};
  const cases = [
    { id: "session-pill", sel: 'button[aria-label^="Space: "]', side: "right" },
    { id: "fab", sel: '[data-slot="fab"]', side: "right" },
    { id: "row-right", sel: '[data-glide-origin="pane"]', side: "right" },
    { id: "row-left", sel: '[data-glide-origin="pane"]', side: "left" },
  ] as const;
  for (const c of cases) {
    const b = await setWatch(page, c.sel);
    const landed: { [key: string]: Json } = {};
    for (const inset of INSETS) {
      let ok = 0;
      for (let k = 0; k < 4; k += 1) {
        await page.evaluate(() => {
          window.__hbClicks = [];
        });
        const x = c.side === "right" ? b.x + b.w - inset : b.x + inset;
        await press(f, x, b.y + b.h / 2, { holdMs: 80 });
        await sleep(140);
        ok += await page.evaluate(() => (window.__hbClicks ?? []).filter((e) => e.inside).length);
      }
      landed[`${String(inset)}px`] = `${String(ok)}/4`;
    }
    edges[c.id] = landed;
  }
  out.edges = edges;
  await context.close();
});

type CoverFinding = { pressed: string; covers: { name: string; points: number }[]; shrankBy: number };

async function pressCover(page: Page, f: Finger, targets: Target[], vw: number, vh: number): Promise<{ pressed: number; checked: number; findings: CoverFinding[]; shrunk: number }> {
  const inView = targets.filter(
    (t) => t.pointerEvents !== "none" && t.box.x >= 0 && t.box.y >= 0 && t.box.x + t.box.w <= vw && t.box.y + t.box.h <= vh && !(t.box.w >= vw * 0.9 && t.box.h >= vh * 0.9),
  );
  const findings: CoverFinding[] = [];
  let pressed = 0;
  let checked = 0;
  let shrunk = 0;
  for (const t of inView) {
    const near = inView.filter((o) => o !== t && o.selector !== t.selector && rectGap(t.box, o.box) <= 12);
    const cx = t.box.x + t.box.w / 2;
    const cy = t.box.y + t.box.h / 2;
    const probe = near.map((o) => ({ name: o.name, x: o.box.x, y: o.box.y, w: o.box.w, h: o.box.h }));
    const measure = (sel: string, boxes: typeof probe) =>
      page.evaluate(
        ({ sel: s, boxes: bs, cx: px, cy: py }) => {
          const el = document.querySelector(s);
          if (el === null) return null;
          const covers: { name: string; points: number }[] = [];
          for (const b of bs) {
            let n = 0;
            for (let i = 0; i < 6; i += 1) {
              for (let j = 0; j < 6; j += 1) {
                const at = document.elementFromPoint(b.x + ((i + 0.5) * b.w) / 6, b.y + ((j + 0.5) * b.h) / 6);
                if (at !== null && el.contains(at)) n += 1;
              }
            }
            covers.push({ name: b.name, points: n });
          }
          let left = px;
          let right = px;
          for (let x = px; x > px - 400; x -= 1) {
            const at = document.elementFromPoint(x, py);
            if (at !== null && el.contains(at)) left = x;
          }
          for (let x = px; x < px + 400; x += 1) {
            const at = document.elementFromPoint(x, py);
            if (at !== null && el.contains(at)) right = x;
          }
          let top = py;
          let bottom = py;
          for (let y = py; y > py - 200; y -= 1) {
            const at = document.elementFromPoint(px, y);
            if (at !== null && el.contains(at)) top = y;
          }
          for (let y = py; y < py + 200; y += 1) {
            const at = document.elementFromPoint(px, y);
            if (at !== null && el.contains(at)) bottom = y;
          }
          return { covers, width: right - left, height: bottom - top };
        },
        { sel, boxes, cx, cy },
      );
    const rest = await measure(t.selector, probe);
    if (rest === null) continue;
    await f.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, radiusX: 1, radiusY: 1, force: 1 }] });
    await sleep(260);
    const held = await measure(t.selector, probe);
    await f.cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await sleep(120);
    if (held === null) continue;
    pressed += 1;
    checked += near.length;
    const covers: { name: string; points: number }[] = [];
    held.covers.forEach((c, i) => {
      const before = rest.covers[i]?.points ?? 0;
      if (c.points > before) covers.push({ name: c.name, points: c.points - before });
    });
    // Across and down: a reach that shrinks under the press shows in either (review 1, finding 1).
    const shrankBy = Math.max(0, rest.width - held.width, rest.height - held.height);
    if (shrankBy >= 1) shrunk += 1;
    if (covers.length > 0 || shrankBy >= 1) findings.push({ pressed: t.name, covers, shrankBy });
  }
  return { pressed, checked, findings, shrunk };
}

function rectGap(a: Target["box"], b: Target["box"]): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
}

test.describe.configure({ mode: "serial" });

for (const id of COVER_SCREENS) {
  test(`press cover on ${id}`, async ({ page }) => {
    const recipe = SCREENS.find((s) => s.id === id);
    if (recipe === undefined) throw new Error(`no screen ${id}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await installScanner(page);
    await setUpWorld(page, recipe);
    await page.goto(recipe.path ?? "/");
    await page.waitForSelector("#root *", { timeout: 8000 });
    await page.waitForTimeout(1200);
    await recipe.open?.(page);
    // Text in the field turns the mic into Send, so the composer's own reach is among the targets pressed (review 1).
    const field = page.locator('[data-slot="composer-box"] textarea').first();
    if ((await field.count()) > 0) await field.fill("run the tests");
    await page.waitForTimeout(300);
    const sheet = (await page.locator('[role="dialog"]').count()) > 0;
    const result = await scan(page, sheet ? { root: '[role="dialog"]', scroll: false } : { scroll: false });
    const f = await finger(page);
    const got = await pressCover(page, f, result.targets, 390, 844);
    out[id] = { targets: result.targets.length, ...got };
    totals.pressed += got.pressed;
    totals.shrunk += got.shrunk;
    for (const finding of got.findings) totals.neighboursCovered += finding.covers.length;
  });
}

// A PRESS MAY NOT SHRINK A REACH THE CALLER BROUGHT (review 1, finding 1). `Button` gives the scale's share back
// while pressed, and the callers that bring a reach of their own (composer Send and the toolbar, the belt's
// pills, the nav tray's keys) have to keep it under the finger: a tap just outside the drawn box, inside the
// reach, is pointerdown on the `::before`, `:active` applies, and a reach that shrinks to 0.5px would miss the
// click at the lift. Every Button whose `::before` is drawn at rest on these screens is touched 3px outside its
// drawn box on the side that has room, with the reach band proven by `elementFromPoint` first, and the click
// must land. The census reads at rest and cannot see this; this is its pressed-state reading.
const REACH_SCREENS = ["session-chat", "session-terminal", "composer-keys"];

for (const id of REACH_SCREENS) {
  test(`a pressed button keeps its own reach on ${id}`, async ({ page }) => {
    const recipe = SCREENS.find((s) => s.id === id);
    if (recipe === undefined) throw new Error(`no screen ${id}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript({ content: WATCH });
    await setUpWorld(page, recipe);
    await page.goto(recipe.path ?? "/");
    await page.waitForSelector("#root *", { timeout: 8000 });
    await page.waitForTimeout(1200);
    await recipe.open?.(page);
    // Text in the field turns the mic into Send.
    const field = page.locator('[data-slot="composer-box"] textarea').first();
    if ((await field.count()) > 0) await field.fill("run the tests");
    await page.waitForTimeout(500);
    const f: Finger = { ...(await finger(page)), radius: 1 };
    const buttons = await page.evaluate(() => {
      const found: { sel: string; name: string; x: number; y: number; w: number; h: number }[] = [];
      let n = 0;
      for (const el of document.querySelectorAll('button[data-slot="button"], button')) {
        const before = getComputedStyle(el, "::before");
        if (before.content === "none" || before.position !== "absolute") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.x < 4 || r.y < 4 || r.x + r.width > innerWidth - 4 || r.y + r.height > innerHeight - 4) continue;
        n += 1;
        el.setAttribute("data-hb-reach", String(n));
        found.push({ sel: `[data-hb-reach="${String(n)}"]`, name: el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 24), x: r.x, y: r.y, w: r.width, h: r.height });
      }
      return found;
    });
    const missed: string[] = [];
    const tried: { [key: string]: Json } = {};
    for (const b of buttons) {
      // Above the box, else below it; centred. 3px out, inside a 4px reach.
      for (const side of ["top", "bottom"] as const) {
        const x = b.x + b.w / 2;
        const y = side === "top" ? b.y - 3 : b.y + b.h + 3;
        const answers = await page.evaluate(({ sel, px, py }) => {
          const el = document.querySelector(sel);
          const at = document.elementFromPoint(px, py);
          return el !== null && at !== null && el.contains(at);
        }, { sel: b.sel, px: x, py: y });
        if (!answers) continue;
        await page.evaluate((sel) => {
          for (const old of document.querySelectorAll("[data-hb-watch]")) old.removeAttribute("data-hb-watch");
          document.querySelector(sel)?.setAttribute("data-hb-watch", "1");
          window.__hbClicks = [];
        }, b.sel);
        await press(f, x, y, { holdMs: 80 });
        await sleep(140);
        const landed = await page.evaluate(() => (window.__hbClicks ?? []).filter((e) => e.inside).length);
        tried[`${b.name} ${side}`] = landed;
        if (landed === 0) missed.push(`${b.name} (${side})`);
        break;
      }
    }
    out[`reach-held:${id}`] = { buttons: buttons.length, tried, missed };
    expect(buttons.length, `a button with a reach of its own on ${id}`).toBeGreaterThan(0);
    expect(missed, "taps 3px outside the drawn box, inside the reach, that the press lost").toEqual([]);
  });
}

test.afterAll(() => {
  out.totals = totals;
  writeKey(`press:${TAG}`, out);
  console.log(JSON.stringify(out.totals), JSON.stringify(out.edges));
});
