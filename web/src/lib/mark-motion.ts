import { useSyncExternalStore } from "react";

import type { MarkProps } from "@/components/mark-contract";
import { designPrefs, useDesignPrefs } from "@/lib/design";
import type { Theme } from "@/lib/theme/schema";
import { activeTheme, useActiveTheme } from "@/lib/theme/store";
import { currentTrial, useTrial } from "@/lib/theme/trial";

// WHETHER THE HEADER CHARACTER MOVES AT REST. One rule, in one place, read by `BrandMark` (the worn
// character, through `useMarkMotion`) and by the Settings switch, so they cannot disagree. The boot
// splash, the idle lock, the agent-start handoff and the tour draw `CollieMark` directly and never
// call it (components/brand-mark.tsx). It answers a different question than `lib/mark.ts` (which
// character) and reads the same three sources in the same order.
//
//   1. The device's own switch (Settings > Appearance > Character, "Character moves"). Both values are
//      stored (`DesignPrefs.markMoves`), so from the first touch it wins over every theme. A switch
//      nobody touched is the ABSENCE of the field and falls through.
//   2. The `characterMotion` of the theme the app is wearing; a theme being TRIED is the one worn.
//      `still` stops it. Absent, or `moves`, lets it move.
//   3. It moves.
//
// HOW IT MOVES. The contract (`mark-contract.ts`, sealed, generated in collie-brand) already has the
// word for it: `drift="always"` drifts a resting mark whenever it is drawn, with no input needed, where
// its default (`in-use`) rests until a touch. So the app changes no contract: this hook hands the mark
// `drift="always"` while it moves, and `turn={0}` (which holds the orbit where it is, every animation
// paused, `data-still`) while it does not. Only a mark that is RESTING is touched. A live state
// (`loading`, `applying`, `reconnected`), a held one (`idle`) and a caller that set `turn` or `drift`
// itself (the Character page holds its rows that are off screen) draw exactly as they asked.
//
// WHEN IT RESTS WHATEVER THE SWITCH SAYS. A hidden page and a page on its way into the back-forward
// cache (`pagehide`), and `prefers-reduced-motion: reduce`. A browser draws no frames for a hidden page
// anyway; saying so here keeps the mark's own state honest (`data-still`) and makes it testable where
// jsdom runs no animation. The mark's stylesheet already stops the turn under reduced motion; the hold
// here makes the attribute agree with the picture.
//
// WHAT IT COSTS, AND HOW IT IS BOUNDED. See `mark-contract.ts` ("WHAT A FRAME COSTS"): the orbit is a
// transform animation on the compositor, but a smooth one asks for a frame at every vsync, 60 a second, for
// as long as the page is visible. That is what issue 748 is about. So a drifting mark also wears `STEPS_CLASS`,
// and `index.css` draws its drift in steps, about 12 a second, which asks for a frame only at a step
// (`e2e/idle-repaint.spec.ts` has the measured table: 600 frames in 10 s smooth, about 127 stepped, 0 with
// the switch off). The switch and the theme key stay the way out.
//
// WHY THERE IS NO GENERAL "REDUCE MOTION" SETTING (issue 748, ADR 0148 rule 9). It would leave the cost
// on by default for everyone who does not know to look for it. A page nobody is looking at is paused
// instead (`lib/page-hidden.ts`, `index.css`), and `prefers-reduced-motion` still wins.
//
// SERVER SNAPSHOT: STILL. The server and the first client render draw a held mark, as the contract's own
// snapshot of "in use" does, and the client then moves it, so a hydration never sees two different trees.

/** The class a drifting mark wears: `index.css` draws its drift in steps at about 12 a second (ADR 0138). */
export const STEPS_CLASS = "mark-steps";

export interface MarkMotionSources {
  /** The device's switch (`DesignPrefs.markMoves`), absent while it was never touched. */
  device: boolean | undefined;
  /** The theme being tried in this tab, or null. */
  trial: Theme | null;
  /** The stored theme on screen, shipped or imported. */
  active: Theme;
}

/** Whether the switch is on: the device's own choice, else the worn theme's `characterMotion`, else on. Pure. */
export function resolveMarkMoves({ device, trial, active }: MarkMotionSources): boolean {
  if (device !== undefined) return device;
  return (trial ?? active).characterMotion !== "still";
}

/** The switch now, read once. For code that is not a component. */
export function currentMarkMoves(): boolean {
  return resolveMarkMoves({ device: designPrefs().markMoves, trial: currentTrial()?.theme ?? null, active: activeTheme().theme });
}

/** The switch, reactive to the device (the design store), the stored theme and a trial. What Settings shows. */
export function useMarkMoves(): boolean {
  const device = useDesignPrefs().markMoves;
  const trial = useTrial()?.theme ?? null;
  const active = useActiveTheme().theme;
  return resolveMarkMoves({ device, trial, active });
}

// ─── the two facts about the page ────────────────────────────────────────────────────────────────

/** True from `pagehide` until the page is shown again: a page in the back-forward cache is not always reported hidden first. */
let leaving = false;

const pageVisible = (): boolean => !leaving && document.visibilityState === "visible";

function subscribeVisible(listener: () => void): () => void {
  const onHide = () => {
    leaving = true;
    listener();
  };
  const onShow = () => {
    leaving = false;
    listener();
  };
  // A page that is visible again is not leaving, whether or not `pageshow` came.
  const onVisibility = () => {
    if (document.visibilityState === "visible") leaving = false;
    listener();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
  };
}

const REDUCED = "(prefers-reduced-motion: reduce)";

/** The query, where the engine has one (an old engine, or a test environment, may not). */
const reducedQuery = (): MediaQueryList | null => window.matchMedia?.(REDUCED) ?? null;

const reducedMotion = (): boolean => reducedQuery()?.matches === true;

function subscribeReduced(listener: () => void): () => void {
  const query = reducedQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/** The first render of a page not yet read: held, so the server and the client agree. */
const held = (): boolean => false;
const reducedOnServer = (): boolean => true;

/**
 * Whether a resting mark should drift now: the switch is on, the page is visible and the system does not
 * ask for reduced motion. False on the server snapshot.
 */
export function useMarkDrifts(): boolean {
  const moves = useMarkMoves();
  const visible = useSyncExternalStore(subscribeVisible, pageVisible, held);
  const reduced = useSyncExternalStore(subscribeReduced, reducedMotion, reducedOnServer);
  return moves && visible && !reduced;
}

/**
 * The props a mark is drawn with, with the app's rule for a resting mark applied. A mark that is not
 * resting, or whose caller already said `turn` or `drift`, comes back as it was given.
 */
export function useMarkMotion<P extends MarkProps>(props: P): P {
  const drifts = useMarkDrifts();
  const state = props.state ?? (props.loading === true ? "loading" : "rest");
  if (state !== "rest" || props.turn !== undefined || props.drift !== undefined) return props;
  if (!drifts) return { ...props, turn: 0 };
  return { ...props, drift: "always", className: [props.className, STEPS_CLASS].filter(Boolean).join(" ") };
}
