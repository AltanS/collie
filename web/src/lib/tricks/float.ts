// THE FLOAT PLACE, THE PURE HALF: small moving pictures drawn over the app. A `float` part names a picture
// of the trick's `media/` folder, a motion from a fixed list and a mood; this file reads the part, finds the
// free area of the screen, lays each motion out inside it, and holds the limits. The component that draws
// and watches the screen is `components/trick-float-layer.tsx`; the DOM readers are
// `hooks/use-float-region.ts` and `hooks/use-float-cover.ts`.
//
// NOTHING OF THE TRICK REACHES THE SCREEN BUT WORDS FROM CLOSED LISTS. `readFloat` takes a stored part and
// gives back a spec in which every field is one of those words, a whole number inside its range, or the
// image path the media rule takes; a part that does not read is left out. No coordinate, style or time
// comes from a trick: Collie places the picture, times the motion, and may hide it.
//
// THE FREE AREA is the one rectangle a picture may be in. It is the visual viewport (so the soft keyboard
// counts) less the safe-area insets, less the boxes of Collie's own landmarks (header, strips, status row,
// Belt, composer, floating cards), each with a small gap. It is the largest empty rectangle left, found
// from the edges of those boxes (`freeArea`). Every motion below is a path inside it, so a picture never
// meets a landmark, and an area too small for one picture draws nothing (`FLOAT_MIN_REGION`).
//
// THE LIMITS, each held by a pure rule with a test: one stay picture per trick and two on screen in all
// (`capStay`), a once-shot at most once a minute per trick and one on screen at a time, one waiting and the
// rest dropped (`OnceQueue`), a once-motion of at most five seconds (`FLOAT_ONCE_MAX_MS`), a wander at most
// every ten seconds (`FLOAT_WANDER_EVERY_MS`). Motion uses transform and opacity only.

import {
  CHIP_STATES,
  FLOAT_ALONG,
  FLOAT_EDGES,
  FLOAT_FPS_MAX,
  FLOAT_FRAMES_MAX,
  FLOAT_ONCE_MOTIONS,
  FLOAT_OPENS,
  FLOAT_ROWS_MAX,
  FLOAT_SIZES,
  FLOAT_STAY_MOTIONS,
  isImageSrc,
  isPartId,
  partKey,
  type ChipState,
  type FloatAlong,
  type FloatEdge,
  type FloatMode,
  type FloatMotion,
  type FloatOpens,
  type FloatSize,
  type WireTrickPart,
} from "./schema";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonObject, type JsonValue } from "../json";

// ── The numbers ──────────────────────────────────────────────────────────────────────────────

/** The three sizes of a picture, in CSS pixels: the drawn HEIGHT of a frame. The width follows the frame's own shape. */
export const FLOAT_SIZE_PX = { s: 32, m: 48, l: 72 } as const satisfies Record<FloatSize, number>;
/** A perched picture keeps this far from the ends of its edge (less when the edge has no more room), so it never sits in a corner. */
export const FLOAT_EDGE_MARGIN_PX = 8;
/** The tap target of a parked picture that opens a page (DESIGN.md: 44 px). */
export const FLOAT_TAP_PX = 44;
/** The gap kept around every landmark, in pixels. */
export const FLOAT_GAP_PX = 4;
/** The free area under which nothing is drawn: a stay picture hides and a once-shot is skipped. */
export const FLOAT_MIN_REGION = { w: 120, h: 96 } as const;
/**
 * How long each once-motion plays. An arc and a pop play this long. A fly-across is set by SPEED, not by time: its entry is the time
 * of the reference crossing, `FLOAT_FLY_REF_PX` wide (a 390 px phone), and its real time is its path over that speed ({@link flyMs}).
 */
export const FLOAT_ONCE_MS = { "fly-across": 3200, arc: 3700, pop: 2100 } as const satisfies Record<(typeof FLOAT_ONCE_MOTIONS)[number], number>;
/** The width a fly-across crosses in {@link FLOAT_ONCE_MS}`["fly-across"]`: a 390 px phone's whole free width. Its speed is this over that time. */
export const FLOAT_FLY_REF_PX = 390;
/** The shortest and the longest a fly-across may take, whatever its path. Inside these it moves at one even speed. */
export const FLOAT_FLY_MIN_MS = 2000;
export const FLOAT_FLY_MAX_MS = 5000;
/** The most a once-motion may last, the bound the table above and a fly-across are held to. */
export const FLOAT_ONCE_MAX_MS = FLOAT_FLY_MAX_MS;
/** A trick's once-shots start at least this far apart, counted from the real start. It is longer than the longest once-motion. */
export const FLOAT_ONCE_EVERY_MS = 15_000;
/** The most stay pictures on screen across all tricks. */
export const FLOAT_STAY_MAX = 2;
/** A wandering picture moves to a new spot no more often than this. */
export const FLOAT_WANDER_EVERY_MS = 10_000;
/** The glide between two spots of a wander, and the settle after the free area changed. */
export const FLOAT_WANDER_GLIDE_MS = 1400;
export const FLOAT_SETTLE_MS = 300;
/** How far an idle picture bobs, in pixels, either way. The free area is held in by this much for it. */
export const FLOAT_IDLE_BOB_PX = 3;
/** The biggest scale of a `pop`, about its centre. */
export const FLOAT_POP_SCALE = 1.2;
/** Where a once motion that starts from a pet starts, down the pet's height from its top: about the height of a hand. */
export const FLOAT_FROM_HAND = 0.4;
/** How long a once part that arrives before the layer has its free area is kept for it, before it is dropped. */
export const FLOAT_PENDING_MS = 2000;
/** How long a once part with `from` waits for the stay picture it names to report where it is, before it starts as usual. */
export const FLOAT_FROM_WAIT_MS = 1500;
/** How long a once part with `from` waits for the stay picture it names to play its frames to the last one (`sprite.loop = false`), counted from the shot's arrival, before it starts anyway. */
export const FLOAT_THROW_WAIT_MS = 2000;
/**
 * How long the layer may be away (a Page open, another screen, a sheet, a hidden page) before a play that it left half way is not resumed:
 * past this the picture shows its end state and a shot that waited for it is dropped as stale.
 */
