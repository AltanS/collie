// Pane navigation by gesture (M70 spec 03, ADR 0121): pure functions and the two state machines, no
// React and no DOM. The hook (hooks/use-pane-nav-gesture.ts) only turns touches into events; every
// decision (a threshold, a step, how a gesture ended) is made here, so every transition has a test.
//
// THE AXES ARE NIRI'S. Left and right are the previous and next pane in the current space, in the
// switcher's and the sidebar's order. Up and down are the previous and next space, in the order of the
// sidebar's space sections. A direction is where the cursor moves on the map, never where content
// slides. The ends clamp: there is no wrap.
//
// TWO METHODS, ONE MAP.
//   chord (Two fingers): idle -> holding -> armed -> stepping -> commit | cancel
//     Hold ONE finger still on the reading area. A hold alone arms NOTHING: no overlay, no buzz, and
//     the browser keeps its long-press selection and menu (release counsel, 2026-10-25). The mode arms
//     only when a SECOND finger lands while the first has been down and still for 300 ms. The second
//     finger then swipes, one step per swipe, and may lift and swipe again. Lifting the first finger
//     after the second has lifted commits, with at least one step. Every other end is a cancel: a
//     second finger before 300 ms (a pinch), the first finger lifting while the second is still down, a
//     third finger, a drift past 24 px, a hold that starts in a system back-gesture edge zone, and the
//     browser's own cancel.
//   stick (Joystick): idle -> holding -> armed -> stepping -> commit | cancel, and from holding the
//     exits "tap" (nothing) and "flick" (a quick drag up: the switcher sheet).
//     Hold the handle above the belt; the same finger then drags like a joystick.
//
// Ported from the playground's approved prototype (playground/sections/wide-layout-model.ts on
// feat/wide-layout), with the arm moved to the second finger and the pinch rule changed: in the app a
// second finger within the hold is a pinch and never arms, so the browser's pinch zoom keeps working
// (ADR 0121).

// ── The map ─────────────────────────────────────────────────────────────────────────────────────

/** One space on the map: its panes' keys in the sidebar's order, and the pane the cursor is on there. */
export interface NavSpaceView {
  readonly panes: readonly string[];
  readonly focus: number;
}

/** Every space as a row of panes, and the row the cursor is in. */
export interface NavLayout {
  readonly spaces: readonly NavSpaceView[];
  readonly space: number;
}

/** What the map is built from: each space's pane keys, and the pane a move into that space lands on. */
export interface NavSpaceDef {
  readonly panes: readonly string[];
  /** The space header's landing (lib/wide-layout.ts `landingOf`), or null for the first pane. */
  readonly landing: string | null;
}

/** The map with the cursor on `here`, or null when `here` is in no space (nothing to move from). */
export function navLayoutOf(defs: readonly NavSpaceDef[], here: string): NavLayout | null {
  const space = defs.findIndex((d) => d.panes.includes(here));
  if (space < 0) return null;
  return {
    space,
    spaces: defs.map((d, i) => {
      const at = i === space ? d.panes.indexOf(here) : d.landing === null ? 0 : d.panes.indexOf(d.landing);
      return { panes: d.panes, focus: Math.max(at, 0) };
    }),
  };
}

/** The key of the pane the cursor is on, or null on an empty space. */
export function keyAt(layout: NavLayout): string | null {
  const view = layout.spaces[layout.space];
  return view?.panes[view.focus] ?? null;
}

export interface Cell {
  readonly space: number;
  readonly pane: number;
}

export function cellOf(layout: NavLayout): Cell {
  return { space: layout.space, pane: layout.spaces[layout.space]?.focus ?? 0 };
}

/** True when two layouts point at the same pane in the same space. */
export function sameCell(a: NavLayout, b: NavLayout): boolean {
  return a.space === b.space && a.spaces[a.space]?.focus === b.spaces[b.space]?.focus;
}

