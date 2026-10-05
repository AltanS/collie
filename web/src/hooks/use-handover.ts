import { useCallback, useEffect, useReducer, useRef, useState } from "react";

// ── THE HANDOVER IS ONE SEQUENCE (1.17.0, ADR 0082) ─────────────────────────────────────────────
//
// A shell becomes an agent. Two things then happen to the pane, and until 1.17.0 they ran on clocks
// that never met:
//
//   * the agent-start layer (components/agent-start.tsx) played its 1400 ms bloom, and
//   * the BODY swapped from the terminal to Chat whenever the first chat answer landed
//     (hooks/use-chat-ready.ts), or after 1500 ms. The agent's session is reported on a poll of its
//     own (`hasSession`), so that moment was anywhere from the first frame of the bloom to well after
//     the bloom had ended, and the layer is only 82% opaque, so the swap showed through it.
//
// This file makes them one sequence. The phases are `idle → covering → covered → revealing → idle`
// and the layer draws whatever phase says; the body may change only at `idle` or at `covered`.
//
//   covering   the veil comes in and the Collie mark flies to the centre. The body is HELD.
//   covered    the mark rests at the centre. The body may swap, and does, under the cover. The phase
//              stays until the body that will show is ready (hooks/use-chat-ready.ts has answered) or
//              {@link CAP_MS} has passed, so the reveal always uncovers the final body.
//   revealing  the mark goes home, the agent's mark rises, the veil leaves. The body is HELD again.
//
// ── ANIMATIONEND ADVANCES IT, A TIMER GUARANTEES IT ──────────────────────────────────────────────
// The layer reports `animationend` of the covering animation, which is what keeps the phase and the
// picture one clock. Every phase also has a timer, and the timer is what makes the sequence finish:
// a killed animation never fires `animationend` (under `prefers-reduced-motion`, or in a hidden tab),
// and a layer that waits for one would leave the body held for good. The first of the two to arrive
// wins; the second finds the phase already moved on and does nothing.

export type HandoverPhase = "idle" | "covering" | "covered" | "revealing";

/** How long each phase runs on its own clock, for the full bloom and for the calm still picture. */
interface Timings {
  /** Until the cover is complete: the mark has reached the centre. `animationend` usually beats it. */
  cover: number;
  /** The least the cover rests for once complete, so the beat survives an answer already in hand. */
  dwell: number;
  /** The whole reveal, until the layer has left. */
  reveal: number;
  /** Extra time the covering and revealing timers allow `animationend` before they step in. */
  slack: number;
}

/** The bloom: 380 ms flight, a 380 ms beat, a 640 ms reveal, which is the 1400 ms it always was. */
export const MOTION_TIMINGS: Timings = { cover: 380, dwell: 380, reveal: 640, slack: 150 };
/** Reduced motion: a still picture, no keyframe to wait for, so the timers are the clock. */
export const CALM_TIMINGS: Timings = { cover: 150, dwell: 250, reveal: 400, slack: 0 };

/** The longest a covered pane waits for the body that will show. A failed read must not strand it. */
export const CAP_MS = 1500;

export interface HandoverState {
  phase: HandoverPhase;
  /** The reduced-motion reading, taken once when the sequence began. */
  calm: boolean;
  /** The covered pane has rested its minimum. Meaningful in `covered` only. */
  dwelled: boolean;
  /** The covered pane has waited its cap. Meaningful in `covered` only. */
  capped: boolean;
}

export type HandoverAction =
  | { type: "start"; calm: boolean }
  /** The cover is complete: `animationend` of the covering animation, or its timer. */
  | { type: "covered" }
  | { type: "dwelled" }
  | { type: "capped" }
  /** `ready`: the body that will show is on hand. Moves `covered` on only when it may. */
  | { type: "reveal"; ready: boolean }
  /** The layer is gone: its last animation ended, its timer ran out, or a tap ended it. */
  | { type: "finish" };

export const IDLE: HandoverState = { phase: "idle", calm: false, dwelled: false, capped: false };

/** The state the sequence starts in. */
export function covering(calm: boolean): HandoverState {
  return { phase: "covering", calm, dwelled: false, capped: false };
}

/**
 * The whole machine. Pure, and every stray event is a no-op rather than an error: `animationend`
 * and its timer both report the same moment, and the later one must find nothing to do.
 */
