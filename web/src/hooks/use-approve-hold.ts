import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

import { ignoreHeldEnter, useArm } from "@/hooks/use-arm";
import { HOLD_FEEDBACK_DELAY_MS, MOVE_CANCEL_PX, useLongPress } from "@/hooks/use-long-press";
import { APPROVE_HOLD_MS, APPROVE_SHIFT_PX, HOLD_BACK_MS } from "@/lib/arm";

// HOLD TO APPROVE (ADR 0156, the operator's decision of 2026-11-17). The yes to a trick's code, switching on a
// proposed trick or taking a new version, is a hold of APPROVE_HOLD_MS on the button, on every card that asks
// it. It is the belt Stop's hold (components/harness-bar.tsx `ScreenStop`) with a longer clock and more ways
// to end: the same `useLongPress` timer, move bound, haptic tick and `data-holding` look, the same fill
// (index.css `hold-fill-layer`), and the same answer for a key, two presses through `useArm`.
//
// WHAT A HOLD IS. The finger goes down on the rendered, enabled button and stays. From HOLD_FEEDBACK_DELAY_MS
// a fill grows across it; at APPROVE_HOLD_MS the yes goes out ONCE, with the finger still down. A press that
// began before the button was there, or while it was disabled, is never a hold: a hold starts only with a
// pointer-down on this button.
//
// WHAT ENDS A HOLD WITH NO YES. The finger lifts early; it leaves the button or moves past a thumb's jitter;
// `pointercancel` (the browser took the touch for a scroll); any scroll on the page; the page hidden or the
// window losing focus; the button moving on screen under the finger by more than APPROVE_SHIFT_PX (a layout
// shift); a new `resetKey` (the card's digest changed) or `enabled` turning false; the button leaving the page.
// A cancelled fill runs back to empty (HOLD_BACK_MS), and the next hold starts from zero.
//
// WHAT DOES NOTHING. A second finger while one holds, and any press while `enabled` is false (an answer in
// flight, a locked card).
//
// A KEY OR A SWITCH DEVICE CANNOT HOLD, so a click that no pointer made (Enter, Space, an assistive click)
// keeps the Stop's arm: the first press arms ("Press again to confirm") for ARM_MS, and a second press,
// ARM_DWELL_MS or more after the first, approves. A held Enter's repeats make no click.

/** Where a hold stands: at rest, a finger down before the fill shows, the fill growing, or a key's first press. */
export type ApproveHoldPhase = "rest" | "pressing" | "filling" | "armed";

/** The handlers and the one attribute the yes button spreads. */
export interface ApproveHoldProps {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  "data-holding": string | undefined;
}

export interface ApproveHold {
  phase: ApproveHoldPhase;
  /** The growing fill's style (its duration), while `phase` is "filling". */
  fillStyle: CSSProperties | undefined;
  /** While a cancelled fill runs back: where it stood when the hold ended, 0 to 1. */
  back: number | null;
  props: ApproveHoldProps;
}

export interface ApproveHoldOptions {
  /** Whether a hold may start and finish: false while an answer is in flight or the card takes none. */
  enabled: boolean;
  /** The card's code as the button approves it (its digest): a new key cancels a hold and an arm. */
  resetKey: string;
  /** The yes. Runs once per finished hold, or on a key's second press. */
  onApprove: () => void;
}

/** The fill's share of the hold that has passed, 0 to 1: it grows from HOLD_FEEDBACK_DELAY_MS to APPROVE_HOLD_MS. */
function fillShare(downAt: number): number {
  const share = (Date.now() - downAt - HOLD_FEEDBACK_DELAY_MS) / (APPROVE_HOLD_MS - HOLD_FEEDBACK_DELAY_MS);
  return Math.min(1, Math.max(0, share));
}

/** How often the button's place on screen is looked at while a finger holds it. */
const SHIFT_LOOK_MS = 50;

