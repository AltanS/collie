// generated: sha256=775832920e999e82d1bf42c75fb8428fdcb8b409d360eecbcdb8db2b68d8e006 from=collie-brand/src/mark-contract.ts@e51f6910085a
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
 *   props        size, weight, paper, title, className, state, beads, turn, drift, ref (and
 *                `loading`, deprecated, an alias for state="loading")
 *   variables    --mark-turn, --mark-bead, --mark-bead-<i>, --mark-accent-1, --mark-accent-2,
 *                --mark-ink, --mark-paper, read on the mark's root or inherited from an ancestor
 *   attributes   data-mark="<id>" and data-state="<state>" on the root; data-bead while a bead
 *                colour is forced, data-still while the turn is held, data-slow while the pace
 *                is one of the two slow ones (a mark pauses there what its compositor cannot run)
 *   handle       setRate(rate), through `ref`
 *   drift        MARK_DRIFT, when a resting mark drifts
 * EVERYTHING ELSE IS PRIVATE: a mark's class names, part names, keyframe names and its own custom
 * properties (`--cm-*`, `--ck-*` and so on) may change in any regeneration.
 *
 * PRECEDENCE, for every value: a prop beats a `--mark-*` variable, which beats the state's default.
 * One exception, on purpose: a state that forces a bead colour (`applying`, `reconnected`) beats a
 * `--mark-bead` from a stylesheet, because those states ARE the colour. Only the `beads` prop beats it.
 */
import type { CSSProperties, Ref, SVGProps } from "react";
import { useEffect, useId, useImperativeHandle, useRef, useState, useSyncExternalStore } from "react";

// ─── the states ─────────────────────────────────────────────────────────────────────────────────

/**
 * What the mark says, never how it says it. Each mark draws each state in its own idiom (glass
 * lights up, pixel beads hop), and the meaning is shared:
 *
 *   rest         nothing is happening. The mark drifts, one turn in 48 s, while the page is in use.
 *   loading      something is being fetched or worked on. Fast, and the mark's live colours.
 *   applying     the app itself is updating. Calm, one turn in 20 s, every bead in the status
 *                "working" colour.
 *   reconnected  the link came back. Fast, every bead in the status "done" colour, for one turn.
 *   idle         not connected, or put aside. Held in the pose it is in, dimmed and grey.
 *
 * WHAT A FRAME COSTS (issue 748, collie). A running CSS animation asks for a new frame every vsync,
 * whatever its pace. Until 1.28.0 the resting drift ran all day, and on one Android build that frame
 * rate drove Chrome's GPU process past the system's file limit. Measured on 2026-11-09 in headless
 * Chromium, the bead paths themselves are cheap: a transform or opacity animation on an SVG part runs
 * on the compositor, with no style, layout or paint on the main thread. What cost 80 ms of main
 * thread a second was the Collie mark's balls turning on their own axes, a texture moving inside a
 * `<mask>`, which only the main thread can draw. So:
 *
 *   - At the two slow paces (`data-slow`) a mark pauses what its compositor cannot run (the Collie
 *     mark's ball turn). The orbit itself runs, smooth.
 *   - A resting mark drifts only while the page is IN USE (`MARK_DRIFT`): a touch, a key, a wheel or
 *     a scroll in the last 20 s. Then it eases to a stop over 2 s and holds, so a page left alone
 *     draws no frame at all. Any input sets it going again from the pose it held.
 *   - `applying` always turns while it lasts; `loading` and `reconnected` are short.
 *
 * ONE PHASE. A state change never restarts an animation, so nothing jumps: a mark that starts or
 * stops turning does so from the pose it is in, and the phase carry in `useMark` keeps the progress
 * when the turn's length changes. A hidden page and a covered app pause every animation by the host's
 * own rule, and under `prefers-reduced-motion` every mark stops turning.
 *
 * EVERY STATE DIFFERS FROM `rest` BY COLOUR, not only by movement. Under `prefers-reduced-motion`
 * every mark stops turning, and the colour is then the whole message.
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
 * When a resting mark drifts. `in-use`: while the page has had a touch, a key, a wheel or a scroll in
 * the last `windowMs`; then the drift eases to a stop over `easeMs` and holds until the next input.
 * `always`: whenever the mark rests (a page that is only ever looked at, like a landing page).
 */
export const MARK_DRIFT = { mode: "in-use", windowMs: 20_000, easeMs: 2_000 } as const;

/** The two ways a resting mark drifts. */
export type MarkDriftMode = "always" | "in-use";

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
  /** How the orbit moves: always running, drifting while the page is in use, or held where it is. */
  motion: "run" | "drift" | "hold";
}

/**
 * The states, as a table. The two forced bead colours are Collie's status tokens; the fallbacks are
 * their dark-ground values, for a page that does not define them (the website).
 */
