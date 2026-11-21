// THE COLOURS THE APP DERIVES FROM A THEME (DESIGN.md §14, ADR 0172). A theme names its base tokens; the large
// screen's planes, the hover and the selected fill of each plane, the open trigger's fill and the focus ring are
// made here, from those tokens, for one half at a time.
//
// Each derived value is made in two steps. First COLLIE'S RELATION: the same expression Collie's stylesheet uses
// (index.css), so that Collie, passed through this function, comes out as it is painted today; the reference test
// in derive.test.ts holds that within 0.02 in OKLab. Then a FLOOR: when the value lands too close to the ground it
// stands on, its lightness is pushed further in the direction the relation already took (a recess darker, a hover
// on the recess toward the paper) until it meets the floor; if that direction runs out of range first, the other
// way. Hue and chroma are kept; a colour pushed out of sRGB is clipped, and every floor is checked on the clipped
// colour, the one a screen paints.
//
// The steps run in order, and each step reads what the earlier ones made: planes, then the state fills, then the
// ring. A later floor (a field's edge, a firm edge, a floor on a theme's own ink) is one more step in `STEPS`.
//
// Pure: no DOM, no package. `applyTheme` (store.ts) calls it for every theme it applies; Collie applies no theme and
// keeps its stylesheet.

import type { AnyThemeToken, Half } from "./schema";

// ── The floors ────────────────────────────────────────────────────────────────────────────────

/** A hover fill against the ground it stands on, in OKLab (the floor of the themes set, R5). */
export const HOVER_FLOOR = 0.04;
/** A selected or an open fill against its ground, in OKLab. */
export const STATE_FLOOR = 0.06;
/** The focus ring against every ground it can stand on (WCAG 1.4.11). */
export const RING_FLOOR = 3;
/** Text on a plane (WCAG 1.4.3). */
export const TEXT_FLOOR = 4.5;
/**
 * The least step between two planes, in OKLab. Collie's own steps are 0.045 (light page to paper) to 0.06; a black
 * page clamps Collie's recess to the page itself, where this floor lifts the recess instead.
 */
export const PLANE_GAP = 0.025;

/** The planes a state fill is made for. */
export const PLANES = ["page", "recess", "paper"] as const;
export type Plane = (typeof PLANES)[number];

/** The derived tokens, by their custom property name without `--`. */
export const DERIVED_TOKENS = [
  "surface-recess",
  "surface-paper",
  "state-hover-page",
  "state-hover-recess",
  "state-hover-paper",
  "state-on-page",
  "state-on-recess",
  "state-on-paper",
  "state-open-page",
  "state-open-recess",
  "state-open-paper",
  "ring",
] as const;
export type DerivedToken = (typeof DERIVED_TOKENS)[number];

/** One half's derived tokens, each an `oklch()` value. */
export interface DerivedHalf {
  "surface-recess": string;
  "surface-paper": string;
  "state-hover-page": string;
  "state-hover-recess": string;
  "state-hover-paper": string;
  "state-on-page": string;
  "state-on-recess": string;
  "state-on-paper": string;
  "state-open-page": string;
  "state-open-recess": string;
  "state-open-paper": string;
  ring: string;
}

// ── Colour ────────────────────────────────────────────────────────────────────────────────────

/** OKLab, L from 0 to 1. */
export type Lab = readonly [number, number, number];
type Rgb = readonly [number, number, number];

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const each = (t: Rgb, f: (x: number) => number): Rgb => [f(t[0]), f(t[1]), f(t[2])];

