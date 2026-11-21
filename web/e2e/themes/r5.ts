import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import { transformWithOxc } from "vite";

import { at, contrast, deltaE, hex, ink, mode, toDevice, type Rect, type Rgb } from "./colour";
import { decodePng, type Pixels } from "./png";
import type { Box, Probes } from "./probe";

// R5 `contrast`: THE FIFTH RULE OF THE SCREEN LIST, read from the PAINTED pixels. The page is shot twice at 2x: as it
// is, and with every ink hidden (text transparent, icons invisible, no transition). The second shot is the ground
// under each ink; the pixels where the two differ are the ink. A colour the styles name but the screen never paints
// cannot pass here, and a token mixed with alpha is measured as the mix it became.
//
//   text          a run of text against its ground: 4.5:1, or 3:1 for large text (24px, or 18.66px bold). WCAG 1.4.3.
//   icon          an icon that is a control's only label, against its ground: 3:1. WCAG 1.4.11.
//   edge          a field, a switch or a check box against the ground around it, by its edge or its fill: 3:1. WCAG 1.4.11.
//   ring          the keyboard focus ring against the colour on BOTH its sides (inside and outside): 3:1. WCAG 2.4.13's floor.
//   hover         a hovered control's fill against its rest fill: an OKLab distance of HOVER_FLOOR or more.
//   selected      a selected item against an unselected peer: an OKLab distance of STATE_FLOOR between the fills, or a
//                 mark of 3:1 against the fill (an edge bar) that the peer does not draw.
//   open          a trigger whose menu is open against the ground around it: STATE_FLOOR.
//   focused-pane  the focused column's frame against the paper inside it and the plane beside it: 3:1.
//
// Disabled controls are exempt (WCAG's "inactive" components). The terminal mirror, the harnesses' brand marks and
// the header character are not read: the mirror's palette is the theme's `ansi`, gated on its own, and the marks are
// fixed drawings (DESIGN.md §4, §13).

/** WCAG 1.4.3 and 1.4.11. */
export const TEXT_FLOOR = 4.5;
export const LARGE_TEXT_FLOOR = 3;
export const NON_TEXT_FLOOR = 3;
/**
 * HOVER: 0.04 in OKLab. Material 3's hover layer (8% of the ink over the surface) moves a white surface 0.06 and a
 * near-black one 0.07; half of that is still twice the 0.02 a person sees between two flat fields side by side. A hover
 * is a second cue (the pointer is on the control), so it may be quieter than a state that stands on its own.
 */
export const HOVER_FLOOR = 0.04;
/**
 * SELECTED AND OPEN: 0.06 in OKLab, three times the least visible step: Material 3's selected and pressed layer (12%)
 * lands at 0.09, and Collie's own `accent` row on its light page measures 0.07. A state with no pointer on it must read
 * at a glance, from the fill alone or from a 3:1 mark beside it.
 */
export const STATE_FLOOR = 0.06;

export type R5Rule = "text" | "icon" | "edge" | "ring" | "hover" | "selected" | "open" | "focused-pane";

export interface Break {
  rule: R5Rule;
  el: string;
  /** The painted ink (or the state's colour) and the ground it stands on, as sRGB hex. */
  ink: string;
  ground: string;
  /** The measured value: a contrast ratio for text, icon, edge, ring and focused-pane; an OKLab distance for hover, selected and open. */
  value: number;
  floor: number;
  /** The element's class names, so a break can be traced to the utility that drew it. */
  classes?: string;
  text?: string;
  /** For text: the ink's alpha times the opacities above it (1 when the token reaches the screen whole). */
  alpha?: number;
}

/** One painted state colour, pass or break: what `collie-states.json` holds for the looks Altan approved. */
export interface Sample {
  rule: "hover" | "selected" | "open" | "ring" | "plane";
  el: string;
  colour: string;
  /** What the state stands on: the fill at rest (hover), the peer's fill (selected), the band around it (open). */
  ground?: string;
}

export interface R5Result {
  breaks: Break[];
  /** Every state colour as painted: the hover fill, the selected and the open fill, the ring, the recess and the paper. */
  samples: Sample[];
  /** How many of each were measured, so a green line says what it covered. */
  measured: Record<R5Rule, number>;
  /** Runs of text whose ink the hiding did not reach (no pixel changed): neither a pass nor a break. */
  unmeasured: string[];
}