export function handoverReducer(state: HandoverState, action: HandoverAction): HandoverState {
  switch (action.type) {
    case "start":
      // A second edge while a sequence is on screen does not restart it: the layer is one object.
      return state.phase === "idle" ? covering(action.calm) : state;
    case "covered":
      return state.phase === "covering" ? { ...state, phase: "covered" } : state;
    case "dwelled":
      return state.phase === "covered" ? { ...state, dwelled: true } : state;
    case "capped":
      return state.phase === "covered" ? { ...state, capped: true } : state;
    case "reveal":
      // Only a covered pane that has rested, and only for a body that is ready or a cap that passed.
      if (state.phase !== "covered" || !state.dwelled) return state;
      return action.ready || state.capped ? { ...state, phase: "revealing" } : state;
    case "finish":
      // From any phase, and at once: a tap ends the layer wherever it is.
      return IDLE;
  }
}

/**
 * Whether the body may change between the terminal and Chat in this phase.
 *
 * `idle` is the ordinary pane, where a swap is the operator's own choice or a late answer and no
 * cover is up. `covered` is the one moment the cover hides it. `covering` and `revealing` hold, so a
 * swap is never drawn beside the animation.
 */
export function swapAllowed(phase: HandoverPhase): boolean {
  return phase === "idle" || phase === "covered";
}

/**
 * The body to draw, given the one wanted. It follows `wanted` whenever {@link swapAllowed} and
 * otherwise keeps what it last drew, so a held swap lands in the same commit the phase allows it,
 * including the commit where a tap ends the layer.
 */
export function useHeldBody(wanted: boolean, phase: HandoverPhase): boolean {
  const [drawn, setDrawn] = useState(wanted);
  const allowed = swapAllowed(phase);
  if (allowed && drawn !== wanted) setDrawn(wanted);
  return allowed ? wanted : drawn;
}

/** The reduced-motion reading, spelled as `lib/glide.ts` spells it: optional-called, so jsdom is safe. */
function prefersCalm(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export interface Handover {
  phase: HandoverPhase;
  /** Whether this sequence is the still-picture one. Fixed when the sequence begins. */
  calm: boolean;
  /** The layer reports its covering animation ended. */
  onCovered: () => void;
  /** The layer reports its last animation ended, or a tap, so it can go. */
  onFinish: () => void;
}

/**
 * Drive the handover.
 *
 * @param active whether the agent-start layer is on screen (`useAgentStart` has an edge). Turning on
 *   begins the sequence; turning off ends it from any phase.
 * @param ready whether the body that WILL show is ready. The reveal waits for it, up to {@link CAP_MS}.
 * @param finish how the layer is taken down: the hook only decides WHEN, the caller owns the edge.
 */
export function useHandover(active: boolean, ready: boolean, finish: () => void): Handover {
  const [state, dispatch] = useReducer(handoverReducer, active, (on) => (on ? covering(prefersCalm()) : IDLE));
  // `active` moving is an event of this machine, taken in the render that sees it so the layer and
  // the body gate never disagree for a frame (the adjust-state-in-render pattern).
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    dispatch(active ? { type: "start", calm: prefersCalm() } : { type: "finish" });
  }

  // Read through a ref, so a caller's fresh closure every render cannot restart the revealing timer.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const onFinish = useCallback(() => finishRef.current(), []);

  const { phase, calm, dwelled } = state;
  const timings = calm ? CALM_TIMINGS : MOTION_TIMINGS;

  // Each phase's own clock. These are the guarantee; the layer's `animationend` is the fast path.
  useEffect(() => {
    if (phase === "covering") {
      const id = setTimeout(() => dispatch({ type: "covered" }), timings.cover + timings.slack);
      return () => clearTimeout(id);
    }
    if (phase === "covered") {
      const rest = setTimeout(() => dispatch({ type: "dwelled" }), timings.dwell);
      const cap = setTimeout(() => dispatch({ type: "capped" }), CAP_MS);
      return () => {
        clearTimeout(rest);
        clearTimeout(cap);
      };
    }
    if (phase === "revealing") {
      const id = setTimeout(onFinish, timings.reveal + timings.slack);
      return () => clearTimeout(id);
    }
  }, [phase, timings, onFinish]);

  // The reveal, offered whenever something it depends on moves. The reducer decides if it may.
  useEffect(() => {
    if (phase === "covered") dispatch({ type: "reveal", ready });
  }, [phase, dwelled, state.capped, ready]);

  const onCovered = useCallback(() => dispatch({ type: "covered" }), []);

  return {
    phase,
    calm,
    onCovered,
    onFinish,
  };
}