/** One step: `pane` along the current space's row, `space` to the previous (-1) or next (+1) space. */
export type MoveAction = { readonly t: "pane"; readonly delta: -1 | 1 } | { readonly t: "space"; readonly delta: -1 | 1 };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** The layout after one step. At an end it is the same layout: no wrap. A space keeps its own focus. */
export function moveBy(layout: NavLayout, action: MoveAction): NavLayout {
  if (action.t === "space") {
    const to = layout.space + action.delta;
    return to < 0 || to >= layout.spaces.length ? layout : { ...layout, space: to };
  }
  const view = layout.spaces[layout.space];
  if (view === undefined) return layout;
  const to = view.focus + action.delta;
  if (to < 0 || to >= view.panes.length) return layout;
  return { ...layout, spaces: layout.spaces.map((s, i) => (i === layout.space ? { ...s, focus: to } : s)) };
}

// ── Directions ──────────────────────────────────────────────────────────────────────────────────

export type Direction = "left" | "right" | "up" | "down";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The step a push in one direction means. The dominant axis wins; right is the next pane, down the next space. */
export function cursorAction(dx: number, dy: number): MoveAction {
  if (Math.abs(dx) >= Math.abs(dy)) return { t: "pane", delta: dx < 0 ? -1 : 1 };
  return { t: "space", delta: dy < 0 ? -1 : 1 };
}

export function directionOf(a: MoveAction): Direction {
  if (a.t === "pane") return a.delta > 0 ? "right" : "left";
  return a.delta > 0 ? "down" : "up";
}

/** The direction a travel points in once it has gone `min` px, else null. The dominant axis wins. */
export function activeDirection(dx: number, dy: number, min: number): Direction | null {
  if (Math.hypot(dx, dy) < min) return null;
  return directionOf(cursorAction(dx, dy));
}

/** A centre moved just enough that a box reaching `half` px each way stays inside `bounds`. */
export function fitCenter(center: Point, bounds: { readonly w: number; readonly h: number }, half: Point): Point {
  const fit = (v: number, size: number, h: number) => (size <= 2 * h ? size / 2 : clamp(v, h, size - h));
  return { x: fit(center.x, bounds.w, half.x), y: fit(center.y, bounds.h, half.y) };
}

// ── Tuning ──────────────────────────────────────────────────────────────────────────────────────

export interface Tuning {
  /** How long the first finger holds nearly still before a second finger may arm the mode (chord),
   *  or before the hold arms it (stick), ms. */
  readonly holdMs: number;
  /** Travel for one step, CSS px. */
  readonly stepPx: number;
  /** How far the first finger may drift before the hold gives up. Once armed it may drift freely. */
  readonly driftPx: number;
  /** Chord: the first finger counts as still below this speed over the last {@link FLICK_WINDOW_MS},
   *  px per ms. A faster finger is scrolling, and the hold's clock starts again from zero. */
  readonly stillPxPerMs: number;
  /** Chord: a hold that starts this close to the left or right screen edge never arms, px. Those are
   *  the system back-gesture zones. */
  readonly edgePx: number;
  /** Chord: a flick steps when faster than this over the last {@link FLICK_WINDOW_MS}, px per ms. */
  readonly flickPxPerMs: number;
  /** Chord: and at least this far from the anchor, px. */
  readonly flickMinPx: number;
  /** Chord: a swipe within this many degrees of an axis counts its whole length. */
  readonly coneDeg: number;
  /** Chord: a swipe that travels this many thresholds is a step per threshold. */
  readonly multiAt: number;
}

export type GestureKind = "chord" | "stick";

export const DEFAULT_TUNING = {
  chord: { holdMs: 300, stepPx: 40, driftPx: 24, stillPxPerMs: 0.15, edgePx: 24, flickPxPerMs: 0.4, flickMinPx: 15, coneDeg: 40, multiAt: 2 },
  stick: { holdMs: 400, stepPx: 48, driftPx: 10, stillPxPerMs: 0.15, edgePx: 0, flickPxPerMs: 0.4, flickMinPx: 15, coneDeg: 40, multiAt: 2 },
} as const satisfies Record<GestureKind, Tuning>;

/** A quick drag up on the joystick handle opens the switcher from this far, CSS px. */
export const FLICK_UP_PX = 40;