const HIDE_INK = `
*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important;
  caret-color: transparent !important; text-decoration-color: transparent !important; transition: none !important; animation: none !important; }
*::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; }
svg { visibility: hidden !important; }
`;

async function shot(page: Page, clip?: Box): Promise<Pixels> {
  const png =
    clip === undefined
      ? await page.screenshot({ animations: "disabled", caret: "hide" })
      : await page.screenshot({ animations: "disabled", caret: "hide", clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h } });
  return decodePng(png);
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** A band of `width` CSS px just outside a box (at `gap` px from it), as device rects, on all four sides. */
function bandAround(b: Box, gap: number, width: number): Box[] {
  return [
    { x: b.x - gap - width, y: b.y, w: width, h: b.h },
    { x: b.x + b.w + gap, y: b.y, w: width, h: b.h },
    { x: b.x, y: b.y - gap - width, w: b.w, h: width },
    { x: b.x, y: b.y + b.h + gap, w: b.w, h: width },
  ];
}

/** Four strips of 2px, one on each side of a box: where an edge bar or an underline marks a selected item. */
function strips(box: Box): Box[] {
  return [
    { x: box.x, y: box.y + box.h * 0.25, w: 2, h: box.h * 0.5 },
    { x: box.x + box.w - 2, y: box.y + box.h * 0.25, w: 2, h: box.h * 0.5 },
    { x: box.x + box.w * 0.25, y: box.y, w: box.w * 0.5, h: 2 },
    { x: box.x + box.w * 0.25, y: box.y + box.h - 2, w: box.w * 0.5, h: 2 },
  ];
}

/** The most common colour over several regions together. */
function modeOf(shotPx: Pixels, rects: (Rect | null)[]): Rgb | null {
  const counts = new Map<number, number>();
  let best = 0;
  let bestKey = -1;
  for (const r of rects) {
    if (r === null) continue;
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (let x = r.x; x < r.x + r.w; x += 1) {
        const [p, q, s] = at(shotPx, x, y);
        const key = (p << 16) | (q << 8) | s;
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n > best) {
          best = n;
          bestKey = key;
        }
      }
    }
  }
  return bestKey < 0 ? null : [(bestKey >> 16) & 0xff, (bestKey >> 8) & 0xff, bestKey & 0xff];
}

const PROBE_PATH = fileURLToPath(new URL("./probe.ts", import.meta.url));
let probeCode: string | undefined;

/** Put `probe.ts` into the page as plain script, once per page. An evaluate is not subject to the app's CSP. */
async function installProbe(page: Page): Promise<void> {
  if (probeCode === undefined) {
    const out = await transformWithOxc(readFileSync(PROBE_PATH, "utf8"), PROBE_PATH, { lang: "ts", target: "es2022" });
    probeCode = `(() => {\n${out.code.replaceAll(/^export /gmu, "")}\nwindow.__r5probe = collectProbes;\n})()`;
  }
  await page.evaluate(probeCode);
}

export interface R5Options {
  scale: number;
  touch: boolean;
  hovers?: number;
  focuses?: number;
}

/** How long R5 waits for a page's finite animations and transitions to end before it fails the case. */
export const SETTLE_CEILING_MS = 2000;

/**
 * THE PAGE AT REST (2026-11-21): R5 reads nothing while a sheet slides in or a fade runs. It waits until every FINITE
 * animation and transition of the page has ended, then two frames. The endless ones (the marks' SVG loops, 38 on a
 * pane) are left out, or the wait would never end; one that is paused is left out too, as it never finishes on its
 * own. A chain (one ending starts the next) is waited out in rounds. Past SETTLE_CEILING_MS the case fails with the
 * names of what still runs, so a new endless-but-finite animation cannot hang every case or let one pass by luck.
 * Measured on pane-menu@390: the menu's "Close" is at y 861 while the sheet slides in and at y 283 once it rests.
 */
