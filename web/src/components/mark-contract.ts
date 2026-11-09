// generated: sha256=a733ec61696b4b2154c966b26ff0f657ff750b1183b28fc58755c8d0c35dd48d from=collie-brand/src/mark-contract.ts@e3dcec57368c
// COPIED WHOLE from collie-brand/src/mark-contract.ts. Edit it there, in collie-brand, and nowhere else.
/**
 * THE MARK CONTRACT. One file that every Collie brand mark implements, the Collie mark included.
 *
 * HAND-WRITTEN, here, in collie-brand. The generators (`scripts/logo-ship.ts` for the Collie mark,
 * `scripts/logo-ship-theme.ts` for the theme marks) emit components that import THIS file and do
 * nothing a mark could do differently: every mark is its drawing (stylesheet, bodies, view boxes,
 * the colours of its two looks) plus one call to `useMark`. `logo-ship.ts` seals a copy into
 * `assets/mark-contract.ts`, and a consumer copies that file whole, beside the marks, exactly as it
 * copies a mark.
 *
 * WHY THE HOST NEEDS IT. Collie started using the mark for loading states: a spin round on every
 * status, a steady turn while busy, a recolour while the app updates and for one turn when the link
 * returns, a dimmed mark while offline. Before this file the host did that by reaching INTO the
 * Collie mark: a stylesheet that named its bead parts, and a filter over `getAnimations()` keyed on
 * its keyframe names. With more than one mark that breaks quietly. Here the host says WHAT (a state,
 * bead colours, a turn) and each mark decides HOW, in its own idiom.
 *
 * WHAT IS PUBLIC, all of it named here:
 *   props        size, weight, paper, title, className, state, beads, turn, ref (and `loading`,
 *                deprecated, an alias for state="loading")
 *   variables    --mark-turn, --mark-bead, --mark-bead-<i>, --mark-accent-1, --mark-accent-2,
 *                --mark-ink, --mark-paper, read on the mark's root or inherited from an ancestor
 *   attributes   data-mark="<id>" and data-state="<state>" on the root; data-bead while a bead
 *                colour is forced, data-still while the turn is held, data-ticked while the
 *                orbit is drawn in poses
 *   handle       setRate(rate), through `ref`
 *   ticker       MARK_POSES, the poses a second; createMarkTicker, for a page that compares rates;
 *                MARK_HOLD, the host attributes that stop it
 * EVERYTHING ELSE IS PRIVATE: a mark's class names, part names, keyframe names and its own custom
 * properties (`--cm-*`, `--ck-*` and so on) may change in any regeneration.
 *
 * PRECEDENCE, for every value: a prop beats a `--mark-*` variable, which beats the state's default.
 * One exception, on purpose: a state that forces a bead colour (`applying`, `reconnected`) beats a
 * `--mark-bead` from a stylesheet, because those states ARE the colour. Only the `beads` prop beats it.
 */
import type { CSSProperties, Ref, SVGProps } from "react";
import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";

// ─── the states ─────────────────────────────────────────────────────────────────────────────────

/**
 * What the mark says, never how it says it. Each mark draws each state in its own idiom (glass
 * lights up, pixel beads hop), and the meaning is shared:
 *
 *   rest         nothing is happening. The mark drifts, one turn in 48 s, drawn in poses.
 *   loading      something is being fetched or worked on. Fast, and the mark's live colours.
 *   applying     the app itself is updating. Calm, one turn in 20 s, drawn in poses, every bead in
 *                the status "working" colour.
 *   reconnected  the link came back. Fast, every bead in the status "done" colour, for one turn.
 *   idle         not connected, or put aside. Held in the pose it is in, dimmed and grey.
 *
 * SLOW IS DRAWN IN POSES. A running CSS animation asks the browser for a new frame 60 times a second
 * whatever its pace. Until issue 748 (collie) rest was such an animation, a 48 s drift, and on one
 * Android build that frame rate, all day, drove Chrome's GPU process past the system's file limit
 * until the system killed it. Collie 1.28.0 then held rest still. Since 2026-11-09 the drift is back,
 * without the frames: in `rest` and `applying` every animation in the mark is PAUSED (`data-ticked`),
 * and one ticker for the whole page seeks them forward `MARK_POSES.perSecond` times a second. The
 * browser draws only those poses. A slow orbit moves a few degrees a pose, so it still reads as
 * moving. The fast states (`loading`, `reconnected`) are real running animations: they are short,
 * and at 1.8 s a turn a pose a quarter second apart would read as a stutter.
 *
 * ONE PHASE, WHATEVER DRAWS IT. A state change never restarts an animation: the paused ones and the
 * running ones are the same animations, so a mark that starts turning starts from the pose the
 * ticker last showed, and a mark that stops turning is ticked on from where it stopped. The phase
 * carry in `useMark` keeps the progress when the turn's length changes.
 *
 * EVERY STATE DIFFERS FROM `rest` BY COLOUR, not only by movement. Under `prefers-reduced-motion`
 * every mark stops turning and the ticker stops, and the colour is then the whole message.
 */