/** How long a window of samples the flick speed is read over, ms. */
export const FLICK_WINDOW_MS = 80;

// ── The second finger (chord) ───────────────────────────────────────────────────────────────────

/** One sample of the second finger, for its speed. */
export interface Sample {
  readonly x: number;
  readonly y: number;
  readonly ms: number;
}

/** The speed over the samples inside the last {@link FLICK_WINDOW_MS}, px per ms. 0 with fewer than two. */
export function speedOf(samples: readonly Sample[], now: number): number {
  const recent = samples.filter((p) => now - p.ms <= FLICK_WINDOW_MS);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (first === undefined || last === undefined || last.ms <= first.ms) return 0;
  return Math.hypot(last.x - first.x, last.y - first.y) / (last.ms - first.ms);
}

export interface ChordSwipe {
  /** The step to take, or null while the second finger has not gone far enough. */
  readonly action: MoveAction | null;
  /** How many of that step: one, or more when the travel is at least `multiAt` thresholds. */
  readonly count: number;
  /** Where the next swipe is measured from: the same anchor until a step is taken, then moved on. */
  readonly anchor: Point;
  readonly by: "travel" | "flick" | null;
}

/**
 * The second finger's travel from its anchor. A step is EITHER `stepPx` of travel OR a flick (faster
 * than `flickPxPerMs` over the last 80 ms, and at least `flickMinPx` from the anchor). The direction is
 * the dominant axis, always: a swipe inside the `coneDeg` cone of that axis counts its whole length,
 * and a more diagonal one counts its larger axis, so it is never ignored. One swipe is one step unless
 * it travels `multiAt` times the threshold; then it is a step per threshold. The anchor moves on by
 * the travel the steps used, so a long drag steps again every `stepPx` and the remainder is kept.
 */
export function chordSwipe(anchor: Point, point: Point, tune: Tuning, samples: readonly Sample[] = [], now = 0): ChordSwipe {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const major = Math.max(Math.abs(dx), Math.abs(dy));
  const minor = Math.min(Math.abs(dx), Math.abs(dy));
  if (major === 0) return { action: null, count: 0, anchor, by: null };
  const off = (Math.atan2(minor, major) * 180) / Math.PI;
  const travel = off <= tune.coneDeg ? Math.hypot(dx, dy) : major;
  const action = cursorAction(dx, dy);
  if (travel >= tune.stepPx) {
    const count = travel >= tune.multiAt * tune.stepPx ? Math.floor(travel / tune.stepPx) : 1;
    const k = Math.min((count * tune.stepPx) / Math.hypot(dx, dy), 1);
    return { action, count, anchor: { x: anchor.x + dx * k, y: anchor.y + dy * k }, by: "travel" };
  }
  if (travel >= tune.flickMinPx && speedOf(samples, now) >= tune.flickPxPerMs) return { action, count: 1, anchor: point, by: "flick" };
  return { action: null, count: 0, anchor, by: null };
}

// ── The joystick (stick) ────────────────────────────────────────────────────────────────────────

export interface JoystickTarget {
  /** The layout the finger points at, measured from the layout when the mode armed. */
  readonly layout: NavLayout;
  /** Which axis the push is on, or null inside the dead zone. */
  readonly axis: "pane" | "space" | null;
  /** Steps along that axis, signed. Not clamped, so a push past the end reads honestly. */
  readonly steps: number;
}

/**
 * The thumb as a joystick. The target is always computed from where the mode armed, never
 * accumulated, so coming back reverses and releasing at the start is no move. `px` of travel along
 * the dominant axis is one step, and each further `px` is another. The two axes never mix.
 */
export function joystickTarget(origin: NavLayout, dx: number, dy: number, px: number): JoystickTarget {
  const onPane = Math.abs(dx) >= Math.abs(dy);
  const steps = Math.trunc((onPane ? dx : dy) / px);
  if (steps === 0) return { layout: origin, axis: null, steps: 0 };
  if (!onPane) return { layout: { ...origin, space: clamp(origin.space + steps, 0, origin.spaces.length - 1) }, axis: "space", steps };
  const view = origin.spaces[origin.space];
  if (view === undefined) return { layout: origin, axis: "pane", steps };
  const focus = clamp(view.focus + steps, 0, Math.max(view.panes.length - 1, 0));
  return { layout: { ...origin, spaces: origin.spaces.map((s, i) => (i === origin.space ? { ...s, focus } : s)) }, axis: "pane", steps };
}