export const FLOAT_AWAY_CAP_MS = 30_000;
/** The fade of a stay picture that appears: in place, no travel. */
export const FLOAT_ENTER_MS = 180;

// ── The box maths ────────────────────────────────────────────────────────────────────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const EPS = 0.01;

/** Whether two boxes share any area. Boxes that only touch do not. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** Whether `inner` lies inside `outer`, edges included. */
export function within(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;
}

export function inflate(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by };
}

/** The viewport less the safe-area insets. */
export function visibleBox(viewport: Box, insets: Insets): Box {
  return {
    x: viewport.x + insets.left,
    y: viewport.y + insets.top,
    w: Math.max(0, viewport.w - insets.left - insets.right),
    h: Math.max(0, viewport.h - insets.top - insets.bottom),
  };
}

function clip(box: Box, area: Box): Box | null {
  const x1 = Math.max(box.x, area.x);
  const y1 = Math.max(box.y, area.y);
  const x2 = Math.min(box.x + box.w, area.x + area.w);
  const y2 = Math.min(box.y + box.h, area.y + area.h);
  return x2 - x1 > EPS && y2 - y1 > EPS ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/**
 * The largest rectangle inside `area` that touches no obstacle, or null when none has any area. The
 * candidate left and right edges are the edges of the area and of the obstacles; for each pair, the
 * obstacles that cross that band are swept from the top and the largest gap between them is the rectangle.
 * With n obstacles that is about n squared times n log n, and n is a handful.
 */
export function freeArea(area: Box, obstacles: readonly Box[]): Box | null {
  if (area.w <= EPS || area.h <= EPS) return null;
  const blocks = obstacles.map((o) => clip(o, area)).filter((o): o is Box => o !== null);
  const xs = [...new Set([area.x, area.x + area.w, ...blocks.flatMap((b) => [b.x, b.x + b.w])])].toSorted((a, b) => a - b);
  let best: Box | null = null;
  let bestArea = 0;
  const consider = (x: number, y: number, w: number, h: number): void => {
    if (w <= EPS || h <= EPS || w * h <= bestArea) return;
    best = { x, y, w, h };
    bestArea = w * h;
  };
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const x1 = xs[i] ?? 0;
      const x2 = xs[j] ?? 0;
      const across = blocks.filter((b) => b.x < x2 - EPS && b.x + b.w > x1 + EPS).toSorted((a, b) => a.y - b.y);
      let cursor = area.y;
      for (const b of across) {
        consider(x1, cursor, x2 - x1, b.y - cursor);
        cursor = Math.max(cursor, b.y + b.h);
      }
      consider(x1, cursor, x2 - x1, area.y + area.h - cursor);
    }
  }
  return best;
}

/**
 * The safe region: the free area left in the visual viewport after the insets and the landmarks (each held
 * `gap` apart), on whole pixels, or null when it is smaller than {@link FLOAT_MIN_REGION}.
 *
 * The four EDGES are rounded to the nearest pixel and the size follows from them, so a landmark at 734.984375
 * (WebKit lays out on a 1/64 px grid) puts the bottom edge at 735 less the gap, as at 735 in Chromium, and costs no
 * pixel. The landmarks are inflated by `gap` before the area is cut, so a rounding of at most half a pixel stays
 * inside the gap and never meets a landmark. A `gap` under half a pixel has no such room, so then every edge
 * rounds inward and the region can only shrink. The minimum is checked on the rounded region, which is the
 * one returned, so it never comes back smaller than the minimum. An edge that sits at x.5 can flip by one
 * pixel on a jitter across it; the next value is whole again and `sameBox` redraws once, not in a loop,
 * because a picture is an overlay that moves no landmark.
 */