export const MARK_STATE_LOOK = {
  rest: { pace: "rest", look: "rest", bead: null, dim: false, motion: "drift" },
  loading: { pace: "live", look: "live", bead: null, dim: false, motion: "run" },
  applying: { pace: "calm", look: "live", bead: "var(--status-working, oklch(0.84 0.15 82))", dim: false, motion: "run" },
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
   * decides how the orbit moves: a drift in `rest`, a steady turn in `applying` and the fast states.
   */
  turn?: number;
  /** When `rest` drifts, overriding `MARK_DRIFT.mode`. */
  drift?: MarkDriftMode;
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
   * A rate other than 1 also keeps a resting mark drifting while the page is not in use, until the
   * rate is 1 again: a host that rates it frame by frame wants it to move (the website's hover).
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
 * the phase is exactly where it was when the turn comes back. Scoped by `data-mark`, which only a
 * mark's root carries.
 */
export const MARK_STYLE = "[data-mark][data-still] *{animation-play-state:paused!important}";

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

/** The milliseconds between two steps of the drift's ease to a stop. */
const EASE_STEP_MS = 100;

/**
 * WHETHER THE PAGE IS IN USE: a touch, a key, a wheel or a scroll in the last `MARK_DRIFT.windowMs`.
 * One reading for the page, shared by every mark. Listening costs nothing per event (it stores a
 * time); one timer runs while a mark listens and re-arms itself only when it fires. A page that has
 * just been opened counts as in use.
 */
const INPUTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
const inUseListeners = new Set<() => void>();
let inUse = true;
let lastInput = 0;
let quietTimer: ReturnType<typeof setTimeout> | null = null;

function noteInput(): void {
  lastInput = performance.now();
  if (inUse) return;
  inUse = true;
  armQuiet(MARK_DRIFT.windowMs);
  for (const listener of inUseListeners) listener();
}

function armQuiet(delay: number): void {
  if (quietTimer !== null) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    quietTimer = null;
    const left = MARK_DRIFT.windowMs - (performance.now() - lastInput);
    if (left > 0) {
      armQuiet(left);
      return;
    }
    inUse = false;
    for (const listener of inUseListeners) listener();
  }, delay);
}

function subscribeInUse(listener: () => void): () => void {
  inUseListeners.add(listener);
  if (inUseListeners.size === 1) {
    for (const type of INPUTS) window.addEventListener(type, noteInput, { capture: true, passive: true });
    lastInput = performance.now();
    inUse = true;
    armQuiet(MARK_DRIFT.windowMs);
  }
  return () => {
    inUseListeners.delete(listener);
    if (inUseListeners.size > 0) return;
    for (const type of INPUTS) window.removeEventListener(type, noteInput, { capture: true });
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = null;
    inUse = true;
  };
}

const getInUse = (): boolean => inUse;
const alwaysInUse = (): boolean => true;
const subscribeNever = (): (() => void) => () => {};

/** How the orbit moves, from the state's motion and what the host and the page say over it. */
function motionOf(
  motion: StateLook["motion"],
  over: { turn: number | undefined; rated: boolean; awake: boolean; easing: boolean },
): "run" | "hold" {
  if (over.turn === 0 || motion === "hold") return "hold";
  if (motion === "run" || over.rated || over.awake || over.easing) return "run";
  return "hold";
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
 * NO LAST LAP. A mark that leaves a live state goes on from the pose it is in: at the drift's pace in
 * `rest`, at the calm pace in `applying`, held in `idle`. A resting mark on a page nobody uses eases
 * its rate down to nothing over `MARK_DRIFT.easeMs`, then holds.
 */
export function useMark(spec: MarkSpec, props: MarkProps): MarkRoot {
  const { size = 32, weight = "full", paper, title, className, beads, turn, ref } = props;
  const driftMode: MarkDriftMode = props.drift ?? MARK_DRIFT.mode;
  const state: MarkState = props.state ?? (props.loading === true ? "loading" : "rest");
  const look: StateLook = MARK_STATE_LOOK[state];
  // Whether the host has a rate other than 1 on the orbit (`setRate`): a resting mark then drifts.
  const [rated, setRated] = useState(false);
  const watching = look.motion === "drift" && driftMode === "in-use";
  const pageInUse = useSyncExternalStore(
    watching ? subscribeInUse : subscribeNever,
    watching ? getInUse : alwaysInUse,
    alwaysInUse,
  );
  const awake = look.motion !== "drift" || pageInUse;
  // THE EASE TO A STOP. When the page stops being in use, a drifting mark keeps running while its rate
  // falls to nothing, then holds. Adjusted while rendering, React's pattern for state that follows a
  // value, so the commit that ends the drift is already the one that keeps it running for the ease.
  const [easing, setEasing] = useState(false);
  const [wasAwake, setWasAwake] = useState(awake);
  if (wasAwake !== awake) {
    setWasAwake(awake);
    setEasing(!awake);
  }
  const motion = motionOf(look.motion, { turn, rated, awake, easing });
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

  // The ease: the paced animations' rate falls from 1 to 0 over `MARK_DRIFT.easeMs`, a few steps a
  // second, then the mark holds. Whatever ends it (the ease running out, an input, a state change)
  // puts the rate back to 1; by then the mark is held or running on, so the reset moves nothing.
  useEffect(() => {
    if (!easing) return;
    const node = el.current;
    const found = node === null ? [] : paced(node, spec.paced);
    const started = performance.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (performance.now() - started) / MARK_DRIFT.easeMs);
      for (const a of found) a.updatePlaybackRate((1 - p) ** 2);
      if (p >= 1) setEasing(false);
    }, EASE_STEP_MS);
    return () => {
      clearInterval(timer);
      for (const a of found) a.updatePlaybackRate(1);
    };
  }, [easing, spec]);

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
      "data-slow": pace === "live" ? undefined : "",
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