// ── The state machine ───────────────────────────────────────────────────────────────────────────

export type Phase = "idle" | "holding" | "armed" | "stepping" | "commit" | "cancel" | "tap" | "flick";

/** True for the phases a gesture ends in. */
export function isTerminal(phase: Phase): boolean {
  return phase === "commit" || phase === "cancel" || phase === "tap" || phase === "flick";
}

/** True while the mode is armed: the overlay shows, and the hook holds the page off. */
export function isArmed(phase: Phase): boolean {
  return phase === "armed" || phase === "stepping";
}

export interface GestureState {
  readonly kind: GestureKind;
  readonly phase: Phase;
  /** Where the first finger landed, when, and where it is. */
  readonly start: Point | null;
  readonly downMs: number;
  readonly at: Point | null;
  /** Chord: since when the first finger has been still. The landing, or the last move faster than
   *  `stillPxPerMs`: a hold only starts from a finger that is still. */
  readonly stillMs: number;
  /** Chord: the first finger's recent positions, for its speed. */
  readonly firstSamples: readonly Sample[];
  /** Chord: where the second finger is, and where its next step is measured from. */
  readonly second: Point | null;
  readonly anchor: Point | null;
  /** Chord: where the direction pad sits. Set where the second finger first lands in this gesture and
   *  never moved after, like a game's fixed on-screen pad. */
  readonly padAt: Point | null;
  /** Chord: the second finger's recent positions, for its speed. */
  readonly samples: readonly Sample[];
  /** The travel the next step is measured from: the first finger's from its start (stick), the
   *  second finger's from its anchor (chord). */
  readonly dx: number;
  readonly dy: number;
  /** Steps taken. Signed for the stick (along its dominant axis), a count for the chord. */
  readonly steps: number;
  /** The direction of the last step (chord), or the one the stick points in now. */
  readonly lastDir: Direction | null;
  readonly origin: NavLayout | null;
  readonly target: NavLayout | null;
  /** Stick, while holding: the finger moved before the hold finished, so it never arms. */
  readonly moved: boolean;
  /** Why the gesture ended, in plain words, for the tests and a debugger. */
  readonly endedBy: string | null;
}

export function idleGesture(kind: GestureKind): GestureState {
  return {
    kind,
    phase: "idle",
    start: null,
    downMs: 0,
    at: null,
    stillMs: 0,
    firstSamples: [],
    second: null,
    anchor: null,
    padAt: null,
    samples: [],
    dx: 0,
    dy: 0,
    steps: 0,
    lastDir: null,
    origin: null,
    target: null,
    moved: false,
    endedBy: null,
  };
}

export type GestureEvent =
  /** The first finger lands. `layout` is the map the gesture starts from. `width` is the viewport's
   *  width, for the chord's edge zones; absent, no zone applies. */
  | { t: "down"; at: Point; layout: NavLayout; ms: number; width?: number }
  /** The first finger moves. */
  | { t: "move"; at: Point; ms: number }
  /** The hold timer ran out. The stick only: the chord arms on the second finger. */
  | { t: "hold-done" }
  /** Another finger lands while the first is down: the second, or (chord) a third, which cancels. */
  | { t: "second-down"; at: Point; ms: number }
  | { t: "second-move"; at: Point; ms: number }
  | { t: "second-up" }
  /** The first finger lifts. */
  | { t: "up"; at: Point; ms: number }
  /** The browser took the touch away, or the view went away. */
  | { t: "cancel"; why: string }
  /** The finished gesture has been acted on: back to idle. */
  | { t: "settle" };

function finish(s: GestureState, phase: Phase, endedBy: string): GestureState {
  return { ...s, phase, endedBy, second: null, anchor: null, samples: [] };
}