export async function settle(page: Page): Promise<void> {
  const left = await page.evaluate(async (ceiling) => {
    // Inside the page, so the filter is written out where it is used (a helper here would not reach the browser).
    const deadline = performance.now() + ceiling;
    for (let pass = 0; pass < 20; pass += 1) {
      const now = document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? Infinity)));
      if (now.length === 0) break;
      const ms = deadline - performance.now();
      if (ms <= 0) break;
      await Promise.race([Promise.all(now.map((a) => a.finished.catch(() => null))), new Promise((done) => setTimeout(done, ms))]);
    }
    const still = document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? Infinity))).map((a) => {
      // SAFETY: every animation document.getAnimations() returns from CSS or from element.animate() has a KeyframeEffect.
      const target = (a.effect as KeyframeEffect | null)?.target;
      const name = a instanceof CSSAnimation ? a.animationName : a instanceof CSSTransition ? a.transitionProperty : a.id || "script";
      return `${name} on ${target?.getAttribute("data-slot") ?? target?.tagName.toLowerCase() ?? "?"}`;
    });
    for (let i = 0; i < 2; i += 1) await new Promise((done) => requestAnimationFrame(() => done(null)));
    return still;
  }, SETTLE_CEILING_MS);
  if (left.length > 0) throw new Error(`R5: the page still runs finite animations after ${String(SETTLE_CEILING_MS)} ms, so it is not at rest to be read: ${left.slice(0, 6).join(", ")}`);
}