export function safeRegion(opts: { viewport: Box; insets: Insets; landmarks: readonly Box[]; gap?: number }): Box | null {
  const gap = opts.gap ?? FLOAT_GAP_PX;
  const area = visibleBox(opts.viewport, opts.insets);
  const free = freeArea(
    area,
    opts.landmarks.map((box) => inflate(box, gap)),
  );
  if (free === null) return null;
  const inward = gap < 0.5;
  const low = inward ? Math.ceil : Math.round;
  const high = inward ? Math.floor : Math.round;
  const left = low(free.x);
  const top = low(free.y);
  const region = { x: left, y: top, w: high(free.x + free.w) - left, h: high(free.y + free.h) - top };
  if (region.w < FLOAT_MIN_REGION.w || region.h < FLOAT_MIN_REGION.h) return null;
  return region;
}

/** Whether two regions are the same to the pixel, so an unchanged measure does not redraw. */
export function sameBox(a: Box | null, b: Box | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1;
}

// ── Where the landmarks are ──────────────────────────────────────────────────────────────────

/** The screens a picture may be on: the Dashboard, and a session's Chat or Terminal. Nothing else draws it. */
export type FloatScreen = "dashboard" | "session";

/**
 * Collie's own landmarks, as the selectors of their `data-slot` boxes, by screen. A box that is not on the
 * screen, or has no area (an empty floating-cards slot), takes no room. Each one is a box a picture must
 * not sit on: a bar, a strip, the composer and what floats over it, a card.
 */
export const FLOAT_LANDMARKS = {
  dashboard: [
    '[data-slot="header-row"]',
    '[data-slot="tile-strip"]',
    '[data-slot="tab-bar"]',
    '[data-slot="fab-layer"] button',
    '[data-slot="floating-cards"]',
    '[data-slot="column-header"]',
  ],
  session: [
    '[data-slot="header-row"]',
    '[data-slot="collapse-swap"]',
    '[data-slot="model-tag"]',
    '[data-slot="pane-bottom"]',
    '[data-slot="card-dock"]',
    '[data-slot="draft-notice-slot"]',
    '[data-slot="floating-cards"]',
    '[data-slot="held-card"]',
    '[data-slot="column-header"]',
  ],
} as const satisfies Record<FloatScreen, readonly string[]>;

/**
 * What hides every picture while it is on screen: a sheet or a dialog, the cards that ask a question
 * (a question, a permission, a plan, a prompt), a Hill card, and a session's agent view. A hold and a
 * focused text field are read apart (`use-float-cover.ts`).
 */
export const FLOAT_COVER = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-slot="card-dock"]',
  '[data-slot="ask-card"]',
  '[data-slot="decision-card"]',
  '[data-slot="cannot-tell-card"]',
  '[data-slot="view-screen"]',
] as const;

/** The route a picture is drawn on, or null for every other: `/` is the Dashboard, `/pane/<id>` a session. */
export function floatScreenOf(pathname: string): FloatScreen | null {
  if (pathname === "/" || pathname === "") return "dashboard";
  return /^\/pane\/[^/]+\/?$/u.test(pathname) ? "session" : null;
}

// ── Reading a part ───────────────────────────────────────────────────────────────────────────

/** A float part read for the phone: every field a word of its list or a number in its range. */
export interface FloatSpec {
  /** The part's key, `partKey`. */
  key: string;
  /** The trick, `host/trick`, the unit of every per-trick limit. */
  trick: string;
  host: string;
  trickId: string;
  /** The part's id, the last piece of its key. */
  id: string;
  rev: number;
  mode: FloatMode;
  motion: FloatMotion;
  edge: FloatEdge;
  /** With `perch`: where along the edge. `end` when the part leaves it out. */
  along: FloatAlong;
  /** A once part: the id of the stay part of this trick its motion starts from, when that picture is on screen. */
  from: string | undefined;
  src: string;
  frames: number;
  rows: number;
  fps: number;
  /** `false`: the frames play once and the last one stays. `true`: they loop. */
  loop: boolean;
  /** A stay part whose sprite plays once: the second sprite that starts when the first reaches its last frame (`sprite.after`). */
  after: FloatAfterSpec | undefined;
  size: FloatSize;
  mood: ChipState;
  opens: FloatOpens | undefined;
  /** The part is the last good one of a run that failed. */
  stale: boolean;
  part: WireTrickPart;
}

/** The second sprite of a stay part (`sprite.after`), every field read. Its frames are as high as the first sprite's and as wide as its own sheet says. */
export interface FloatAfterSpec {
  src: string;
  frames: number;
  fps: number;
  loop: boolean;
}

function inList<T extends string>(list: readonly T[], word: string | undefined): T | undefined {
  return list.find((entry) => entry === word);
}