function begin(kind: GestureKind, e: Extract<GestureEvent, { t: "down" }>, tune: Tuning): GestureState {
  const s: GestureState = {
    ...idleGesture(kind),
    phase: "holding",
    start: e.at,
    downMs: e.ms,
    at: e.at,
    stillMs: e.ms,
    firstSamples: [{ x: e.at.x, y: e.at.y, ms: e.ms }],
    origin: e.layout,
    target: e.layout,
  };
  // The system's back gesture lives at the left and right edges: a hold that starts there is not ours.
  const inEdge = e.width !== undefined && tune.edgePx > 0 && (e.at.x < tune.edgePx || e.at.x > e.width - tune.edgePx);
  return kind === "chord" && inEdge ? finish(s, "cancel", "the hold started in a system back-gesture edge zone") : s;
}

/** The pure transition. An event that means nothing in the current phase returns the state unchanged. */
export function reduceGesture(s: GestureState, e: GestureEvent, tune: Tuning): GestureState {
  if (e.t === "settle") return isTerminal(s.phase) ? { ...s, phase: "idle", dx: 0, dy: 0 } : s;
  if (e.t === "down") return s.phase === "idle" || isTerminal(s.phase) ? begin(s.kind, e, tune) : s;
  if (s.phase === "idle" || isTerminal(s.phase)) return s;
  if (e.t === "cancel") return finish(s, "cancel", e.why);
  return s.kind === "chord" ? reduceChord(s, e, tune) : reduceStick(s, e, tune);
}

/** The second finger's samples with the new one, keeping only the last window. */
function sampled(samples: readonly Sample[], p: Point, ms: number): readonly Sample[] {
  return [...samples.filter((q) => ms - q.ms <= FLICK_WINDOW_MS), { x: p.x, y: p.y, ms }];
}

function reduceChord(s: GestureState, e: GestureEvent, tune: Tuning): GestureState {
  const { start, target } = s;
  if (start === null || target === null) return s;
  if (s.phase === "holding") {
    if (e.t === "move") {
      const dx = e.at.x - start.x;
      const dy = e.at.y - start.y;
      const firstSamples = sampled(s.firstSamples, e.at, e.ms);
      // A finger that moves fast is scrolling: the hold only counts from when it is still again.
      const stillMs = speedOf(firstSamples, e.ms) > tune.stillPxPerMs ? e.ms : s.stillMs;
      const next = { ...s, at: e.at, dx, dy, firstSamples, stillMs };
      return Math.hypot(dx, dy) > tune.driftPx ? finish(next, "cancel", "the first finger drifted past the hold's limit") : next;
    }
    // THE ARM. A second finger after 300 ms of a still first finger arms the mode, and the second
    // finger is the one that swipes. Before that it is a pinch: the browser keeps it.
    if (e.t === "second-down") {
      if (e.ms - s.stillMs < tune.holdMs) return finish(s, "cancel", "a second finger before the hold is a pinch");
      return { ...s, phase: "armed", second: e.at, anchor: e.at, padAt: e.at, dx: 0, dy: 0, samples: [{ x: e.at.x, y: e.at.y, ms: e.ms }] };
    }
    // A lone hold, however long, is the browser's: its lift ends the gesture with nothing done.
    if (e.t === "up") return finish(s, "cancel", "the first finger lifted with no second finger");
    return s;
  }
  // armed or stepping: the first finger only has to stay down.
  if (e.t === "move") return { ...s, at: e.at };
  if (e.t === "second-down") {
    if (s.second !== null) return finish(s, "cancel", "a third finger landed");
    return { ...s, second: e.at, anchor: e.at, padAt: s.padAt ?? e.at, dx: 0, dy: 0, samples: [{ x: e.at.x, y: e.at.y, ms: e.ms }] };
  }
  if (e.t === "second-up") return { ...s, second: null, anchor: null, dx: 0, dy: 0, samples: [] };
  if (e.t === "second-move") {
    if (s.anchor === null) return s;
    const samples = sampled(s.samples, e.at, e.ms);
    const r = chordSwipe(s.anchor, e.at, tune, samples, e.ms);
    if (r.action === null) return { ...s, second: e.at, samples, dx: e.at.x - s.anchor.x, dy: e.at.y - s.anchor.y };
    let next = target;
    for (let i = 0; i < r.count; i += 1) next = moveBy(next, r.action);
    return {
      ...s,
      phase: "stepping",
      second: e.at,
      anchor: r.anchor,
      // After a flick the speed is read afresh, so one flick is one step.
      samples: r.by === "flick" ? [{ x: e.at.x, y: e.at.y, ms: e.ms }] : samples,
      dx: e.at.x - r.anchor.x,
      dy: e.at.y - r.anchor.y,
      steps: s.steps + r.count,
      lastDir: directionOf(r.action),
      target: next,
    };
  }
  if (e.t === "up") {
    // Mid-swipe: the person let go of the hold, not of the swipe. Nothing moves.
    if (s.second !== null) return finish(s, "cancel", "the first finger lifted while the second was still down");
    return s.steps > 0
      ? finish(s, "commit", `the first finger lifted after ${s.steps} ${s.steps === 1 ? "step" : "steps"}`)
      : finish(s, "cancel", "the first finger lifted with no swipe");
  }
  return s;
}