/** The hold of three seconds on the yes to a trick's code. See the head of this file. */
export function useApproveHold({ enabled, resetKey, onApprove }: ApproveHoldOptions): ApproveHold {
  const approve = useRef(onApprove);
  const live = useRef(enabled);
  useLayoutEffect(() => {
    approve.current = onApprove;
    live.current = enabled;
  });
  // A hold belongs to the card state it began in: every change of `enabled` or `resetKey` bumps the epoch, and a
  // timer whose stamp is older approves nothing (the Stop's rule).
  const epoch = useRef(0);
  const stamp = useRef(-1);
  // The finger that holds, kept until it lifts or is cancelled; a second finger is not this one.
  const finger = useRef<number | null>(null);
  // Whether a hold is under way now: set by the finger's down, cleared by the yes and by every cancel.
  const active = useRef(false);
  const downAt = useRef(0);
  const from = useRef({ x: 0, y: 0 });
  const detach = useRef<(() => void) | null>(null);
  // Whether the click about to arrive was made by a pointer: the hold judged that press already.
  const pointerMade = useRef(false);
  const [pressing, setPressing] = useState(false);
  const [back, setBack] = useState<number | null>(null);
  const backTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { armed, tap, disarm } = useArm<"yes">();

  const unlisten = useCallback(() => {
    detach.current?.();
    detach.current = null;
  }, []);

  // The hold's end: the timer fired with the finger still down.
  const held = useCallback(() => {
    const ok = active.current && stamp.current === epoch.current && live.current;
    active.current = false;
    unlisten();
    setPressing(false);
    if (ok) approve.current();
  }, [unlisten]);

  const hold = useLongPress(enabled ? held : undefined, { delayMs: APPROVE_HOLD_MS });
  const holdRef = useRef(hold);
  useLayoutEffect(() => {
    holdRef.current = hold;
  });

  // Every way a hold ends with no yes. The fill runs back from where it stood.
  const cancel = useCallback(() => {
    if (!active.current) return;
    const share = fillShare(downAt.current);
    active.current = false;
    holdRef.current.onPointerCancel();
    unlisten();
    setPressing(false);
    clearTimeout(backTimer.current);
    if (share <= 0) {
      setBack(null);
      return;
    }
    setBack(share);
    backTimer.current = setTimeout(() => setBack(null), HOLD_BACK_MS);
  }, [unlisten]);

  // The page around the button while a finger holds it: a scroll, the page hidden, the window's focus lost, or the
  // button moving under the finger ends the hold.
  const listen = useCallback(
    (button: HTMLElement) => {
      unlisten();
      const start = button.getBoundingClientRect();
      const onScroll = () => cancel();
      const onHidden = () => {
        if (document.visibilityState === "hidden") cancel();
      };
      const onBlur = () => cancel();
      const look = setInterval(() => {
        const now = button.getBoundingClientRect();
        if (Math.abs(now.left - start.left) > APPROVE_SHIFT_PX || Math.abs(now.top - start.top) > APPROVE_SHIFT_PX) cancel();
      }, SHIFT_LOOK_MS);
      window.addEventListener("scroll", onScroll, true);
      document.addEventListener("visibilitychange", onHidden);
      window.addEventListener("blur", onBlur);
      detach.current = () => {
        clearInterval(look);
        window.removeEventListener("scroll", onScroll, true);
        document.removeEventListener("visibilitychange", onHidden);
        window.removeEventListener("blur", onBlur);
      };
    },
    [cancel, unlisten],
  );

  // A changed card (another digest), or one that takes no answer now, ends a hold and an arm.
  useEffect(() => {
    epoch.current += 1;
    cancel();
    disarm();
  }, [enabled, resetKey, cancel, disarm]);

  // The button leaving the page ends the hold: no listener and no timer outlives it.
  useEffect(
    () => () => {
      active.current = false;
      unlisten();
      clearTimeout(backTimer.current);
    },
    [unlisten],
  );

  /** The press of the finger that holds, ended by a lift, a leave or a cancel: a hold not yet done is cancelled. */
  const release = (event: PointerEvent<HTMLElement>, forward: (event: PointerEvent<HTMLElement>) => void) => {
    if (finger.current !== event.pointerId) return;
    finger.current = null;
    cancel();
    forward(event);
  };

  const props: ApproveHoldProps = {
    onPointerDown: (event) => {
      // A second finger while one holds, or any press on a card that takes no answer, does nothing.
      if (!enabled || finger.current !== null || event.button !== 0) return;
      pointerMade.current = true;
      finger.current = event.pointerId;
      active.current = true;
      stamp.current = epoch.current;
      downAt.current = Date.now();
      from.current = { x: event.clientX, y: event.clientY };
      clearTimeout(backTimer.current);
      setBack(null);
      setPressing(true);
      disarm();
      listen(event.currentTarget);
      hold.onPointerDown(event);
    },
    onPointerMove: (event) => {
      if (finger.current !== event.pointerId) return;
      hold.onPointerMove(event);
      if (Math.abs(event.clientX - from.current.x) > MOVE_CANCEL_PX || Math.abs(event.clientY - from.current.y) > MOVE_CANCEL_PX) cancel();
    },
    onPointerUp: (event) => release(event, hold.onPointerUp),
    onPointerLeave: (event) => release(event, hold.onPointerLeave),
    onPointerCancel: (event) => release(event, hold.onPointerCancel),
    // A phone's long-press raises `contextmenu` half a second in. It is no shortcut to the yes, only a menu to keep away.
    onContextMenu: (event) => event.preventDefault(),
    onClickCapture: hold.onClickCapture,
    onClick: (event) => {
      const byPointer = pointerMade.current && event.detail !== 0;
      pointerMade.current = false;
      // A pointer's press was a hold, or a lift too early, and the hold judged it already.
      if (byPointer || !enabled) return;
      // A key or an assistive click: the first press arms; one inside the dwell is the same press landing twice.
      if (tap("yes") !== "fire") return;
      approve.current();
    },
    onKeyDown: ignoreHeldEnter,
    "data-holding": hold["data-holding"],
  };

  const filling = hold["data-holding"] !== undefined;
  const phase: ApproveHoldPhase = armed === "yes" ? "armed" : filling ? "filling" : pressing ? "pressing" : "rest";
  return { phase, fillStyle: filling ? hold.style : undefined, back, props };
}
