// THE COLOURS THE APP DERIVES FROM A THEME (DESIGN.md §14, ADR 0172). A theme names its base tokens; the large
// screen's planes, the hover and the selected fill of each plane, the open trigger's fill and the focus ring are
// made here, from those tokens, for one half at a time, and so is the frame of the pane you are in (ADR 0174).
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
// ring, the firm edge and the pane frame. A theme's own ink is never moved: a theme whose text is under 4.5:1 is
// warned about and applied as it is (ADR 0172, decision 6), so a floor here may stay unmet.
//
// Pure: no DOM, no package. `applyTheme` (store.ts) calls it for every theme it applies; Collie applies no theme and
// keeps its stylesheet.

import { readColour, type AnyThemeToken, type Half } from "./schema";

// ── The floors ────────────────────────────────────────────────────────────────────────────────

/** A hover fill against the ground it stands on, in OKLab (the floor of the themes set, R5). */
export const HOVER_FLOOR = 0.04;
/** A selected or an open fill against its ground, in OKLab. */
export const STATE_FLOOR = 0.06;
/** The focus ring against every ground it can stand on (WCAG 1.4.11). */
export const RING_FLOOR = 3;
/** The firm edge against the grounds it separates (WCAG 1.4.11, ADR 0171). */
export const EDGE_FLOOR = 3;
/** The ink's share in the firm edge, index.css's `--edge-firm` (58%). */
const EDGE_SHARE = 0.58;
/** The frame of the pane you are in against the recess, the page and the paper (WCAG 1.4.11, ADR 0174). */
export const FRAME_FLOOR = 3;
/** The "on" ink's share in the pane frame, index.css's `--pane-active` (70% in light, 60% in dark, in OKLab). */
const FRAME_SHARE = { light: 0.7, dark: 0.6 } as const;
/** Text on a plane (WCAG 1.4.3). */
export const TEXT_FLOOR = 4.5;
/**
 * The least step between two planes, in OKLab. Collie's own steps are 0.045 (light page to paper) to 0.06; a black
 * page clamps Collie's recess to the page itself, where this floor lifts the recess instead.
 */
export const PLANE_GAP = 0.025;

/**
 * The version of this function's output. Bump it whenever a change here moves a derived value (a floor, MARGIN, STEP,
 * a relation): the first frame (`public/theme-init.js`) then ignores the values an older version stored. The golden
 * values in `derive.golden.test.ts` show such a change as a diff.
 */
// 4 was an unreleased step (2026-11-21: a theme's own pane-active drawn as it is); 5 mixes it into the page too.
export const DERIVE_VERSION = 5;

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
  "edge-firm",
  "pane-active",
] as const;
export type DerivedToken = (typeof DERIVED_TOKENS)[number];

/** One half's derived tokens, each an `oklch()` value; keyed by DERIVED_TOKENS, so a new token is one entry there. */
export type DerivedHalf = Record<DerivedToken, string>;

// ── Colour ────────────────────────────────────────────────────────────────────────────────────

/** OKLab, L from 0 to 1. */
export type Lab = readonly [number, number, number];
type Rgb = readonly [number, number, number];

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const each = (t: Rgb, f: (x: number) => number): Rgb => [f(t[0]), f(t[1]), f(t[2])];