export const MARK_STATES = ["rest", "loading", "applying", "reconnected", "idle"] as const;
export type MarkState = (typeof MARK_STATES)[number];

export function isMarkState(value: string): value is MarkState {
  return MARK_STATES.some((state) => state === value);
}

/**
 * Seconds for one turn, at the three paces. ONE table for every mark: a spin round, the busy turn and
 * the reconnection's single turn are timed in turns, so they only mean the same thing on every mark
 * if every mark turns at the same pace. `live` is collie-brand's `SPRINT`, `rest` its `DRIFT`.
 * `calm` is the update's turn: 2.4 times the drift's speed, so an update reads as busier than rest
 * and far calmer than loading (Altan, 2026-11-09: "maybe 2-3 times the idle").
 */
export const MARK_TURN = { rest: 48, calm: 20, live: 1.8 } as const;

/** One full turn at the live pace, in milliseconds. The header's spin round is exactly this long. */
export const ORBIT_TURN_MS = MARK_TURN.live * 1000;

/**
 * How often the ticker draws a new pose of a mark in `rest` or `applying`, and how it gets there.
 * THE ONE NUMBER for the cost of a slow mark: the browser draws `perSecond` frames a second for it,
 * not 60. At 4 a second a pose moves the drift 1.9 degrees round its orbit and the update 4.5.
 * `glideMs` above 0 eases each pose in over that many milliseconds (at 60 frames a second while it
 * glides) instead of cutting to it.
 */
export const MARK_POSES = { perSecond: 4, glideMs: 0 } as const;

/**
 * The attributes a host sets to stop every animation under them: `data-page-hidden` on `<html>`
 * while the page is hidden, `data-app-covered` on the app while a veil covers it (Collie's rule for
 * issue 748, in its `index.css`). A paused animation still draws a seek, so the ticker reads the
 * same two attributes and draws no pose for a mark under either.
 */
export const MARK_HOLD = ["data-page-hidden", "data-app-covered"] as const;

/** The dimmed look of `idle`: what the host used to add as `opacity-40 grayscale`. */
export const MARK_DIM = { opacity: 0.4, filter: "grayscale(1)" } as const;

interface StateLook {
  /** Which turn the state uses. */
  pace: keyof typeof MARK_TURN;
  /** Which of the mark's own two looks. */
  look: "rest" | "live";
  /** A colour every bead takes, or null for the mark's own bead colours. */
  bead: string | null;
  dim: boolean;
  /** How the orbit moves: a running animation, poses from the ticker, or held where it is. */
  motion: "run" | "tick" | "hold";
}

/**
 * The states, as a table. The two forced bead colours are Collie's status tokens; the fallbacks are
 * their dark-ground values, for a page that does not define them (the website).
 */
export const MARK_STATE_LOOK = {
  rest: { pace: "rest", look: "rest", bead: null, dim: false, motion: "tick" },
  loading: { pace: "live", look: "live", bead: null, dim: false, motion: "run" },
  applying: { pace: "calm", look: "live", bead: "var(--status-working, oklch(0.84 0.15 82))", dim: false, motion: "tick" },
  reconnected: { pace: "live", look: "live", bead: "var(--status-done, oklch(0.77 0.16 152))", dim: false, motion: "run" },
  idle: { pace: "rest", look: "rest", bead: null, dim: true, motion: "hold" },
} as const satisfies Record<MarkState, StateLook>;

