import type { Pixels } from "./png";

// THE ARITHMETIC OF R5, on painted pixels: WCAG 2 contrast, OKLab distance, and the few ways the set reads a region
// of a screenshot (its most common colour, the colours that differ from a second shot).

export type Rgb = readonly [number, number, number];

const lin = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two opaque sRGB colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [Math.max(luminance(a), luminance(b)), Math.min(luminance(a), luminance(b))];
  return (hi + 0.05) / (lo + 0.05);
}

export function oklab([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363282 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean distance in OKLab: 0.02 is about the least a person sees between two flat fields side by side. */
export function deltaE(a: Rgb, b: Rgb): number {
  const [x, y] = [oklab(a), oklab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export function hex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** A rectangle in DEVICE pixels of a screenshot, already clipped to it. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rectangle in CSS px turned into device px of a shot at `scale`, clipped to the shot. `null` when nothing is left. */
export function toDevice(r: { x: number; y: number; w: number; h: number }, scale: number, shot: Pixels, origin = { x: 0, y: 0 }): Rect | null {
  const x0 = Math.max(0, Math.round((r.x - origin.x) * scale));
  const y0 = Math.max(0, Math.round((r.y - origin.y) * scale));
  const x1 = Math.min(shot.width, Math.round((r.x - origin.x + r.w) * scale));
  const y1 = Math.min(shot.height, Math.round((r.y - origin.y + r.h) * scale));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function at(shot: Pixels, x: number, y: number): Rgb {
  const o = (y * shot.width + x) * 4;
  return [shot.data[o] ?? 0, shot.data[o + 1] ?? 0, shot.data[o + 2] ?? 0];
}

/** The most common colour of a region: the ground under a run of text, the fill of a control. */
export function mode(shot: Pixels, r: Rect): Rgb {
  const counts = new Map<number, number>();
  let best = 0;
  let bestKey = 0;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const o = (y * shot.width + x) * 4;
      const key = ((shot.data[o] ?? 0) << 16) | ((shot.data[o + 1] ?? 0) << 8) | (shot.data[o + 2] ?? 0);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > best) {
        best = n;
        bestKey = key;
      }
    }
  }
  return [(bestKey >> 16) & 0xff, (bestKey >> 8) & 0xff, bestKey & 0xff];
}

/** The share of a region's pixels that equal one colour within `tolerance` per channel. */
export function share(shot: Pixels, r: Rect, colour: Rgb, tolerance = 2): number {
  let hit = 0;
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const [a, b, c] = at(shot, x, y);
      if (Math.abs(a - colour[0]) <= tolerance && Math.abs(b - colour[1]) <= tolerance && Math.abs(c - colour[2]) <= tolerance) hit += 1;
    }
  }
  return hit / Math.max(1, r.w * r.h);
}

/**
 * The INK of a region: of the pixels where shot `a` (as painted) differs from shot `b` (the same page with the ink
 * hidden), the one with the `k`-th highest contrast against `ground`. The k-th and not the first, so one stray pixel
 * of a neighbour cannot speak for a run of text; at 2x a glyph's stem reaches its full colour on many pixels.
 * `null` when nothing differs: the ink is not painted at all, or the hiding did not reach it.
 */
export function ink(a: Pixels, b: Pixels, r: Rect, ground: Rgb, k = 4): { colour: Rgb; ratio: number; pixels: number } | null {
  const found: { colour: Rgb; ratio: number }[] = [];
  for (let y = r.y; y < r.y + r.h; y += 1) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      const p = at(a, x, y);
      const q = at(b, x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 6) continue;
      found.push({ colour: p, ratio: contrast(p, ground) });
    }
  }
  if (found.length === 0) return null;
  found.sort((x, y) => y.ratio - x.ratio);
  const pick = found[Math.min(found.length - 1, k - 1)]!;
  return { ...pick, pixels: found.length };
}