function whole(raw: JsonValue | undefined, min: number, max: number): number | undefined {
  const n = asJsonNumber(raw);
  return n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/**
 * A stored part as a spec, or null when it is not a float part or does not read. The bridge checked it
 * already; this check is for a crew member on another version, so each word is read from its list again
 * and a picture path from the media rule. A motion of the other mode, an `opens` on a once part or a
 * wandering one, and a stray key are all not drawn as asked: the part is left out.
 */
export function readFloat(part: WireTrickPart): FloatSpec | null {
  // The wire carries the part as stored JSON, not as the typed part the bridge meant: read it as JSON again.
  const value = asJsonObject(parseJson(JSON.stringify(part.value)));
  if (value === undefined || value.at !== "float") return null;
  const mode = inList(["once", "stay"] as const, asJsonString(value.mode));
  const motion = inList([...FLOAT_ONCE_MOTIONS, ...FLOAT_STAY_MOTIONS] as const, asJsonString(value.motion));
  if (mode === undefined || motion === undefined) return null;
  const mine: readonly string[] = mode === "once" ? FLOAT_ONCE_MOTIONS : FLOAT_STAY_MOTIONS;
  if (!mine.includes(motion)) return null;
  const sprite = asJsonObject(value.sprite);
  const src = asJsonString(sprite?.src);
  if (sprite === undefined || src === undefined || !isImageSrc(src)) return null;
  const frames = sprite.frames === undefined ? 1 : whole(sprite.frames, 1, FLOAT_FRAMES_MAX);
  const rows = sprite.rows === undefined ? 1 : whole(sprite.rows, 1, FLOAT_ROWS_MAX);
  const fps = sprite.fps === undefined ? 6 : whole(sprite.fps, 1, FLOAT_FPS_MAX);
  const size = sprite.size === undefined ? "s" : inList(FLOAT_SIZES, asJsonString(sprite.size));
  const loop = sprite.loop === undefined ? true : asJsonBoolean(sprite.loop);
  if (frames === undefined || rows === undefined || fps === undefined || size === undefined || loop === undefined) return null;
  const after = sprite.after === undefined ? undefined : readAfter(asJsonObject(sprite.after), { stay: mode === "stay", outerLoops: loop });
  if (sprite.after !== undefined && after === undefined) return null;
  const mood = value.mood === undefined ? "idle" : inList(CHIP_STATES, asJsonString(value.mood));
  const edge = value.edge === undefined ? "bottom" : inList(FLOAT_EDGES, asJsonString(value.edge));
  if (mood === undefined || edge === undefined) return null;
  const along = value.along === undefined ? "end" : inList(FLOAT_ALONG, asJsonString(value.along));
  if (along === undefined) return null;
  const fromRaw = value.from === undefined ? undefined : asJsonString(value.from);
  if (value.from !== undefined && (fromRaw === undefined || !isPartId(fromRaw) || mode !== "once")) return null;
  const opens = value.opens === undefined ? undefined : inList(FLOAT_OPENS, asJsonString(value.opens));
  if (value.opens !== undefined && (opens === undefined || mode === "once" || motion === "wander")) return null;
  return {
    key: partKey(part),
    trick: `${part.host}/${part.trick}`,
    host: part.host,
    trickId: part.trick,
    id: part.part,
    rev: part.rev,
    mode,
    motion,
    edge,
    along,
    from: fromRaw,
    src,
    frames,
    rows,
    fps,
    loop,
    after,
    size,
    mood,
    opens,
    stale: part.stale === true,
    part,
  };
}

/**
 * The `sprite.after` of a part, or undefined when it does not read: not an object, a key outside `src`, `frames`, `fps` and `loop` (so no
 * `rows`, no `size`, no `after` of its own), a part that plays once instead of staying, or a first sprite that loops (it never reaches
 * a last frame for the second to follow).
 */
function readAfter(raw: JsonObject | undefined, own: { stay: boolean; outerLoops: boolean }): FloatAfterSpec | undefined {
  if (raw === undefined || !own.stay || own.outerLoops) return undefined;
  if (Object.keys(raw).some((key) => !["src", "frames", "fps", "loop"].includes(key))) return undefined;
  const src = asJsonString(raw.src);
  if (src === undefined || !isImageSrc(src)) return undefined;
  const frames = raw.frames === undefined ? 1 : whole(raw.frames, 1, FLOAT_FRAMES_MAX);
  const fps = raw.fps === undefined ? 6 : whole(raw.fps, 1, FLOAT_FPS_MAX);
  const loop = raw.loop === undefined ? true : asJsonBoolean(raw.loop);
  if (frames === undefined || fps === undefined || loop === undefined) return undefined;
  return { src, frames, fps, loop };
}

/**
 * The spec the second sprite draws as: the part's own, with the second sheet's picture, frames, rate and loop, one row, and no `after`.
 * Its frames are as high as the first sprite's (`size` is kept).
 */
export function afterSpecOf(spec: FloatSpec): FloatSpec | undefined {
  if (spec.after === undefined) return undefined;
  return { ...spec, src: spec.after.src, frames: spec.after.frames, rows: 1, fps: spec.after.fps, loop: spec.after.loop, after: undefined };
}

/**
 * Where a stay picture rests once its second sprite shows. The box takes the second sheet's own width (`afterAspect`) at once, kept on the part's
 * anchor: a `perch` along its edge keeps the left side fixed for `start`, the right for `end` and the centre for `middle` (the edge it stands on does
 * not move), as `restOf` places a box of that width. Another motion keeps the first sprite's left side, held inside the region.
 */
export function afterRestOf(
  spec: Pick<FloatSpec, "key" | "motion" | "edge" | "along" | "size" | "opens">,
  region: Box,
  step: number,
  aspects: { first: number; after: number },
  reach: Box = region,
): Point {
  if (spec.motion === "perch") return restOf(spec, region, step, aspects.after, reach);
  const first = restOf(spec, region, step, aspects.first, reach);
  const wide = boxDims(spec, aspects.after);
  return { x: Math.max(region.x, Math.min(first.x, region.x + Math.max(0, region.w - wide.w))), y: first.y };
}

/** How long one pass over the frames of a sheet takes, in milliseconds. */
export function playMs(frames: number, fps: number): number {
  return (frames / fps) * 1000;
}

/** How far into a pass the last frame appears, in milliseconds: the frames before it have each been shown for one tick. */
export function lastFrameAtMs(frames: number, fps: number): number {
  return ((frames - 1) / fps) * 1000;
}

/**
 * What a part draws and where it shows: a change of it (a new value, or a new binding), and not a new `asOf` or a
 * moved rev, is a re-print that says something. A once part plays again on it, and a sprite that plays once plays again.
 */
export function partSignature(part: WireTrickPart): string {
  return `${JSON.stringify(part.value)}|${JSON.stringify(part.bound ?? null)}`;
}

/** The row of a sprite sheet a mood draws: its place in the chip states. */
export function moodRow(mood: ChipState): number {
  return CHIP_STATES.indexOf(mood);
}

/**
 * The width over the height of one frame of a sheet: the sheet is `frames` frames side by side and `rows`
 * rows (one, unless the part says more), so a frame is `width / frames` wide and `height / rows` high and
 * need not be square. 1 while the picture is not loaded or reports no size.
 */
export function frameAspect(natural: { w: number; h: number } | null, frames: number, rows = 1): number {
  if (natural === null || !(natural.w > 0) || !(natural.h > 0)) return 1;
  return natural.w / frames / (natural.h / rows);
}

/** The row to draw: the mood's own, or the first when the sheet has fewer rows. */
export function rowFor(mood: ChipState, rows: number): number {
  const row = moodRow(mood);
  return row < rows ? row : 0;
}

// ── Which parts show here ────────────────────────────────────────────────────────────────────

/**
 * What a session is to this place: its pane on the phone (the fields of `AgentView` that `menu.ts` reads too; kept
 * here so the catalogue, which the docs scripts load, does not pull the app's types in).
 */
export interface FloatPane {
  readonly host?: string;
  readonly paneId: string;
  readonly kind?: "agent" | "shell" | "trick";
  readonly instance?: string;
}

/** Whether a part is bound to this pane (as `menu.ts` `boundHere` says it), and the pane is an agent session. */
function boundToPane(part: WireTrickPart, pane: FloatPane): boolean {
  if (pane.kind !== undefined && pane.kind !== "agent") return false;
  const key = `${pane.host ?? part.host}:${pane.paneId}`;
  return part.bound?.some((entry) => entry.session === key && entry.instance === pane.instance) === true;
}

/**
 * The pictures a screen shows, from the held parts of the `float` place, in trick order.
 * - The Dashboard shows the parts with no `sessions`.
 * - A session shows the parts bound to it (the scope key and the instance token match), and no unbound one.
 * - One of each mode per trick: the first.
 * - Tricks that are off are already out of `parts` (`useTrickParts`).
 */
export function floatsForScreen(parts: readonly WireTrickPart[], screen: { dashboard: true } | { pane: FloatPane | undefined }): FloatSpec[] {
  const out: FloatSpec[] = [];
  const taken = new Set<string>();
  for (const part of parts) {
    const spec = readFloat(part);
    if (spec === null) continue;
    const here = "dashboard" in screen ? part.bound === undefined : screen.pane !== undefined && boundToPane(part, screen.pane);
    if (!here) continue;
    const slot = `${spec.trick}/${spec.mode}`;
    if (taken.has(slot)) continue;
    taken.add(slot);
    out.push(spec);
  }
  return out;
}

/** The stay pictures to draw: the first {@link FLOAT_STAY_MAX} of the list's, which is in the order Settings lists the tricks. */
export function capStay(specs: readonly FloatSpec[]): FloatSpec[] {
  return specs.filter((spec) => spec.mode === "stay").slice(0, FLOAT_STAY_MAX);
}

// ── Where a picture is ───────────────────────────────────────────────────────────────────────

/** A number from 0 up to but not including 1, from a word and a salt: the same word and salt always give the same number. */
export function unit(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A point, in pixels. */
export interface Point {
  x: number;
  y: number;
}

/** A width and a height, in pixels. */
export interface Dims {
  w: number;
  h: number;
}

/** What a picture draws: a frame `FLOAT_SIZE_PX[size]` high, and as wide as its shape says (`aspect` is width over height). */
export function drawnDims(spec: Pick<FloatSpec, "size">, aspect = 1): Dims {
  const h = FLOAT_SIZE_PX[spec.size];
  return { w: h * aspect, h };
}

/**
 * The box a picture takes: what it draws, or at least the tap target on each side when a tap may open a
 * page, so the tap box is never smaller than the picture.
 */
export function boxDims(spec: Pick<FloatSpec, "size" | "opens">, aspect = 1): Dims {
  const drawn = drawnDims(spec, aspect);
  return spec.opens === undefined ? drawn : { w: Math.max(drawn.w, FLOAT_TAP_PX), h: Math.max(drawn.h, FLOAT_TAP_PX) };
}

/** Whether a box of `dims`, grown by `grow` about its centre, fits in the region. A picture that does not fit is not drawn. */
export function fitsRegion(dims: Dims, region: Box, grow = 1): boolean {
  return dims.w * grow <= region.w + EPS && dims.h * grow <= region.h + EPS;
}

/**
 * The region a perched picture may reach on its edge: the safe region grown by the landmark gap and cut to
 * the visible area. A side that a landmark bounds then meets the landmark's own edge, a side that the screen
 * bounds stays where it is. A perched picture stands on that edge, with no gap between it and what it stands on.
 */
export function perchReach(region: Box, visible: Box, gap = FLOAT_GAP_PX): Box {
  const grown = inflate(region, gap);
  const x1 = Math.max(grown.x, visible.x);
  const y1 = Math.max(grown.y, visible.y);
  const x2 = Math.min(grown.x + grown.w, visible.x + visible.w);
  const y2 = Math.min(grown.y + grown.h, visible.y + visible.h);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : region;
}

/** The place of a box of `size` along a stretch from `start` of `length`: the near end, the middle or the far end, kept a margin from the ends. */
function alongAxis(start: number, length: number, size: number, where: FloatAlong): number {
  const spare = Math.max(0, length - size);
  const margin = Math.min(FLOAT_EDGE_MARGIN_PX, spare / 2);
  if (where === "start") return start + margin;
  if (where === "end") return start + spare - margin;
  return start + spare / 2;
}

/** The position, top left, of a box of `dims` at the fractions `fx` and `fy` of the room that is left. */
function fraction(region: Box, dims: Dims, fx: number, fy: number): Point {
  return { x: region.x + fx * Math.max(0, region.w - dims.w), y: region.y + fy * Math.max(0, region.h - dims.h) };
}

/**
 * Where a stay picture rests, top left of its box (`dims` from `boxDims`, with the picture's `aspect`).
 * - `perch` STANDS ON ITS EDGE: the box touches the edge of `reach` (the landmark below it for `bottom`, the one
 *   above for `top`, and so on; the screen's edge where no landmark is). Along the edge, the part's `along`
 *   decides: `start`, `middle` or `end`, held a small margin from the corner.
 * - `idle` sits at a fixed spot a little above the middle, held in by the bob on each side.
 * - `wander` is at spot number `step`, each spot from the key and the step, inside the area.
 * Always inside the region (a perch inside `reach`, which is the region grown to the landmarks).
 */
export function restOf(
  spec: Pick<FloatSpec, "key" | "motion" | "edge" | "along" | "size" | "opens">,
  region: Box,
  step = 0,
  aspect = 1,
  reach: Box = region,
): Point {
  const dims = boxDims(spec, aspect);
  if (spec.motion === "perch") {
    switch (spec.edge) {
      case "top":
        return { x: alongAxis(region.x, region.w, dims.w, spec.along), y: reach.y };
      case "bottom":
        return { x: alongAxis(region.x, region.w, dims.w, spec.along), y: Math.max(reach.y, reach.y + reach.h - dims.h) };
      case "left":
        return { x: reach.x, y: alongAxis(region.y, region.h, dims.h, spec.along) };
      case "right":
        return { x: Math.max(reach.x, reach.x + reach.w - dims.w), y: alongAxis(region.y, region.h, dims.h, spec.along) };
    }
  }
  if (spec.motion === "wander") return fraction(region, dims, unit(spec.key, 100 + 2 * step), unit(spec.key, 101 + 2 * step));
  // idle: held in by the bob on each side
  const held = { x: region.x, y: region.y + FLOAT_IDLE_BOB_PX, w: region.w, h: Math.max(0, region.h - 2 * FLOAT_IDLE_BOB_PX) };
  return fraction(held, dims, 0.1 + 0.8 * unit(spec.key, 1), 0.55);
}

/**
 * Where the drawn picture sits inside its box, top left. The box is the picture or, when a tap may open a
 * page, the tap target around it. A perched picture is pushed to its edge of the box, so it stands on the
 * edge and not in the middle of its tap target; the others sit in the middle.
 */
export function spriteInBox(spec: Pick<FloatSpec, "motion" | "edge">, drawn: Dims, box: Dims): Point {
  const centre = { x: (box.w - drawn.w) / 2, y: (box.h - drawn.h) / 2 };
  if (spec.motion !== "perch") return centre;
  switch (spec.edge) {
    case "top":
      return { x: centre.x, y: 0 };
    case "bottom":
      return { x: centre.x, y: box.h - drawn.h };
    case "left":
      return { x: 0, y: centre.y };
    case "right":
      return { x: box.w - drawn.w, y: centre.y };
  }
}

/** One step of a once-motion's path: where, how big, how visible, at which fraction of the time. */
export interface PathStep {
  offset: number;
  x: number;
  y: number;
  scale: number;
  opacity: number;
}
export interface OncePath {
  durationMs: number;
  steps: PathStep[];
}

/** How visible a picture is at the fraction `t` of a once-motion: in over the first eighth, out over the last. */
function fade(t: number): number {
  return t < 0.12 ? t / 0.12 : t > 0.88 ? (1 - t) / 0.12 : 1;
}

/** How visible a flying picture is at `t`: in over the first eighth, then fully, to the end (it leaves past the clip, it does not fade). */
function fadeIn(t: number): number {
  return t < 0.12 ? t / 0.12 : 1;
}

/** How long a fly-across of `distance` pixels takes: at the speed of the reference crossing, held between the shortest and the longest. */
export function flyMs(distance: number): number {
  const even = (Math.abs(distance) * FLOAT_ONCE_MS["fly-across"]) / FLOAT_FLY_REF_PX;
  return Math.round(Math.min(Math.max(even, FLOAT_FLY_MIN_MS), FLOAT_FLY_MAX_MS));
}

/**
 * The path of a once-motion inside the region. Every step's box, grown by its scale about its centre, lies
 * inside the region: a fly-across and an arc go from one side to the other, a pop opens at a spot with room
 * for its biggest size. The picture fades in at the start. An arc and a pop fade out at the end.
 *
 * A fly-across is the exception at its far end: it travels on until the picture is wholly PAST the far edge of the region (its box
 * starts at the far edge when it flies right, and ends at the far edge when it flies left), and does not fade out; the float layer
 * clips to the region, so the picture leaves as a thing leaves a window. Its time is its path over one speed ({@link flyMs}), so a
 * longer path takes longer; the speed is the same from the start to the end.
 *
 * Without `from`, the side it starts from and its height come from the key. With `from`, the drawn box of
 * the stay picture the part names (the box where that picture is now, in the same coordinates as the
 * region), the motion starts at the picture's HAND: the FRONT edge (the right edge when it flies right, the
 * left edge when it flies left) at {@link FLOAT_FROM_HAND} of the picture's height from its top, and the
 * shot's CENTRE is on that point. It flies away from the picture: toward the farther of the two side edges
 * of the region. A fly-across keeps that height to the far side, an arc starts there and bends toward the
 * side with more room, a pop opens there.
 *
 * THE START MAY SIT OUTSIDE THE REGION. A perched picture stands on its landmark with no gap (in `reach`),
 * so the hand of a small pet and a big shot can put the shot's first box over the pet and the edge landmark
 * below it. That first step is exact, and it is invisible (the fade starts at zero). Every later step is
 * held inside the region, so over the fade-in (an eighth of the motion) the shot eases from the hand to the
 * nearest place inside it, and the path never crosses a landmark beyond the pet's own spot. When the hand
 * already lies inside the region (the usual case) the two are the same point and the flight is level.
 */
export function pathOf(opts: { motion: (typeof FLOAT_ONCE_MOTIONS)[number]; key: string; rev: number; dims: Dims; region: Box; from?: Box | undefined }): OncePath {
  const { motion, region, dims, from } = opts;
  const seed = `${opts.key}@${opts.rev}`;
  const spanX = Math.max(0, region.w - dims.w);
  const spanY = Math.max(0, region.h - dims.h);
  const clampX = (x: number): number => Math.min(Math.max(x, region.x), region.x + spanX);
  const clampY = (y: number): number => Math.min(Math.max(y, region.y), region.y + spanY);
  const leftToRight = from === undefined ? unit(seed, 7) < 0.5 : from.x + from.w / 2 <= region.x + region.w / 2;
  const hand: Point | undefined = from === undefined ? undefined : { x: leftToRight ? from.x + from.w : from.x, y: from.y + FLOAT_FROM_HAND * from.h };
  // The top left of the shot's box when its centre is on the hand, before it is held in the region.
  const rawX = hand === undefined ? undefined : hand.x - dims.w / 2;
  const rawY = hand === undefined ? undefined : hand.y - dims.h / 2;
  const x0 = rawX === undefined ? (leftToRight ? region.x : region.x + spanX) : clampX(rawX);
  // A fly-across ends wholly past the far edge: its box starts at the far edge (right) or ends there (left).
  const x1 = motion === "fly-across" ? (leftToRight ? region.x + region.w : region.x - dims.w) : leftToRight ? region.x + spanX : region.x;
  const xAt = (t: number): number => x0 + (x1 - x0) * t;
  /** The first step is the exact hand, the others are held in the region. */
  const exactStart = (steps: PathStep[]): PathStep[] =>
    steps.map((step, i) => (i === 0 && rawX !== undefined && rawY !== undefined ? { ...step, x: rawX, y: rawY } : step));
  const yFrom = rawY === undefined ? undefined : clampY(rawY);
  if (motion === "fly-across") {
    const y = yFrom ?? region.y + (0.15 + 0.7 * unit(seed, 8)) * spanY;
    // Linear in x from the first step to the last: one even speed, and the end is past the edge at full opacity.
    return { durationMs: flyMs(x1 - x0), steps: exactStart([0, 0.12, 1].map((t) => ({ offset: t, x: xAt(t), y, scale: 1, opacity: fadeIn(t) }))) };
  }
  const durationMs = FLOAT_ONCE_MS[motion];
  if (motion === "arc") {
    const base = yFrom ?? region.y + spanY;
    const roomUp = base - region.y;
    const roomDown = region.y + spanY - base;
    const up = from === undefined || roomUp >= roomDown;
    const rise = Math.min(up ? roomUp : roomDown, 0.55 * region.h);
    const steps = Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      return { offset: t, x: xAt(t), y: base + (up ? -1 : 1) * 4 * rise * t * (1 - t), scale: 1, opacity: fade(t) };
    });
    return { durationMs, steps: exactStart(steps) };
  }
  const grown = { w: dims.w * FLOAT_POP_SCALE, h: dims.h * FLOAT_POP_SCALE };
  const spot =
    hand === undefined
      ? fraction(region, grown, 0.1 + 0.8 * unit(seed, 9), 0.1 + 0.8 * unit(seed, 10))
      : {
          x: Math.min(Math.max(hand.x - grown.w / 2, region.x), region.x + Math.max(0, region.w - grown.w)),
          y: Math.min(Math.max(hand.y - grown.h / 2, region.y), region.y + Math.max(0, region.h - grown.h)),
        };
  const at = { x: spot.x + (grown.w - dims.w) / 2, y: spot.y + (grown.h - dims.h) / 2 };
  const scales: [number, number, number][] = [
    [0, 0.4, 0],
    [0.25, FLOAT_POP_SCALE, 1],
    [0.6, 1, 1],
    [1, 1, 0],
  ];
  return { durationMs, steps: exactStart(scales.map(([offset, scale, opacity]) => ({ offset, x: at.x, y: at.y, scale, opacity }))) };
}