// ─── what a mark takes, and what it offers ──────────────────────────────────────────────────────

export interface MarkProps {
  /** Rendered width and height, in pixels. */
  size?: number;
  /** `header` below about 80 px: cropped, heavier, with the smallest beads dropped. */
  weight?: "full" | "header";
  /**
   * Whatever the mark is sitting on: the colour of the knockout that makes a bead read as IN FRONT
   * of the head. A wrong value shows as a halo. Default: `--mark-paper`, else `--background`.
   */
  paper?: string;
  /** An accessible name. Without one the mark is decorative and hidden from assistive tech. */
  title?: string;
  /** Forwarded to the root. Never reach a mark's parts through it: they are private. */
  className?: string;
  /** What the mark says. Default `rest`. */
  state?: MarkState;
  /** @deprecated Use `state="loading"`. Kept until every call site has moved, then deleted. */
  loading?: boolean;
  /** Bead colours: one for every bead, or a list applied in bead order and repeated. */
  beads?: string | readonly string[];
  /**
   * Seconds per turn, overriding the state's pace. `0` holds the orbit where it is. The state still
   * decides how the orbit moves: in poses in `rest` and `applying`, running in the fast states.
   */
  turn?: number;
  /** The imperative half of the contract. */
  ref?: Ref<MarkHandle>;
}

export interface MarkHandle {
  /**
   * A playback rate for the orbit, on top of its turn: 1 is the turn as set, 0 holds it. For a curve
   * the host animates frame by frame (the header's spin round), where changing `turn` every frame
   * would recompute style every frame. The mark carries no phase across it: a rate keeps the phase
   * by definition. Set it back to 1 before the next state change.
   *
   * A rate other than 1 also lets a mark that is drawn in poses run as a real animation, until the
   * rate is 1 again: a host that rates it frame by frame is drawing every frame anyway, and poses
   * under a rate curve would stutter (the website's hover and throw rate a resting mark).
   */
  setRate(rate: number): void;
}

/** What a generated mark tells the runtime about itself. Private to the generators. */
export interface MarkSpec {
  /** The id the host registers the mark under. Becomes `data-mark`. */
  id: string;
  /** The number of beads, for a `beads` list. */
  beads: number;
  /** The animations the turn paces: their phase is carried and their rate is set. */
  paced: RegExp;
  /** The class the root carries while the pace is live (the mark's stylesheet keys on it). */
  liveClass: string;
  /** The mark's own colours, per look, as its private custom properties. */
  look: { rest: Record<string, string>; live: Record<string, string> };
  /** The private properties that ARE accent 1 and 2, if the mark has accents. */
  accents?: readonly [string, string];
  /** The private property the drawing reads for the turn. */
  turnVar: string;
  /** The private property the drawing reads for the paper. */
  paperVar: string;
  view: { full: string; header: string };
}

/**
 * The rules every mark's stylesheet starts with. A held turn pauses every animation in the mark, so
 * the phase is exactly where it was when the turn comes back. A mark drawn in poses pauses them too:
 * the ticker seeks them, and a paused animation asks for a frame only when it is sought. Scoped by
 * `data-mark`, which only a mark's root carries.
 */
export const MARK_STYLE =
  "[data-mark][data-still] *,[data-mark][data-ticked] *{animation-play-state:paused!important}";

// ─── the runtime ────────────────────────────────────────────────────────────────────────────────

/** A resolved `animation-duration` style value in seconds, or null when it is not one. */
function seconds(value: string): number | null {
  const m = /^\s*([\d.]+)(m?s)\s*$/.exec(value);
  if (m === null) return null;
  const n = Number(m[1]);
  return m[2] === "ms" ? n / 1000 : n;
}

/** The paced CSS animations under `el`. Empty where the engine has no `getAnimations` (jsdom). */
function paced(el: SVGSVGElement, pattern: RegExp): Animation[] {
  if (!("getAnimations" in el)) return [];
  return el.getAnimations({ subtree: true }).filter((a) => {
    // SAFETY: `getAnimations` also returns transitions; only a CSSAnimation has `animationName`, and
    // the `in` check is the discriminator before the property is read.
    const name = "animationName" in a ? String((a as CSSAnimation).animationName) : "";
    return pattern.test(name);
  });
}