function reduceStick(s: GestureState, e: GestureEvent, tune: Tuning): GestureState {
  const { start, origin } = s;
  if (start === null || origin === null) return s;
  if (s.phase === "holding") {
    if (e.t === "move") {
      const dx = e.at.x - start.x;
      const dy = e.at.y - start.y;
      return { ...s, at: e.at, dx, dy, moved: s.moved || Math.hypot(dx, dy) > tune.driftPx };
    }
    if (e.t === "hold-done") return s.moved ? s : { ...s, phase: "armed", dx: 0, dy: 0 };
    if (e.t === "up") {
      if (!s.moved) return finish(s, "tap", "released before the hold finished, a tap");
      return start.y - e.at.y > FLICK_UP_PX ? finish(s, "flick", "a quick drag up opens the switcher") : finish(s, "cancel", "moved before the hold finished");
    }
    return s;
  }
  // armed or stepping
  if (e.t === "move") {
    const dx = e.at.x - start.x;
    const dy = e.at.y - start.y;
    const j = joystickTarget(origin, dx, dy, tune.stepPx);
    const lastDir = j.steps === 0 ? null : directionOf(j.axis === "space" ? { t: "space", delta: j.steps < 0 ? -1 : 1 } : { t: "pane", delta: j.steps < 0 ? -1 : 1 });
    return { ...s, at: e.at, dx, dy, target: j.layout, steps: j.steps, lastDir, phase: j.steps === 0 ? "armed" : "stepping" };
  }
  if (e.t === "up") return sameCell(s.target ?? origin, origin) ? finish(s, "cancel", "released back at the start") : finish(s, "commit", "released on another cell");
  return s;
}

// ── The lifts that must not click (chord) ───────────────────────────────────────────────────────

/** A click this soon after an armed gesture's lift is the browser's own click for that lift, ms. */
export const CLICK_SWALLOW_MS = 400;
/** And this close to where the finger lifted, px. */
export const CLICK_SLOP_PX = 32;

/** Where and when a finger of an armed touch sequence lifted. */
export interface Lift {
  readonly x: number;
  readonly y: number;
  readonly ms: number;
}

/**
 * Whether a click at `at` and `ms` is the click a browser makes of an armed gesture's lift: within
 * {@link CLICK_SWALLOW_MS} after a lift and {@link CLICK_SLOP_PX} of where it lifted. The hook swallows
 * it in the capture phase, so the belt pill, the Allow button or the link under the finger never fires.
 */
export function swallowsClick(lifts: readonly Lift[], at: Point, ms: number): boolean {
  return lifts.some((l) => ms >= l.ms && ms - l.ms <= CLICK_SWALLOW_MS && Math.hypot(at.x - l.x, at.y - l.y) <= CLICK_SLOP_PX);
}