/** The box a path step covers, with its scale about its centre. */
export function stepBox(step: PathStep, dims: Dims): Box {
  const w = dims.w * step.scale;
  const h = dims.h * step.scale;
  const centre = { x: step.x + dims.w / 2, y: step.y + dims.h / 2 };
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h };
}

// ── The limits that need a clock ─────────────────────────────────────────────────────────────

/** What the queue holds of a shot: its trick, and what it needs to play. */
export interface Shot {
  trick: string;
}

/**
 * The once-shots of the screen: at most one per trick per {@link FLOAT_ONCE_EVERY_MS}, one on screen at a
 * time. A shot that comes while one plays waits, one place deep; the next that comes with one waiting is
 * dropped. The rate is counted from the start of a shot, and checked again when a waiting one would start.
 */
export class OnceQueue<T extends Shot> {
  playing: T | null = null;
  waiting: T | null = null;
  private readonly started = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private limited(trick: string): boolean {
    const last = this.started.get(trick);
    return last !== undefined && this.now() - last < FLOAT_ONCE_EVERY_MS;
  }

  private start(shot: T): void {
    this.playing = shot;
    this.started.set(shot.trick, this.now());
  }

  /** The shot really starts now (it waited for its pet): the rate counts from here. */
  began(trick: string): void {
    if (this.playing?.trick === trick) this.started.set(trick, this.now());
  }

  /** A shot arrives: `play` it now, `wait` for the one on screen, or `drop` it. */
  offer(shot: T): "play" | "wait" | "drop" {
    if (this.limited(shot.trick)) return "drop";
    if (this.playing === null) {
      this.start(shot);
      return "play";
    }
    if (this.waiting !== null) return "drop";
    this.waiting = shot;
    return "wait";
  }

  /** The shot on screen is over. The waiting one starts, unless its trick is limited by now; it is then returned, or null. */
  finish(): T | null {
    this.playing = null;
    const next = this.waiting;
    this.waiting = null;
    if (next === null || this.limited(next.trick)) return null;
    this.start(next);
    return next;
  }

  /**
   * A shot the layer was away from comes back: it plays again from its start, whatever the rate says (it was counted when it
   * first began, and counts again from where it really starts). False when another shot is on screen already.
   */
  resume(shot: T): boolean {
    if (this.playing !== null) return false;
    this.playing = shot;
    return true;
  }

  /** Everything stops: a sheet opened, the screen changed. The rate stays, a shot that was cut counts as played. */
  cancel(): void {
    this.playing = null;
    this.waiting = null;
  }
}