function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = each(rgb, toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363282 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab to sRGB, each channel clipped into 0..1: the colour a screen paints. */
function labToRgb(lab: Lab): Rgb {
  const [L, a, b] = lab;
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** The colour as painted: through sRGB and back, so a value out of gamut is measured as the screen shows it. */
export function painted(c: Lab): Lab {
  return rgbToLab(labToRgb(c));
}

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu;
const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/u;

/** A theme colour (`#rrggbb`, `#rrggbbaa`, `oklch(L C H)`, `oklch(L C H / A)`) as OKLab, laid over `ground` when it has alpha. */
export function parseColour(value: string, ground?: Lab): Lab {
  let lab: Lab;
  let alpha = 1;
  const hex = HEX.exec(value);
  const lch = OKLCH.exec(value);
  if (hex !== null) {
    const h = hex[1] ?? "000000";
    const byte = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
    lab = rgbToLab([byte(0), byte(2), byte(4)]);
    if (hex[2] !== undefined) alpha = Number.parseInt(hex[2], 16) / 255;
  } else if (lch !== null) {
    const c = Number(lch[2]);
    const h = (Number(lch[3]) * Math.PI) / 180;
    lab = [Number(lch[1]), c * Math.cos(h), c * Math.sin(h)];
    if (lch[4] !== undefined) alpha = Number(lch[4]) / (lch[5] === "%" ? 100 : 1);
  } else {
    throw new Error(`not a theme colour: ${value}`);
  }
  if (alpha >= 1 || ground === undefined) return lab;
  // Alpha composites in sRGB, as the browser does.
  const top = labToRgb(lab);
  const under = labToRgb(ground);
  const over = (i: 0 | 1 | 2) => top[i] * alpha + under[i] * (1 - alpha);
  return rgbToLab([over(0), over(1), over(2)]);
}

const places = (x: number): string => String(Math.round(x * 10_000) / 10_000);

/** As `oklch(L C H)`, four places: the value written to a custom property. */
export function formatColour(c: Lab): string {
  const [L, a, b] = c;
  const C = Math.hypot(a, b);
  const H = C < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return `oklch(${places(L)} ${places(C)} ${places(H)})`;
}

/** Distance in OKLab, of the painted colours. */
export function distance(x: Lab, y: Lab): number {
  const p = painted(x);
  const q = painted(y);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

function luminance(c: Lab): number {
  const [r, g, b] = each(labToRgb(c), toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast of the painted colours. */
export function contrast(x: Lab, y: Lab): number {
  const a = luminance(x);
  const b = luminance(y);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The same hue and chroma at another lightness (CSS `oklch(from c <L> c h)`). */
export function withLightness(c: Lab, L: number): Lab {
  return [clamp01(L), c[1], c[2]];
}

/** `color-mix(in oklch, x, y)` at an even split: lightness and chroma halfway, the hue the short way round. */
function mixOklchHalf(x: Lab, y: Lab): Lab {
  const cx = Math.hypot(x[1], x[2]);
  const cy = Math.hypot(y[1], y[2]);
  // A hue with no chroma is powerless in CSS: the other colour's hue is taken.
  const hx = cx < 1e-4 ? Math.atan2(y[2], y[1]) : Math.atan2(x[2], x[1]);
  const hy = cy < 1e-4 ? hx : Math.atan2(y[2], y[1]);
  let d = hy - hx;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  const h = hx + d / 2;
  const c = (cx + cy) / 2;
  return [(x[0] + y[0]) / 2, c * Math.cos(h), c * Math.sin(h)];
}

// ── The floor ─────────────────────────────────────────────────────────────────────────────────

const STEP = 0.0025;

/**
 * `start` when `ok(start)`; otherwise the first lightness that is `ok`, walking from `start` in `direction` (+1
 * lighter, -1 darker), then, if that runs out of range, the other way. Hue and chroma stay. When no lightness is
 * `ok`, the one with the best `score` (how close it came).
 */
export function pushLightness(start: Lab, direction: 1 | -1, ok: (c: Lab) => boolean, score: (c: Lab) => number): Lab {
  if (ok(start)) return start;
  for (const dir of [direction, -direction]) {
    for (let L = start[0] + dir * STEP; L >= 0 && L <= 1; L += dir * STEP) {
      const c = withLightness(start, L);
      if (ok(c)) return painted(c);
    }
  }
  let best = start;
  let bestScore = score(start);
  for (let L = 0; L <= 1; L += STEP) {
    const c = withLightness(start, L);
    const s = score(c);
    if (s > bestScore) {
      best = painted(c);
      bestScore = s;
    }
  }
  return best;
}

/** Which way a value already stands from its ground; at the same lightness, away from the nearer end of the range. */
function awayFrom(value: Lab, ground: Lab): 1 | -1 {
  const d = value[0] - ground[0];
  if (Math.abs(d) > 1e-3) return d > 0 ? 1 : -1;
  return ground[0] > 0.5 ? -1 : 1;
}

// ── The steps ─────────────────────────────────────────────────────────────────────────────────

type Half2 = "light" | "dark";

/** What the steps share: the theme's half, its base colours as OKLab, and what earlier steps made. */
interface Work {
  half: Half2;
  tokens: Half;
  colour: (token: AnyThemeToken) => Lab;
  out: Partial<Record<DerivedToken, Lab>>;
}

function made(w: Work, token: DerivedToken): Lab {
  const c = w.out[token];
  if (c === undefined) throw new Error(`derive: "${token}" is read before its step made it`);
  return c;
}

/** The ink that must stay readable on a ground: never worse than the floor, nor than the page already gives it. */
function inkHolds(ink: Lab, ground: Lab, page: Lab): boolean {
  return contrast(ink, ground) >= Math.min(TEXT_FLOOR, contrast(ink, page)) - 1e-6;
}

/**
 * THE PLANES. Collie's relation (index.css, DERIVED_THEME_TOKENS): the recess is the page 0.05 darker; the paper is,
 * in light, the card 0.05 lighter (at most white), and in dark halfway between the page and the card 0.05 lighter. A
 * theme that names either one starts from its own value. Floors: the muted ink keeps 4.5:1 on each plane (or what
 * it has on the page, when the theme itself gives less), and each plane stands PLANE_GAP off its neighbours.
 */
function planes(w: Work): void {
  const page = w.colour("background");
  const card = w.colour("card");
  const muted = w.colour("muted-foreground");
  const fg = w.colour("foreground");
  const own = (token: "surface-recess" | "surface-paper"): Lab | undefined => (w.tokens[token] === undefined ? undefined : w.colour(token));

  const recessStart = own("surface-recess") ?? withLightness(page, page[0] - 0.05);
  const inks = (c: Lab) => inkHolds(muted, c, page) && inkHolds(fg, c, page);
  const recess = placePlane(recessStart, awayFrom(recessStart, page), inks, [(c) => distance(c, page) >= PLANE_GAP], muted);
  w.out["surface-recess"] = recess;

  const paperStart = own("surface-paper") ?? (w.half === "light" ? withLightness(card, Math.min(1, card[0] + 0.05)) : mixOklchHalf(page, withLightness(card, card[0] + 0.05)));
  const paperDir = distance(paperStart, page) > 1e-3 ? awayFrom(paperStart, page) : awayFrom(paperStart, recess);
  w.out["surface-paper"] = placePlane(paperStart, paperDir, inks, [(c) => distance(c, page) >= PLANE_GAP, (c) => distance(c, recess) >= PLANE_GAP], muted);
}

/**
 * A plane under its floors, the ink first: the gaps are tried as a list, the first ones the most wanted (off the page,
 * then off the recess), and dropped from the end until a lightness meets the ink's floor and the gaps left. With no
 * gap left the plane may sit on the page (a white page has no lighter paper); with no lightness at all, the one the
 * muted ink reads best on.
 */
function placePlane(start: Lab, direction: 1 | -1, inks: (c: Lab) => boolean, gaps: readonly ((c: Lab) => boolean)[], muted: Lab): Lab {
  for (let keep = gaps.length; keep > 0; keep -= 1) {
    const kept = gaps.slice(0, keep);
    const ok = (c: Lab) => inks(c) && kept.every((g) => g(c));
    const found = pushLightness(start, direction, ok, () => Number.NEGATIVE_INFINITY);
    if (ok(found)) return found;
  }
  return pushLightness(start, direction, inks, (c) => contrast(muted, c));
}

/** The ground of each plane. */
function groundOf(w: Work, plane: Plane): Lab {
  if (plane === "page") return w.colour("background");
  return made(w, plane === "recess" ? "surface-recess" : "surface-paper");
}

/**
 * THE STATE FILLS, per plane. Collie's relation: a hover and a selected row take `--accent` on the page and the paper,
 * and the paper on the recess (`RECESS_ACCENT` points the accent there); an open trigger takes `--control-on` on every
 * plane. Floors: a hover HOVER_FLOOR off its ground, a selected and an open fill STATE_FLOOR off it, and the ink on
 * each fill as readable as it is on the page.
 */
function states(w: Work): void {
  const accent = w.colour("accent");
  const fg = w.colour("foreground");
  const page = w.colour("background");
  const on = w.colour("control-on");
  const onInk = w.colour("control-on-foreground");
  for (const plane of PLANES) {
    const ground = groundOf(w, plane);
    const fillStart = plane === "recess" ? made(w, "surface-paper") : accent;
    const fill = (floor: number): Lab =>
      pushLightness(
        fillStart,
        awayFrom(fillStart, ground),
        (c) => distance(c, ground) >= floor && inkHolds(fg, c, page),
        (c) => distance(c, ground),
      );
    w.out[`state-hover-${plane}`] = fill(HOVER_FLOOR);
    w.out[`state-on-${plane}`] = fill(STATE_FLOOR);
    w.out[`state-open-${plane}`] = pushLightness(
      on,
      awayFrom(on, ground),
      (c) => distance(c, ground) >= STATE_FLOOR && contrast(onInk, c) >= Math.min(TEXT_FLOOR, contrast(onInk, on)) - 1e-6,
      (c) => distance(c, ground),
    );
  }
}

/**
 * THE RING. Collie's relation: the theme's own `--ring`. Floor: 3:1 against every ground it is drawn on, the page,
 * the card, the three planes, the band (`secondary`) and the muted fill. Not against a filled primary button: the
 * house ring stands 2px off the box, so the gap, a ground, is on both its sides; and Collie's own dark ring is 1.9:1
 * against its white primary, so that floor would move the ring Altan approved.
 */
function ring(w: Work): void {
  const page = w.colour("background");
  const grounds = [page, w.colour("card"), made(w, "surface-recess"), made(w, "surface-paper"), w.colour("secondary"), w.colour("muted")];
  const start = w.colour("ring");
  const worst = (c: Lab) => Math.min(...grounds.map((g) => contrast(c, g)));
  w.out.ring = pushLightness(start, awayFrom(start, page), (c) => worst(c) >= RING_FLOOR, worst);
}

const STEPS: readonly ((w: Work) => void)[] = [planes, states, ring];

/**
 * The derived tokens of one half of a theme, each an `oklch()` value. `tokens` is the half filled from Collie
 * (`fillHalves`), so every base token is there.
 */
export function deriveTokens(tokens: Half, half: Half2): DerivedHalf {
  const pageValue = tokens.background;
  if (pageValue === undefined) throw new Error("derive: the half has no background");
  const page = parseColour(pageValue);
  const colour = (token: AnyThemeToken): Lab => {
    const v = tokens[token];
    if (v === undefined) throw new Error(`derive: the half has no "${token}"`);
    return parseColour(v, page);
  };
  const w: Work = { half, tokens, colour, out: {} };
  for (const step of STEPS) step(w);
  const v = (token: DerivedToken): string => formatColour(made(w, token));
  return {
    "surface-recess": v("surface-recess"),
    "surface-paper": v("surface-paper"),
    "state-hover-page": v("state-hover-page"),
    "state-hover-recess": v("state-hover-recess"),
    "state-hover-paper": v("state-hover-paper"),
    "state-on-page": v("state-on-page"),
    "state-on-recess": v("state-on-recess"),
    "state-on-paper": v("state-on-paper"),
    "state-open-page": v("state-open-page"),
    "state-open-recess": v("state-open-recess"),
    "state-open-paper": v("state-open-paper"),
    ring: v("ring"),
  };
}