/** Every CSS animation under `el`: the paced ones, and any of the mark's own (a twinkle). */
function animationsUnder(el: SVGSVGElement): Animation[] {
  if (!("getAnimations" in el)) return [];
  return el.getAnimations({ subtree: true }).filter((a) => "animationName" in a);
}

/** The frame a glide is drawn at, in milliseconds. */
const GLIDE_FRAME_MS = 1000 / 60;

/** Ease in and out over [0, 1]. */
function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
}

/** Whether the reader asked for reduced motion. False where the engine has no `matchMedia` (jsdom). */
function motionReduced(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export interface MarkTicker {
  /** Draw every animation under `el` in poses, until the returned function is called. */
  add(el: SVGSVGElement): () => void;
}

/** One seek a pose asks for: the animation, where it was, and how far it moves. */
interface Seek {
  animation: Animation;
  from: number;
  by: number;
}

/**
 * A ticker: ONE timer for every mark it draws, never a `requestAnimationFrame` loop. Each tick seeks
 * every animation under each mark forward by the time since the last tick (times its playback rate),
 * so the orbit keeps the speed its turn says however late a timer fires.
 *
 * It runs only while it has something to draw: at least one mark, the document visible, no
 * `prefers-reduced-motion`, and a mark that is not under one of the `MARK_HOLD` attributes. Each of
 * those is watched, not polled, so a page left alone runs no timer at all. When it starts again it
 * starts from now: the time it was stopped is not caught up in one jump.
 *
 * `useMark` uses one shared ticker at `MARK_POSES`. A page that compares rates makes its own, and
 * holds those marks with `turn={0}` so the shared one leaves them alone.
 */
export function createMarkTicker({ perSecond, glideMs }: { perSecond: number; glideMs: number }): MarkTicker {
  if (!(perSecond > 0)) throw new Error(`a ticker needs a positive pose rate, got ${perSecond}`);
  const marks = new Set<SVGSVGElement>();
  const holds = MARK_HOLD.map((name) => `[${name}]`).join(",");
  let timer: ReturnType<typeof setInterval> | null = null;
  let glideTimer: ReturnType<typeof setTimeout> | null = null;
  let gliding: Seek[] = [];
  let last = 0;
  let unwatch: (() => void) | null = null;

  const isHeld = (el: SVGSVGElement): boolean => !el.isConnected || el.closest(holds) !== null;
  const shouldRun = (): boolean =>
    marks.size > 0 && document.visibilityState !== "hidden" && !motionReduced() && [...marks].some((el) => !isHeld(el));

  /** Finish a glide under way at once, so no seek outlives the pose it belongs to. */
  function land(): void {
    if (glideTimer !== null) clearTimeout(glideTimer);
    glideTimer = null;
    for (const seek of gliding) seek.animation.currentTime = seek.from + seek.by;
    gliding = [];
  }

  function glide(seeks: Seek[], started: number): void {
    land();
    gliding = seeks;
    const frame = (): void => {
      const p = Math.min(1, (performance.now() - started) / glideMs);
      for (const seek of gliding) seek.animation.currentTime = seek.from + seek.by * easeInOut(p);
      if (p >= 1) {
        gliding = [];
        glideTimer = null;
        return;
      }
      glideTimer = setTimeout(frame, GLIDE_FRAME_MS);
    };
    glideTimer = setTimeout(frame, GLIDE_FRAME_MS);
  }

  function tick(): void {
    const now = performance.now();
    const elapsed = now - last;
    last = now;
    const seeks: Seek[] = [];
    for (const el of marks) {
      if (isHeld(el)) continue;
      for (const animation of animationsUnder(el)) {
        // A time may be null or a typed value; anything but a plain number is left alone.
        const from = Number(animation.currentTime ?? Number.NaN);
        if (!Number.isFinite(from)) continue;
        seeks.push({ animation, from, by: elapsed * animation.playbackRate });
      }
    }
    if (glideMs > 0) {
      glide(seeks, now);
      return;
    }
    for (const seek of seeks) seek.animation.currentTime = seek.from + seek.by;
  }

  function sync(): void {
    const run = shouldRun();
    if (run && timer === null) {
      last = performance.now();
      timer = setInterval(tick, 1000 / perSecond);
      return;
    }
    if (run || timer === null) return;
    clearInterval(timer);
    timer = null;
    land();
  }

  function watch(): () => void {
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: [...MARK_HOLD] });
    document.addEventListener("visibilitychange", sync);
    motion?.addEventListener?.("change", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      motion?.removeEventListener?.("change", sync);
    };
  }

  return {
    add(el) {
      marks.add(el);
      unwatch ??= watch();
      sync();
      return () => {
        marks.delete(el);
        land();
        if (marks.size === 0) {
          unwatch?.();
          unwatch = null;
        }
        sync();
      };
    },
  };
}

