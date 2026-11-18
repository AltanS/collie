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
// rest dropped (`OnceQueue`), a once-motion of at most three seconds (`FLOAT_ONCE_MS`), a wander at most
// every ten seconds (`FLOAT_WANDER_EVERY_MS`). Motion uses transform and opacity only.

import {
  CHIP_STATES,
  FLOAT_EDGES,
  FLOAT_FPS_MAX,
  FLOAT_FRAMES_MAX,
  FLOAT_ONCE_MOTIONS,
  FLOAT_OPENS,
  FLOAT_SIZES,
  FLOAT_STAY_MOTIONS,
  isImageSrc,
  partKey,
  type ChipState,
  type FloatEdge,
  type FloatMode,
  type FloatMotion,
  type FloatOpens,
  type FloatSize,
  type WireTrickPart,
} from "./schema";
import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "../json";

// ── The numbers ──────────────────────────────────────────────────────────────────────────────

/** The two sizes of a picture, in CSS pixels. */
export const FLOAT_SIZE_PX = { s: 32, m: 48 } as const satisfies Record<FloatSize, number>;
/** The tap target of a parked picture that opens a page (DESIGN.md: 44 px). */
export const FLOAT_TAP_PX = 44;
/** The gap kept around every landmark, in pixels. */
export const FLOAT_GAP_PX = 4;
/** The free area under which nothing is drawn: a stay picture hides and a once-shot is skipped. */
export const FLOAT_MIN_REGION = { w: 120, h: 96 } as const;
/** How long each once-motion plays. None is over three seconds. */
export const FLOAT_ONCE_MS = { "fly-across": 2400, arc: 2800, pop: 1600 } as const satisfies Record<(typeof FLOAT_ONCE_MOTIONS)[number], number>;
/** The most a once-motion may last, the bound the table above is held to. */
export const FLOAT_ONCE_MAX_MS = 3000;
/** A trick's once-shots start at least this far apart. */
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
 * `gap` apart), or null when it is smaller than {@link FLOAT_MIN_REGION}.
 */
export function safeRegion(opts: { viewport: Box; insets: Insets; landmarks: readonly Box[]; gap?: number }): Box | null {
  const gap = opts.gap ?? FLOAT_GAP_PX;
  const area = visibleBox(opts.viewport, opts.insets);
  const free = freeArea(
    area,
    opts.landmarks.map((box) => inflate(box, gap)),
  );
  if (free === null || free.w < FLOAT_MIN_REGION.w || free.h < FLOAT_MIN_REGION.h) return null;
  return { x: Math.round(free.x), y: Math.round(free.y), w: Math.floor(free.w), h: Math.floor(free.h) };
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
  rev: number;
  mode: FloatMode;
  motion: FloatMotion;
  edge: FloatEdge;
  src: string;
  frames: number;
  fps: number;
  size: FloatSize;
  mood: ChipState;
  opens: FloatOpens | undefined;
  /** The part is the last good one of a run that failed. */
  stale: boolean;
  part: WireTrickPart;
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
  const fps = sprite.fps === undefined ? 6 : whole(sprite.fps, 1, FLOAT_FPS_MAX);
  const size = sprite.size === undefined ? "s" : inList(FLOAT_SIZES, asJsonString(sprite.size));
  if (frames === undefined || fps === undefined || size === undefined) return null;
  const mood = value.mood === undefined ? "idle" : inList(CHIP_STATES, asJsonString(value.mood));
  const edge = value.edge === undefined ? "bottom" : inList(FLOAT_EDGES, asJsonString(value.edge));
  if (mood === undefined || edge === undefined) return null;
  const opens = value.opens === undefined ? undefined : inList(FLOAT_OPENS, asJsonString(value.opens));
  if (value.opens !== undefined && (opens === undefined || mode === "once" || motion === "wander")) return null;
  return {
    key: partKey(part),
    trick: `${part.host}/${part.trick}`,
    host: part.host,
    trickId: part.trick,
    rev: part.rev,
    mode,
    motion,
    edge,
    src,
    frames,
    fps,
    size,
    mood,
    opens,
    stale: part.stale === true,
    part,
  };
}

/** The row of a sprite sheet a mood draws: its place in the chip states. */
export function moodRow(mood: ChipState): number {
  return CHIP_STATES.indexOf(mood);
}