export function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = each(rgb, toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
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

/** A non-finite number inside the derivation is a defect: it throws, and `applyTheme` keeps the stylesheet's relations. */
function finite(c: Lab, what: string): Lab {
  if (!c.every((x) => Number.isFinite(x))) throw new Error(`derive: ${what} is not a finite colour`);
  return c;
}

/**
 * A theme colour as OKLab, laid over `ground` when it has alpha. It reads with the schema's own grammar (`readColour`:
 * `#rrggbb`, `#rrggbbaa`, `oklch(L C H)`, `oklch(L C H / A[%])`), so it accepts exactly what a theme file may hold.
 */
export function parseColour(value: string, ground?: Lab): Lab {
  const parts = readColour(value);
  if (parts === undefined) throw new Error(`derive: not a theme colour: ${value.slice(0, 64)}`);
  let lab: Lab;
  if (parts.form === "hex") lab = rgbToLab(parts.rgb);
  else {
    const h = (parts.h * Math.PI) / 180;
    lab = [parts.l, parts.c * Math.cos(h), parts.c * Math.sin(h)];
  }
  finite(lab, value.slice(0, 64));
  if (parts.alpha >= 1 || ground === undefined) return lab;
  // Alpha composites in sRGB, as the browser does.
  const top = labToRgb(lab);
  const under = labToRgb(ground);
  const over = (i: 0 | 1 | 2) => top[i] * parts.alpha + under[i] * (1 - parts.alpha);
  return finite(rgbToLab([over(0), over(1), over(2)]), value.slice(0, 64));
}

const places = (x: number): string => String(Math.round(x * 10_000) / 10_000);

/** As `oklch(L C H)`, four places: the value written to a custom property. */
export function formatColour(c: Lab): string {
  const [L, a, b] = finite(c, "a derived value");
  const C = Math.hypot(a, b);
  const H = C < 1e-4 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  // Lightness is written inside 0..1 (a value a hair outside is the clip's rounding), so the output passes the grammar.
  return `oklch(${places(clamp01(L))} ${places(C)} ${places(H)})`;
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

/** `color-mix(in oklch, x <share>, y)`: lightness and chroma `share` of the way from y to x, the hue the short way round. */
function mixOklch(x: Lab, y: Lab, share: number): Lab {
  const cx = Math.hypot(x[1], x[2]);
  const cy = Math.hypot(y[1], y[2]);
  // A hue with no chroma is powerless in CSS: the other colour's hue is taken.
  const hx = cx < 1e-4 ? Math.atan2(y[2], y[1]) : Math.atan2(x[2], x[1]);
  const hy = cy < 1e-4 ? hx : Math.atan2(y[2], y[1]);
  let d = hy - hx;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  const t = 1 - share;
  const h = hx + d * t;
  const c = cx * share + cy * t;
  return [x[0] * share + y[0] * t, c * Math.cos(h), c * Math.sin(h)];
}

/** `color-mix(in oklab, x <share>, y)`: each OKLab coordinate `share` of the way from y to x. */
function mixOklab(x: Lab, y: Lab, share: number): Lab {
  const t = 1 - share;
  return [x[0] * share + y[0] * t, x[1] * share + y[1] * t, x[2] * share + y[2] * t];
}

// ── The floor ─────────────────────────────────────────────────────────────────────────────────

const STEP = 0.0025;

/**
 * How far past a floor a pushed value lands: a value written at exactly 0.04 paints a hair under it once the screen
 * rounds it to 8 bits (0.0399 was measured). A value that meets its floor as Collie's relation made it is not moved.
 */
const MARGIN = { distance: 0.006, ratio: 0.1 } as const;

/** A floor check: `margin` false for the value as the relation made it, true for a value the floor pushes. */
export type Floor = (c: Lab, margin: boolean) => boolean;

/**
 * `start` when it meets its floor as it is; otherwise the first lightness that meets it (with MARGIN), walking from
 * `start` in `direction` (+1 lighter, -1 darker), then, if that runs out of range and `bothWays`, the other way. Hue
 * and chroma stay. When no lightness meets it, the one with the best `score` (how close it came).
 */
export function pushLightness(start: Lab, direction: 1 | -1, floor: Floor, score: (c: Lab) => number, bothWays = true): Lab {
  // A start that is not moved is still returned as painted: the colour checked is the colour on the screen.
  if (floor(start, false)) return painted(start);
  for (const dir of bothWays ? [direction, -direction] : [direction]) {
    for (let L = start[0] + dir * STEP; L >= 0 && L <= 1; L += dir * STEP) {
      // The floor is checked on the painted value, the one returned, so a value on a floor's edge cannot pass and then fail.
      const c = painted(withLightness(start, L));
      if (floor(c, true)) return c;
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

/** `distance(x, y) >= floor`, with the margin when asked. */
const off = (x: Lab, y: Lab, floor: number, margin: boolean): boolean => distance(x, y) >= floor + (margin ? MARGIN.distance : 0);

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

/** A ground on the same side of the ink as the page: lighter than it when the page is, darker when the page is. */
function sameSide(ink: Lab, ground: Lab, page: Lab): boolean {
  return Math.sign(ground[0] - ink[0]) === Math.sign(page[0] - ink[0]);
}

/**
 * The ink that must stay readable on a ground: never worse than the floor, nor than the page already gives it, and on
 * the same side of the ink as the page (a dark page's plane never turns light: a low-contrast theme's mid-grey ink
 * reads as badly on both, and the page would flip).
 */
function inkHolds(ink: Lab, ground: Lab, page: Lab, margin = false): boolean {
  if (!sameSide(ink, ground, page)) return false;
  return contrast(ink, ground) >= Math.min(TEXT_FLOOR + (margin ? MARGIN.ratio : 0), contrast(ink, page)) - 1e-6;
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
  const inks: Floor = (c, m) => inkHolds(muted, c, page, m) && inkHolds(fg, c, page, m);
  const recess = placePlane(recessStart, awayFrom(recessStart, page), inks, [(c, m) => off(c, page, PLANE_GAP, m)], muted, true);
  w.out["surface-recess"] = recess;

  const paperStart = own("surface-paper") ?? (w.half === "light" ? withLightness(card, Math.min(1, card[0] + 0.05)) : mixOklch(page, withLightness(card, card[0] + 0.05), 0.5));
  const paperDir = distance(paperStart, page) > 1e-3 ? awayFrom(paperStart, page) : awayFrom(paperStart, recess);
  w.out["surface-paper"] = placePlane(paperStart, paperDir, inks, [(c, m) => off(c, page, PLANE_GAP, m), (c, m) => off(c, recess, PLANE_GAP, m)], muted, false);
}

/**
 * A plane under its floors, the ink first. The gaps are tried as a list, the most wanted first (off the page, then off
 * the recess), and dropped from the end until a lightness meets the ink's floor and the gaps left. The recess may
 * turn the other way when its own runs out (lighter than a mid-grey page whose muted ink allows no darker step); the
 * paper's gaps are sought only in its own direction, so it never turns darker than the recess to stand off a white
 * page. With
 * no gap left the plane may sit on the page (a white page has no lighter paper, as Daylight's); with no lightness at
 * all, the one the muted ink reads best on.
 */
function placePlane(start: Lab, direction: 1 | -1, inks: Floor, gaps: readonly Floor[], muted: Lab, bothWays: boolean): Lab {
  for (let keep = gaps.length; keep > 0; keep -= 1) {
    const kept = gaps.slice(0, keep);
    const floor: Floor = (c, m) => inks(c, m) && kept.every((g) => g(c, m));
    const found = pushLightness(start, direction, floor, () => Number.NEGATIVE_INFINITY, bothWays);
    if (floor(found, false)) return found;
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
 * plane. Floors: a hover HOVER_FLOOR off its ground, a selected and an open fill STATE_FLOOR off it, and the inks on
 * each fill as readable as on the page: the foreground always, the muted ink (a row's second line) where a lightness on
 * the relation's side allows it.
 */
function states(w: Work): void {
  const accent = w.colour("accent");
  const fg = w.colour("foreground");
  const muted = w.colour("muted-foreground");
  const page = w.colour("background");
  const recess = made(w, "surface-recess");
  const on = w.colour("control-on");
  const onInk = w.colour("control-on-foreground");
  const onInkHolds = (c: Lab) => contrast(onInk, c) >= Math.min(TEXT_FLOOR, contrast(onInk, on)) - 1e-6;
  for (const plane of PLANES) {
    const ground = groundOf(w, plane);
    // The page's fills are also what a strip of the recess with no plane class shows (the space header): a fill the
    // floor has to push is pushed clear of the recess too, so it does not land on it. Collie's own are not pushed.
    const alsoOff = (c: Lab, floor: number, m: boolean) => !m || plane !== "page" || off(c, recess, floor, m);
    const fillStart = plane === "recess" ? made(w, "surface-paper") : accent;
    const fill = (floor: number): Lab => {
      const reach: Floor = (c, m) => off(c, ground, floor, m) && inkHolds(fg, c, page, m);
      const keepsMuted: Floor = (c, m) => inkHolds(muted, c, page, m);
      return pushTiers(fillStart, awayFrom(fillStart, ground), [
        (c, m) => reach(c, m) && alsoOff(c, floor, m) && keepsMuted(c, m),
        (c, m) => reach(c, m) && keepsMuted(c, m),
        (c, m) => reach(c, m) && alsoOff(c, floor, m),
        reach,
      ], (c) => (sameSide(fg, c, page) && sameSide(muted, c, page) ? distance(c, ground) : -1));
    };
    w.out[`state-hover-${plane}`] = fill(HOVER_FLOOR);
    w.out[`state-on-${plane}`] = fill(STATE_FLOOR);
    w.out[`state-open-${plane}`] = pushTiers(on, awayFrom(on, ground), [
      (c, m) => off(c, ground, STATE_FLOOR, m) && alsoOff(c, STATE_FLOOR, m) && onInkHolds(c),
      (c, m) => off(c, ground, STATE_FLOOR, m) && onInkHolds(c),
    ], (c) => (onInkHolds(c) ? distance(c, ground) : -1));
  }
}

/**
 * A fill under a list of floors, the strictest first. Each is sought in the relation's own direction before any is
 * sought the other way, so a fill keeps the side Collie's relation gave it while a looser floor allows that. With none
 * met (a low-contrast theme, whose ink has no room), the lightness with the best `score`: for a fill the farthest from
 * its ground on the page's side of both inks, so neither ink ever lands on a fill of its own lightness.
 */
function pushTiers(start: Lab, direction: 1 | -1, tiers: readonly Floor[], score: (c: Lab) => number): Lab {
  for (const bothWays of [false, true]) {
    for (const tier of tiers) {
      // The relation's own value is checked as it is, with no margin; a pushed one with it.
      if (tier(start, false)) return painted(start);
      const found = pushLightness(start, direction, tier, () => Number.NEGATIVE_INFINITY, bothWays);
      if (tier(found, true)) return found;
    }
  }
  return pushLightness(start, direction, () => false, score);
}

/**
 * THE RING. Collie's relation: the theme's own `--ring`. Floor: 3:1 against every ground it is drawn on, the page,
 * the card, the three planes, the band (`secondary`), the muted fill, and each plane's hover and selected fill. Not against a filled primary button: the
 * house ring stands 2px off the box, so the gap, a ground, is on both its sides; and Collie's own dark ring is 1.9:1
 * against its white primary, so that floor would move the ring Altan approved.
 */
function ring(w: Work): void {
  const page = w.colour("background");
  // A focused row is often the hovered or the selected one, and its neighbour may be: the fills are grounds too.
  const fills = PLANES.flatMap((plane) => [made(w, `state-hover-${plane}`), made(w, `state-on-${plane}`)]);
  const grounds = [page, w.colour("card"), made(w, "surface-recess"), made(w, "surface-paper"), w.colour("secondary"), w.colour("muted"), ...fills];
  const start = w.colour("ring");
  const worst = (c: Lab) => Math.min(...grounds.map((g) => contrast(c, g)));
  w.out.ring = pushLightness(start, awayFrom(start, page), (c, m) => worst(c) >= RING_FLOOR + (m ? MARGIN.ratio : 0), worst);
}

/**
 * THE FIRM EDGE (ADR 0171): the line the large screen's tab bar and a pane's header stand on. Collie's relation is
 * index.css's own, `color-mix(in oklch, var(--foreground) 58%, var(--background))`. Floor: 3:1 against the grounds it
 * separates, the recess (the bar), the page (the open tab) and the paper (a column's header), pushed toward the ink.
 */
function edgeFirm(w: Work): void {
  const page = w.colour("background");
  const start = mixOklch(w.colour("foreground"), page, EDGE_SHARE);
  const grounds = [page, made(w, "surface-recess"), made(w, "surface-paper")];
  const worst = (c: Lab) => Math.min(...grounds.map((g) => contrast(c, g)));
  w.out["edge-firm"] = pushLightness(start, awayFrom(start, page), (c, m) => worst(c) >= EDGE_FLOOR + (m ? MARGIN.ratio : 0), worst);
}

/**
 * THE PANE FRAME (ADR 0174): the 1px hairline around the pane you are in on a large screen. The relation is
 * index.css's own `--pane-active`: a start colour mixed into the page in OKLab, 70% in light and 60% in dark. The
 * start is the theme's own `pane-active` when the half sets one, and the "on" ink (`control-on-foreground`) when it
 * does not, so a theme's colour is drawn as quiet as Collie's. `filled` comes from `fillHalves` over Collie, whose
 * file holds no `pane-active` (a derived token), so a value here is always the theme's own. Floor: 3:1 against the
 * three grounds it touches, the recess (the rail at its left), the page (a column without focus at its right) and
 * the paper inside it, pushed away from the page.
 */
function paneFrame(w: Work): void {
  const page = w.colour("background");
  const own = w.tokens["pane-active"] === undefined ? w.colour("control-on-foreground") : w.colour("pane-active");
  const start = mixOklab(own, page, FRAME_SHARE[w.half]);
  const grounds = [page, made(w, "surface-recess"), made(w, "surface-paper")];
  const worst = (c: Lab) => Math.min(...grounds.map((g) => contrast(c, g)));
  w.out["pane-active"] = pushLightness(start, awayFrom(start, page), (c, m) => worst(c) >= FRAME_FLOOR + (m ? MARGIN.ratio : 0), worst);
}

const STEPS: readonly ((w: Work) => void)[] = [planes, states, ring, edgeFirm, paneFrame];

/** A floor the derivation could not meet: the token, the floor in words, and the value it reached. */
export interface UnmetFloor {
  token: DerivedToken;
  floor: string;
  reached: number;
}

/**
 * How the planes ended: in the light half a recess lighter than the page (the order turned over, as `placePlane` may do
 * when the muted ink leaves no darker step), and planes that sit on each other (within 0.005).
 */
export interface PlaneOrder {
  recessLighterInLight: boolean;
  collapsed: boolean;
}

/** What `deriveReport` returns: the tokens, the floors not met, and how the planes ended. */
export interface DeriveReport {
  tokens: DerivedHalf;
  unmet: UnmetFloor[];
  planes: PlaneOrder;
}

/**
 * The derived tokens and an honest account: which floors were not met (where floors fight, the code takes the best it
 * can reach), and how the planes ended. Unused by the app for now; derive.test.ts reads it. Each floor is checked on
 * the finished values with the definitions the steps use, without the margin a pushed value is given.
 */
export function deriveReport(tokens: Half, half: Half2): DeriveReport {
  const out = deriveTokens(tokens, half);
  const page = parseColour(tokens.background ?? "");
  const token = (name: AnyThemeToken): Lab => parseColour(tokens[name] ?? "", page);
  const at = (name: DerivedToken): Lab => parseColour(out[name]);
  const fg = token("foreground");
  const muted = token("muted-foreground");
  const recess = at("surface-recess");
  const paper = at("surface-paper");
  const unmet: UnmetFloor[] = [];
  const need = (ok: boolean, name: DerivedToken, floor: string, reached: number) => {
    if (!ok) unmet.push({ token: name, floor, reached: Math.round(reached * 1000) / 1000 });
  };
  for (const [name, plane] of [["surface-recess", recess], ["surface-paper", paper]] as const) {
    need(inkHolds(muted, plane, page), name, "muted ink 4.5:1 (or the page's)", contrast(muted, plane));
    need(inkHolds(fg, plane, page), name, "ink 4.5:1 (or the page's)", contrast(fg, plane));
    need(distance(plane, page) >= PLANE_GAP, name, `${String(PLANE_GAP)} off the page`, distance(plane, page));
  }
  need(distance(paper, recess) >= PLANE_GAP, "surface-paper", `${String(PLANE_GAP)} off the recess`, distance(paper, recess));
  const grounds = { page, recess, paper };
  for (const plane of PLANES) {
    const g = grounds[plane];
    for (const [kind, floor] of [["hover", HOVER_FLOOR], ["on", STATE_FLOOR], ["open", STATE_FLOOR]] as const) {
      const name: DerivedToken = `state-${kind}-${plane}`;
      need(distance(at(name), g) >= floor, name, `${String(floor)} off its ground`, distance(at(name), g));
    }
    for (const kind of ["hover", "on"] as const) {
      const name: DerivedToken = `state-${kind}-${plane}`;
      need(inkHolds(fg, at(name), page), name, "ink 4.5:1 (or the page's)", contrast(fg, at(name)));
    }
  }
  const fills = PLANES.flatMap((plane) => [at(`state-hover-${plane}`), at(`state-on-${plane}`)]);
  const ringGrounds = [page, token("card"), recess, paper, token("secondary"), token("muted"), ...fills];
  const ringWorst = Math.min(...ringGrounds.map((g) => contrast(at("ring"), g)));
  need(ringWorst >= RING_FLOOR, "ring", `${String(RING_FLOOR)}:1 on every ground`, ringWorst);
  const edgeWorst = Math.min(...[page, recess, paper].map((g) => contrast(at("edge-firm"), g)));
  need(edgeWorst >= EDGE_FLOOR, "edge-firm", `${String(EDGE_FLOOR)}:1 on the recess, the page and the paper`, edgeWorst);
  const frameWorst = Math.min(...[page, recess, paper].map((g) => contrast(at("pane-active"), g)));
  need(frameWorst >= FRAME_FLOOR, "pane-active", `${String(FRAME_FLOOR)}:1 on the recess, the page and the paper`, frameWorst);
  const recessLighterInLight = half === "light" && recess[0] > page[0] + 1e-3;
  const collapsed = distance(recess, page) < 0.005 || distance(paper, page) < 0.005 || distance(paper, recess) < 0.005;
  return { tokens: out, unmet, planes: { recessLighterInLight, collapsed } };
}

/**
 * The derived tokens of one half of a theme, each an `oklch()` value. `tokens` is the half filled from Collie
 * (`fillHalves`), so every base token is there.
 */
export function deriveTokens(tokens: Half, half: Half2): DerivedHalf {
  const pageValue = tokens.background;
  if (pageValue === undefined) throw new Error("derive: the half has no background");
  const page = parseColour(pageValue);
  // A token with alpha (a `ring` or a `muted-foreground` with `/ A`) is measured as laid over the page; over the recess,
  // the paper or a fill it paints a little differently, and that difference is not measured.
  const colour = (token: AnyThemeToken): Lab => {
    const v = tokens[token];
    if (v === undefined) throw new Error(`derive: the half has no "${token}"`);
    return parseColour(v, page);
  };
  const w: Work = { half, tokens, colour, out: {} };
  for (const step of STEPS) step(w);
  // SAFETY: the entries are exactly DERIVED_TOKENS, each made above (`made` throws for one that is not).
  return Object.fromEntries(DERIVED_TOKENS.map((token) => [token, formatColour(made(w, token))])) as DerivedHalf;
}