let shared: MarkTicker | null = null;

/** The page's one ticker for every mark, made on first use. */
function sharedTicker(): MarkTicker {
  shared ??= createMarkTicker(MARK_POSES);
  return shared;
}

/** How the orbit moves, from the state's motion and the two things a host can say over it. */
function motionOf(motion: StateLook["motion"], turn: number | undefined, rated: boolean): StateLook["motion"] {
  if (turn === 0) return "hold";
  if (motion === "tick" && rated) return "run";
  return motion;
}

export interface MarkRoot {
  /** Spread onto the mark's `<svg>`. */
  root: SVGProps<SVGSVGElement> & { ref: Ref<SVGSVGElement> } & Record<`data-${string}`, string | undefined>;
  /** Whether the look is live: a mark with a resting drift class puts it on its body while not. */
  live: boolean;
  weight: "full" | "header";
  /** A per-instance id fragment for the mark's own `id`s (`useId`, stripped to a safe set). */
  uid: string;
}

/**
 * Everything a mark does that is not drawing. A generated mark calls this once and spreads `root`.
 *
 * KEEP THE PHASE ACROSS A TURN CHANGE. A CSS animation keeps its ELAPSED time when its duration
 * changes, not its progress, so a new pace alone slides every bead to a different point of the
 * orbit. After each change the runtime reads the turn the root now resolves to, compares it with the
 * one before, and moves every paced animation back to the progress it had. It runs once per change
 * and never per frame. Where there is no `getAnimations` the pace still changes; it steps once on
 * the way.
 *
 * NO LAST LAP. Until the drift came back in poses, a mark that left a live state kept turning until
 * its orbit came home, so it would not jump to a still pose. Now nothing jumps: a mark that leaves a
 * live state for `rest` or `applying` is ticked on from the pose it is in, and one that leaves it for
 * `idle` holds that pose.
 */