/** The rows a sheet really has, from its size and its `frames`: square frames side by side. At least one. */
export function sheetRows(width: number, height: number, frames: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.max(1, Math.floor(height / (width / frames) + 0.01));
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

/** The side of the box a picture takes: its size, or the tap target when a tap may open a page. */
export function boxSide(spec: Pick<FloatSpec, "size" | "opens">): number {
  const side = FLOAT_SIZE_PX[spec.size];
  return spec.opens === undefined ? side : Math.max(side, FLOAT_TAP_PX);
}

/** The position, top left, of a box of `side` at the fraction `along` of the way along the room that is left. */
function along(region: Box, side: number, fx: number, fy: number) {
  return { x: region.x + fx * Math.max(0, region.w - side), y: region.y + fy * Math.max(0, region.h - side) };
}

/**
 * Where a stay picture rests, top left of its box: on its edge for `perch` (the place along the edge is
 * the part's own, fixed by its key), at a fixed spot a little above the middle for `idle`, and at spot
 * number `step` for `wander` (each spot from the key and the step, inside the area). Always inside it.
 */
export function restOf(spec: Pick<FloatSpec, "key" | "motion" | "edge" | "size" | "opens">, region: Box, step = 0): { x: number; y: number } {
  const side = boxSide(spec);
  const f = 0.1 + 0.8 * unit(spec.key, 1);
  if (spec.motion === "perch") {
    switch (spec.edge) {
      case "top":
        return along(region, side, f, 0);
      case "bottom":
        return along(region, side, f, 1);
      case "left":
        return along(region, side, 0, f);
      case "right":
        return along(region, side, 1, f);
    }
  }
  if (spec.motion === "wander") return along(region, side, unit(spec.key, 100 + 2 * step), unit(spec.key, 101 + 2 * step));
  // idle: held in by the bob on each side
  const held = { x: region.x, y: region.y + FLOAT_IDLE_BOB_PX, w: region.w, h: Math.max(0, region.h - 2 * FLOAT_IDLE_BOB_PX) };
  return along(held, side, f, 0.55);
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

/**
 * The path of a once-motion inside the region. Every step's box, grown by its scale about its centre, lies
 * inside the region: a fly-across and an arc go from one side to the other (the side from the key), a pop
 * opens at a spot with room for its biggest size. The picture fades in at the start and out at the end.
 */
export function pathOf(opts: { motion: (typeof FLOAT_ONCE_MOTIONS)[number]; key: string; rev: number; side: number; region: Box }): OncePath {
  const { motion, region, side } = opts;
  const seed = `${opts.key}@${opts.rev}`;
  const durationMs = FLOAT_ONCE_MS[motion];
  const leftToRight = unit(seed, 7) < 0.5;
  const span = Math.max(0, region.w - side);
  const xAt = (t: number): number => region.x + (leftToRight ? t : 1 - t) * span;
  if (motion === "fly-across") {
    const y = region.y + (0.15 + 0.7 * unit(seed, 8)) * Math.max(0, region.h - side);
    return { durationMs, steps: [0, 0.12, 0.88, 1].map((t) => ({ offset: t, x: xAt(t), y, scale: 1, opacity: fade(t) })) };
  }
  if (motion === "arc") {
    const floor = region.y + Math.max(0, region.h - side);
    const rise = Math.min(Math.max(0, region.h - side), 0.55 * region.h);
    const steps = Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      return { offset: t, x: xAt(t), y: floor - 4 * rise * t * (1 - t), scale: 1, opacity: fade(t) };
    });
    return { durationMs, steps };
  }
  const grown = side * FLOAT_POP_SCALE;
  const spot = along(region, grown, 0.1 + 0.8 * unit(seed, 9), 0.1 + 0.8 * unit(seed, 10));
  const lift = (grown - side) / 2;
  const at = { x: spot.x + lift, y: spot.y + lift };
  const scales: [number, number, number][] = [
    [0, 0.4, 0],
    [0.25, FLOAT_POP_SCALE, 1],
    [0.6, 1, 1],
    [1, 1, 0],
  ];
  return { durationMs, steps: scales.map(([offset, scale, opacity]) => ({ offset, x: at.x, y: at.y, scale, opacity })) };
}

/** The box a path step covers, with its scale about its centre. */
export function stepBox(step: PathStep, side: number): Box {
  const grown = side * step.scale;
  const centre = { x: step.x + side / 2, y: step.y + side / 2 };
  return { x: centre.x - grown / 2, y: centre.y - grown / 2, w: grown, h: grown };
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

  /** Everything stops: a sheet opened, the screen changed. The rate stays, a shot that was cut counts as played. */
  cancel(): void {
    this.playing = null;
    this.waiting = null;
  }
}