export async function runContrast(page: Page, opts: R5Options): Promise<R5Result & { shot: Buffer }> {
  const { scale } = opts;
  await settle(page);
  const dialog = (await page.locator('[role="dialog"]').count()) > 0;
  if (!opts.touch) {
    const size = page.viewportSize();
    await page.mouse.move((size?.width ?? 2) - 1, (size?.height ?? 2) - 1);
  }
  await installProbe(page);
  const probes: Probes = await page.evaluate((o) => {
    const probe = window.__r5probe;
    if (probe === undefined) throw new Error("the R5 probe is not installed");
    return probe(o);
  }, { root: dialog ? '[role="dialog"]' : null, hovers: opts.hovers ?? 6, focuses: opts.focuses ?? 8 });
  const pngA = await page.screenshot({ animations: "disabled", caret: "hide" });
  const A = decodePng(pngA);
  const style = await page.addStyleTag({ content: HIDE_INK });
  const B = await shot(page);

  const breaks: Break[] = [];
  const samples: Sample[] = [];
  const measured = { text: 0, icon: 0, edge: 0, ring: 0, hover: 0, selected: 0, open: 0, "focused-pane": 0 } satisfies Record<R5Rule, number>;
  const unmeasured: string[] = [];
  const dev = (b: Box) => toDevice(b, scale, A);

  // ── Text ──
  for (const t of probes.texts) {
    let worst: { ratio: number; ink: Rgb; ground: Rgb } | null = null;
    for (const box of t.rects) {
      const r = dev(box);
      if (r === null) continue;
      const ground = mode(B, r);
      const found = ink(A, B, r, ground);
      if (found === null) continue;
      if (worst === null || found.ratio < worst.ratio) worst = { ratio: found.ratio, ink: found.colour, ground };
    }
    if (worst === null) {
      unmeasured.push(t.el);
      continue;
    }
    measured.text += 1;
    const floor = t.large ? LARGE_TEXT_FLOOR : TEXT_FLOOR;
    if (worst.ratio < floor) breaks.push({ rule: "text", el: t.el, text: t.text, ink: hex(worst.ink), ground: hex(worst.ground), value: round(worst.ratio), floor, classes: t.classes, alpha: round(t.alpha) });
  }

  // ── Icons ──
  for (const icon of probes.icons) {
    const r = dev(icon.box);
    if (r === null) continue;
    const ground = mode(B, r);
    const found = ink(A, B, r, ground, 6);
    if (found === null) continue;
    measured.icon += 1;
    if (found.ratio < NON_TEXT_FLOOR) breaks.push({ rule: "icon", el: icon.el, ink: hex(found.colour), ground: hex(ground), value: round(found.ratio), floor: NON_TEXT_FLOOR, classes: icon.classes });
  }

  // ── Edges of fields, switches and check boxes ──
  for (const c of probes.controls) {
    const inner = dev({ x: c.box.x + 3, y: c.box.y + 3, w: c.box.w - 6, h: c.box.h - 6 });
    const outside = modeOf(B, bandAround(c.box, 2, 3).map(dev));
    const edgeBand = modeOf(B, [dev({ x: c.box.x, y: c.box.y + c.box.h - 1, w: c.box.w, h: 1 }), dev({ x: c.box.x, y: c.box.y, w: 1, h: c.box.h })]);
    if (inner === null || outside === null || edgeBand === null) continue;
    const fill = mode(B, inner);
    // A switch's thumb (or a check box's mark) inside its track: the pixels most unlike the track.
    const thumb = c.kind === "field" ? null : extreme(B, inner, fill, 12);
    const byEdge = contrast(edgeBand, outside);
    const byFill = contrast(fill, outside);
    const byThumb = thumb === null ? 1 : Math.min(contrast(thumb.colour, fill), contrast(thumb.colour, outside));
    const best = Math.max(byEdge, byFill, byThumb);
    measured.edge += 1;
    if (best < NON_TEXT_FLOOR) {
      const [inkColour, why] = byEdge >= byFill ? [edgeBand, "edge"] : [fill, "fill"];
      breaks.push({ rule: "edge", el: `${c.el} (${c.kind}, best by ${why})`, ink: hex(inkColour), ground: hex(outside), value: round(best), floor: NON_TEXT_FLOOR });
    }
  }

  // ── States ──
  for (const p of probes.pairs) {
    if (p.kind === "selected" && p.peer !== undefined) {
      const a = dev(p.box);
      const b = dev(p.peer.box);
      if (a === null || b === null) continue;
      const fill = mode(B, a);
      const peerFill = mode(B, b);
      const d = deltaE(fill, peerFill);
      // A mark: a strip of 2px on one side of the selected box that stands 3:1 off its fill, where the peer's does not.
      let mark = 1;
      const peerStrips = strips(p.peer.box);
      strips(p.box).forEach((s, i) => {
        const sr = dev(s);
        const pr = dev(peerStrips[i]!);
        if (sr === null || pr === null) return;
        const own = contrast(mode(B, sr), fill);
        const theirs = contrast(mode(B, pr), peerFill);
        if (theirs < 1.5) mark = Math.max(mark, own);
      });
      measured.selected += 1;
      samples.push({ rule: "selected", el: p.el, colour: hex(fill), ground: hex(peerFill) });
      if (d < STATE_FLOOR && mark < NON_TEXT_FLOOR) {
        breaks.push({ rule: "selected", el: `${p.el} vs ${p.peer.el}`, ink: hex(fill), ground: hex(peerFill), value: round(d, 3), floor: STATE_FLOOR, text: `fills ${round(contrast(fill, peerFill))}:1, best mark ${round(mark)}:1` });
      }
    }
    if (p.kind === "open") {
      const inner = dev({ x: p.box.x + 1, y: p.box.y + 1, w: p.box.w - 2, h: p.box.h - 2 });
      const around = modeOf(B, bandAround(p.box, 2, 4).map(dev));
      if (inner === null || around === null) continue;
      const fill = mode(B, inner);
      const d = deltaE(fill, around);
      measured.open += 1;
      samples.push({ rule: "open", el: p.el, colour: hex(fill), ground: hex(around) });
      if (d < STATE_FLOOR) breaks.push({ rule: "open", el: p.el, ink: hex(fill), ground: hex(around), value: round(d, 3), floor: STATE_FLOOR, text: `${round(contrast(fill, around))}:1` });
    }
    if (p.kind === "focused-pane" && p.peer !== undefined) {
      // The 1px frame (ADR 0174), read halfway down the left edge; the paper inside it; the plane beside it.
      const frameBox = dev({ x: p.box.x + 0.5, y: p.box.y + p.box.h * 0.4, w: 1, h: p.box.h * 0.2 });
      const paperBox = dev({ x: p.box.x + 8, y: p.box.y + p.box.h * 0.4, w: 24, h: p.box.h * 0.2 });
      const besideBox = dev({ x: p.box.x - 6, y: p.box.y + p.box.h * 0.4, w: 4, h: p.box.h * 0.2 });
      const peerBox = dev({ x: p.peer.box.x + 8, y: p.peer.box.y + p.peer.box.h * 0.4, w: 24, h: p.peer.box.h * 0.2 });
      if (frameBox === null || paperBox === null || besideBox === null || peerBox === null) continue;
      const frame = mode(A, frameBox);
      const paper = mode(B, paperBox);
      const beside = mode(B, besideBox);
      const ratio = Math.min(contrast(frame, paper), contrast(frame, beside));
      measured["focused-pane"] += 1;
      samples.push({ rule: "plane", el: "paper", colour: hex(paper) });
      if (ratio < NON_TEXT_FLOOR) breaks.push({ rule: "focused-pane", el: p.el, ink: hex(frame), ground: hex(contrast(frame, paper) < contrast(frame, beside) ? paper : beside), value: round(ratio), floor: NON_TEXT_FLOOR, text: `paper ${hex(paper)} vs page ${hex(mode(B, peerBox))}: ${round(deltaE(paper, mode(B, peerBox)), 3)}` });
    }
  }

  // ── The recess: the sidebar's own ground, below its last row ──
  const sidebar = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="wide-sidebar"]');
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + 4, y: r.bottom - 40, w: 24, h: 24 };
  });
  const recessBox = sidebar === null ? null : dev(sidebar);
  if (recessBox !== null) samples.push({ rule: "plane", el: "recess", colour: hex(mode(B, recessBox)) });

  // ── Hover: the fill under the pointer against the fill at rest (inks still hidden, so only the fill speaks) ──
  if (!opts.touch) {
    for (const h of probes.hovers) {
      const r = dev(h.box);
      if (r === null) continue;
      const rest = mode(B, r);
      await page.mouse.move(h.box.x + h.box.w / 2, h.box.y + h.box.h / 2);
      await page.waitForTimeout(30);
      const hovered = mode(await shot(page, h.box), { x: 0, y: 0, w: Math.max(1, Math.round(h.box.w * scale)), h: Math.max(1, Math.round(h.box.h * scale)) });
      const d = deltaE(rest, hovered);
      measured.hover += 1;
      samples.push({ rule: "hover", el: h.el, colour: hex(hovered), ground: hex(rest) });
      if (d < HOVER_FLOOR) breaks.push({ rule: "hover", el: h.el, ink: hex(hovered), ground: hex(rest), value: round(d, 3), floor: HOVER_FLOOR, text: `${round(contrast(hovered, rest))}:1` });
    }
    const size = page.viewportSize();
    await page.mouse.move((size?.width ?? 2) - 1, (size?.height ?? 2) - 1);
  }
  // SAFETY: `addStyleTag` resolves to the <style> element it inserted.
  await style.evaluate((node) => (node as Element).remove());

  // ── The focus ring, against what lies on each side of it ──
  // The ring is found, not assumed: the region is shot before and after the focus, and four scan lines walk in from
  // the edges of the region to the middle of each side of the control. The first run of changed pixels is the ring;
  // the pixel just outside the run and the one just inside it are its two sides.
  for (const f of probes.focuses) {
    const pad = 10;
    // FOCUSED THE WAY A KEYBOARD DOES (2026-11-21): a plain focus that lets the browser scroll the control into view, one
    // frame, then the measure, from the control's box where the focus left it. With `preventScroll` the check measured a
    // place the browser never leaves a focused control in (under the sticky prompt pin, cut by the stream's edge).
    const focused = await page.evaluate(async (index) => {
      const el = window.__r5targets?.[index];
      if (!(el instanceof HTMLElement)) return null;
      // SAFETY: `focusVisible` is a FocusOptions member Chromium reads (since 120) and the DOM lib does not list yet.
      el.focus({ focusVisible: true } as FocusOptions);
      await new Promise((done) => requestAnimationFrame(() => done(null)));
      // The focus may start a transition on the ring itself (`Button` carries `transition-all`, so the outline eases
      // in): wait for the control's own finite animations to end, at most a second, then one more frame.
      const own = el.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime ?? Infinity)));
      if (own.length > 0) {
        await Promise.race([Promise.all(own.map((a) => a.finished.catch(() => null))), new Promise((done) => setTimeout(done, 1000))]);
        await new Promise((done) => requestAnimationFrame(() => done(null)));
      }
      const r = el.getBoundingClientRect();
      return el.matches(":focus-visible") ? { outline: getComputedStyle(el).outlineStyle, box: { x: r.x, y: r.y, w: r.width, h: r.height } } : null;
    }, f.index);
    if (focused === null) continue;
    const clip = { x: Math.max(0, focused.box.x - pad), y: Math.max(0, focused.box.y - pad), w: focused.box.w + pad * 2, h: focused.box.h + pad * 2 };
    const now = await shot(page, clip);
    // The same focus with its ring taken away: whatever else the focus paints (a fill, a lifted
    // edge) is in both shots, so the pixels that differ are the ring and nothing else.
    // The shadow goes only when there is no outline: a ring drawn as a shadow (`ring-*`). A button's own soft shadow
    // must stay, or its pixels would read as part of the ring.
    const hideRing = await page.addStyleTag({ content: `*:focus-visible { outline-style: none !important; ${focused.outline === "none" ? "box-shadow: none !important;" : ""} }` });
    const rest = await shot(page, clip);
    // SAFETY: `addStyleTag` resolves to the <style> element it inserted.
    await hideRing.evaluate((node) => (node as Element).remove());
    if (now.width !== rest.width || now.height !== rest.height) continue;
    measured.ring += 1;
    const changed = (x: number, y: number) => {
      const p = at(now, x, y);
      const q = at(rest, x, y);
      return Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 24;
    };
    const midX = Math.round((focused.box.x - clip.x + focused.box.w / 2) * scale);
    const midY = Math.round((focused.box.y - clip.y + focused.box.h / 2) * scale);
    const lines: { from: [number, number]; step: [number, number]; n: number }[] = [
      { from: [midX, 0], step: [0, 1], n: Math.max(0, midY) },
      { from: [midX, now.height - 1], step: [0, -1], n: Math.max(0, now.height - midY) },
      { from: [0, midY], step: [1, 0], n: Math.max(0, midX) },
      { from: [now.width - 1, midY], step: [-1, 0], n: Math.max(0, now.width - midX) },
    ];
    let worst: { ratio: number; ring: Rgb; side: Rgb; other: Rgb } | null = null;
    for (const l of lines) {
      const px = (i: number): [number, number] => [l.from[0] + l.step[0] * i, l.from[1] + l.step[1] * i];
      const inside = (i: number) => {
        const [x, y] = px(i);
        return x >= 0 && y >= 0 && x < now.width && y < now.height;
      };
      let i = 0;
      while (i < l.n && inside(i) && !changed(...px(i))) i += 1;
      if (i >= l.n || i === 0 || !inside(i)) continue;
      let j = i;
      while (j < l.n && inside(j) && changed(...px(j))) j += 1;
      if (!inside(j)) continue;
      // The ring is the run itself (only the outline differs between the two shots). A browser's own `auto` ring is two
      // tones, so the ring counts by its best pixel: the one that stands furthest off both of its sides.
      const off = Math.max(1, Math.round(scale));
      if (!inside(j - 1 + off) || i - off < 0) continue;
      const outer = at(now, ...px(i - off));
      const inner = at(now, ...px(j - 1 + off));
      let ringColour = at(now, ...px(i));
      let ratio = 0;
      for (let k = i; k < j; k += 1) {
        const p = at(now, ...px(k));
        const r = Math.min(contrast(p, outer), contrast(p, inner));
        if (r > ratio) {
          ratio = r;
          ringColour = p;
        }
      }
      if (worst === null || ratio < worst.ratio) worst = { ratio, ring: ringColour, side: contrast(ringColour, outer) < contrast(ringColour, inner) ? outer : inner, other: contrast(ringColour, outer) < contrast(ringColour, inner) ? inner : outer };
    }
    if (worst === null) {
      breaks.push({ rule: "ring", el: `${f.el} (no ring shows: hidden, clipped, or the colour under it)`, ink: "-", ground: "-", value: 1, floor: NON_TEXT_FLOOR });
      continue;
    }
    samples.push({ rule: "ring", el: f.el, colour: hex(worst.ring) });
    if (worst.ratio < NON_TEXT_FLOOR) {
      breaks.push({ rule: "ring", el: f.el, ink: hex(worst.ring), ground: hex(worst.side), value: round(worst.ratio), floor: NON_TEXT_FLOOR, text: `other side ${hex(worst.other)}` });
    }
  }
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });

  return { breaks, samples, measured, unmeasured, shot: pngA };
}

/** Of a region's pixels, the one with the `k`-th highest contrast against `ref`: a switch's thumb against its track. */
function extreme(shotPx: Pixels, r: Rect, ref: Rgb, k: number): { colour: Rgb; ratio: number } | null {
  const found: { colour: Rgb; ratio: number }[] = [];
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const p = at(shotPx, x, y);
      found.push({ colour: p, ratio: contrast(p, ref) });
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => b.ratio - a.ratio);
  return found[Math.min(found.length - 1, k - 1)]!;
}