export function useMark(spec: MarkSpec, props: MarkProps): MarkRoot {
  const { size = 32, weight = "full", paper, title, className, beads, turn, ref } = props;
  const state: MarkState = props.state ?? (props.loading === true ? "loading" : "rest");
  const look: StateLook = MARK_STATE_LOOK[state];
  // Whether the host has a rate other than 1 on the orbit (`setRate`): it then runs, not ticks.
  const [rated, setRated] = useState(false);
  const motion = motionOf(look.motion, turn, rated);
  const live = look.look === "live";
  const pace = look.pace;
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const el = useRef<SVGSVGElement>(null);

  const vars: Record<string, string> = {};
  vars[spec.turnVar] = turn !== undefined && turn > 0 ? `${turn}s` : `var(--mark-turn, ${MARK_TURN[pace]}s)`;
  for (const [k, v] of Object.entries(spec.look[look.look])) vars[k] = v;
  if (spec.accents !== undefined) {
    vars[spec.accents[0]] = `var(--mark-accent-1, ${spec.look[look.look][spec.accents[0]]})`;
    vars[spec.accents[1]] = `var(--mark-accent-2, ${spec.look[look.look][spec.accents[1]]})`;
  }
  vars[spec.paperVar] = paper ?? "var(--mark-paper, var(--background))";
  // One colour, or a list in bead order. A list of one is the same as the one colour.
  // Every per-bead variable is set too, never only `--mark-bead`: a bead reads its own variable first,
  // so a `--mark-bead-<i>` a stylesheet set on an ancestor would otherwise beat the forced colour.
  const list: readonly string[] = beads === undefined ? [] : [beads].flat();
  const colours = list.length > 0 ? list : look.bead === null ? [] : [look.bead];
  if (colours.length > 0) {
    vars["--mark-bead"] = colours[0];
    for (let i = 0; i < spec.beads; i += 1) vars[`--mark-bead-${i}`] = colours[i % colours.length];
  }
  const forced = colours.length > 0;

  // The phase carry. `prev` is the turn, in seconds, the last commit resolved to.
  const prev = useRef<number | null>(null);
  const rates = useRef<Animation[] | null>(null);
  useEffect(() => {
    const node = el.current;
    if (node === null) return;
    rates.current = null;
    const now = seconds(getComputedStyle(node).getPropertyValue(spec.turnVar));
    const before = prev.current;
    prev.current = now;
    if (now === null || before === null || now === before) return;
    const ratio = before / now;
    for (const a of paced(node, spec.paced)) {
      const t = a.effect?.getTiming();
      // The Web Animations API answers in unions (a time may be null or a typed value, a duration
      // may be "auto"). Each is parsed to a plain number here, and anything else is skipped.
      const at = Number(a.currentTime ?? Number.NaN);
      const delay = Number(t?.delay ?? 0);
      const span = Number(t?.duration ?? Number.NaN);
      if (!Number.isFinite(at) || !Number.isFinite(delay) || !Number.isFinite(span) || span <= 0) continue;
      const progress = (at - delay * ratio) / (span * ratio);
      a.currentTime = delay + (progress - Math.floor(progress)) * span;
    }
    // Keyed on what can change the turn from a prop. A `--mark-turn` a stylesheet changes later is
    // read at the next change of either; between them the orbit keeps its elapsed time, as CSS does.
  }, [pace, turn, spec]);

  // The poses. Declared after the carry, so on a change into a ticked state the carry has re-timed
  // the animations before the first pose is drawn. Leaving one, the ticker lands any glide first.
  const ticked = motion === "tick";
  useEffect(() => {
    const node = el.current;
    if (!ticked || node === null) return;
    return sharedTicker().add(node);
  }, [ticked]);

  useImperativeHandle(ref, () => ({
    setRate(rate: number) {
      const node = el.current;
      if (node === null) return;
      // Cached only when non-empty: a call before the first frame finds no animations yet, and an
      // empty cache would rate nothing for the rest of the mount. The cache is dropped on every pace
      // or turn change (the effect above), the only times the mark's animations are re-timed.
      const found = rates.current ?? paced(node, spec.paced);
      if (found.length > 0) rates.current = found;
      for (const a of found) a.updatePlaybackRate(rate);
      setRated(rate !== 1);
    },
  }), [spec]);

  // SAFETY: every key `vars` adds is a CSS custom property and every value a string; React passes
  // unknown style keys through to the DOM as written. CSSProperties has no index signature for
  // `--*`, which is the only reason for the cast.
  const style = { display: "block", flex: "none", ...vars } as CSSProperties;
  if (look.dim) Object.assign(style, MARK_DIM);
  const classes = [live ? spec.liveClass : "", className ?? ""].join(" ").trim();
  return {
    root: {
      ref: el,
      width: size,
      height: size,
      className: classes === "" ? undefined : classes,
      viewBox: spec.view[weight],
      role: title === undefined ? "presentation" : "img",
      "aria-label": title,
      style,
      "data-mark": spec.id,
      "data-state": state,
      "data-bead": forced ? "" : undefined,
      "data-still": motion === "hold" ? "" : undefined,
      "data-ticked": ticked ? "" : undefined,
    },
    live,
    weight,
    uid,
  };
}

/** The fill a bead's body reads, so `beads`, `--mark-bead` and the state colours reach it. */
export function beadFill(index: number, own: string): string {
  return `var(--mark-bead-${index}, var(--mark-bead, ${own}))`;
}

/** The ink every mark draws its line in. Follows the text colour unless `--mark-ink` says otherwise. */
export const MARK_INK = "var(--mark-ink, var(--collie-ink, currentColor))";
