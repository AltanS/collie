import { test, type Locator, type Page } from "@playwright/test";

import { installScanner, scan } from "./inject";
import { writeKey, type Json } from "./out";
import { finger, press, sleep } from "./touch";
import { installWorld } from "./world";

// PROPOSAL 6, MEASURED IN A REAL ENGINE: the reach of the dashboard's five short targets, and what each
// reach lies over. Real touches (Chromium's own pipeline) land in the reach band above and below the
// drawn box and the count of clicks that reach the target is the answer; `elementFromPoint` on the
// neighbours' drawn boxes says whether a reach covers one. Written to the `reach:<tag>` key.
//
//     HITBOX_TAG=after bunx playwright test -c e2e/hitbox/playwright.config.ts reach

const TAG = process.env.HITBOX_TAG ?? "after";
const WATCH = `
window.__hbClicks = [];
// A point is the target's when the element there is inside the watched one, or is a label whose control is.
window.__hbOwns = (el) => {
  if (el === null) return false;
  if (el.closest("[data-hb-watch]") !== null) return true;
  return el instanceof HTMLLabelElement && el.control !== null && el.control.closest("[data-hb-watch]") !== null;
};
window.addEventListener("click", (e) => {
  window.__hbClicks.push({ inside: e.target instanceof Element && e.target.closest("[data-hb-watch]") !== null });
  e.stopImmediatePropagation(); e.preventDefault();
}, true);
`;

interface Def {
  id: string;
  find: (page: Page) => Locator;
  /** A tap into this band (px above the box top, px below the box bottom) is meant to reach it. */
  vertical: boolean;
}

const TARGETS: Def[] = [
  { id: "session-pill", find: (p) => p.getByRole("button", { name: /^Space: / }), vertical: true },
  { id: "summary-line", find: (p) => p.getByRole("button", { name: /needs you .* working/ }).first(), vertical: true },
  { id: "spaces-heading", find: (p) => p.getByRole("button", { name: /^Spaces/ }).first(), vertical: true },
  { id: "new-space", find: (p) => p.getByRole("button", { name: "New space" }), vertical: true },
  { id: "spaces-filter", find: (p) => p.getByRole("searchbox", { name: "Filter spaces" }), vertical: true },
];

const OFFSETS = [-10, -8, -6, -4, -2, 2, 4, 6, 8, 10];

test("reach of the five short dashboard targets", async ({ browser }) => {
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
  await installScanner(page);
  await installWorld(page);
  await page.goto("/");
  await page.waitForSelector('[data-glide-origin="pane"]');
  await sleep(1200);
  // A POINT, not a fingertip: Chromium snaps a tap to the nearest clickable within the contact radius
  // (touch adjustment), which would answer for the reach. The fingertip run is the second pass below.
  const f = { ...(await finger(page)), radius: 1 };
  const out: { [key: string]: Json } = {};

  for (const def of TARGETS) {
    const target = def.find(page).first();
    await target.scrollIntoViewIfNeeded();
    await target.evaluate((el) => {
      for (const old of document.querySelectorAll("[data-hb-watch]")) old.removeAttribute("data-hb-watch");
      el.setAttribute("data-hb-watch", "1");
    });
    await sleep(400);
    const b = await target.boundingBox();
    if (b === null) throw new Error(`${def.id} has no box`);
    // The hit rectangle by elementFromPoint along the box's centre line, 1px steps, 30px past each edge.
    const extent = await page.evaluate(
      ({ x, y, w, h }) => {
        const ownsOrLabel = window.__hbOwns;
        if (ownsOrLabel === undefined) throw new Error("the watch script is not installed");
        let top = y;
        let bottom = y + h;
        for (let yy = y + h / 2; yy > y - 30; yy -= 1) if (ownsOrLabel(document.elementFromPoint(x + w / 2, yy))) top = yy;
        for (let yy = y + h / 2; yy < y + h + 30; yy += 1) if (ownsOrLabel(document.elementFromPoint(x + w / 2, yy))) bottom = yy;
        let left = x;
        let right = x + w;
        for (let xx = x + w / 2; xx > x - 30; xx -= 1) if (ownsOrLabel(document.elementFromPoint(xx, y + h / 2))) left = xx;
        for (let xx = x + w / 2; xx < x + w + 30; xx += 1) if (ownsOrLabel(document.elementFromPoint(xx, y + h / 2))) right = xx;
        return { hitH: Math.round(bottom - top), hitW: Math.round(right - left), above: Math.round(y - top), below: Math.round(bottom - (y + h)) };
      },
      { x: b.x, y: b.y, w: b.width, h: b.height },
    );
    // Real touches in the band above and below the drawn box.
    const landed: { [key: string]: Json } = {};
    for (const off of OFFSETS) {
      const y = off < 0 ? b.y + off : b.y + b.height + off;
      if (y < 4 || y > 840) continue;
      await page.evaluate(() => {
        window.__hbClicks = [];
      });
      await press(f, b.x + b.width / 2, y, { holdMs: 60 });
      await sleep(120);
      const got = await page.evaluate(() => (window.__hbClicks ?? []).filter((c) => c.inside).length);
      landed[String(off)] = got;
    }
    out[def.id] = { box: [Math.round(b.width), Math.round(b.height)], ...extent, tapsByOffset: landed };
  }

  // What a reach lies over: every OTHER target's drawn box, sampled; the points where the answer is not the
  // target itself but one of the five reaches say a neighbour was covered.
  const result = await scan(page, { scroll: false });
  const covered: Json[] = [];
  for (const t of result.targets) {
    if (t.hitShare >= 0.99 || t.coveredBy.length === 0) continue;
    covered.push({ name: t.name, share: t.hitShare, by: t.coveredBy });
  }
  out.coveredNeighbours = covered;
  writeKey(`reach:${TAG}`, out);
  console.log(JSON.stringify(out, null, 1));
  await context.close();
});
