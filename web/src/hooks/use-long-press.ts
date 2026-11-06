import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { buzz } from "@/lib/haptics";

// Hold a pill this long before the press counts as a long-press. Long enough that a tap or a scroll
// fling never trips it, short enough to feel intentional rather than sluggish.
const LONG_PRESS_MS = 450;
// Movement past this (px, from the press origin) cancels the pending long-press — that's a scroll or
// a drag, not a hold. Keeps the strip's horizontal scroll working: a sideways pan cancels the timer.
// Sized for a thumb: finger jitter during a deliberate hold is easily 10–15px, so a stricter bound
// cancelled real holds on a phone; a scroll still moves well past this before the timer would fire.
const MOVE_CANCEL_PX = 16;
// The press starts to SHOW only after this. A plain tap lifts well before it, so a tap never
// flashes the hold's look; a finger still down past it is a hold in the making, and from here to the
// hold's own mark the element eases toward "pressed" (`data-holding`, index.css `THE HOLD, SHOWN`).
export const HOLD_FEEDBACK_DELAY_MS = 150;
// A press that moved further than this is no tap. Stricter than the hold's bound: a tap is short, so a thumb has no
// time to wander, and a scroll that starts on the element has passed 8px before the finger lifts.
const TAP_MOVE_PX = 8;

interface LongPressOptions {
  delayMs?: number;
  moveTolerance?: number;
  // Runs from the trusted pointer/contextmenu event that ends a completed hold. Use this for browser
  // APIs (notably opening a phone keyboard) that reject calls made from the hold timer itself.
  onReleaseAfterLongPress?: () => void;
  /**
   * Whether a hold in the making shows (`data-holding`, index.css `THE HOLD, SHOWN`). Default true. `"touch"` shows it
   * for a touch or pen press only, and a mouse's hold stays silent: a chat block, whose text a mouse still selects
   * (components/stream-block.tsx).
   */
  showHold?: boolean | "touch";
  /**
   * Runs on the `pointerup` that ends a TAP: a primary press that did not become a hold, did not move past
   * `tapMoveTolerance` and was not cancelled. The movement is judged by the same gate the hold's is, so a scroll that
   * starts on the element is neither a hold nor a tap. The handler gets the `pointerup` and judges its target itself.
   * Like the hold, it is armed only while `onLongPress` is set.
   */
  onTap?: (event: ReactPointerEvent) => void;
  /** How far a tap may move, in px from the press origin, and still be a tap. Default {@link TAP_MOVE_PX}. */
  tapMoveTolerance?: number;
}

/**
 * Pointer-based long-press. Spread the returned handlers onto the element you want to long-press
 * (`<button {...useLongPress(open)} />`). `pointerdown` arms a timer; movement past `moveTolerance`,
 * or `pointerup`/`pointercancel`/`pointerleave`, cancels it. When it fires we set a one-shot flag and
 * suppress the click that follows on release (via a capture-phase `onClickCapture` that stops the
 * event before the element's own `onClick`) — so a long-press opens the sheet WITHOUT also navigating.
 *
 * Mobile robustness: the naive timer alone failed on real phones. iOS Safari fires the text-selection
 * loupe / touch callout and then `pointercancel`, killing the timer before it fires; Android Chrome
 * raises `contextmenu` at the end of a long-press. So callers must ALSO set `-webkit-touch-callout:
 * none` + `select-none` on the element (stops the iOS gestures that cause the premature cancel), and
 * we treat `contextmenu` as an ALTERNATIVE trigger here (`onContextMenu`) — it opens the sheet even
 * when a native cancel beat the hold timer, and preventDefaults the native menu. `fire` is idempotent
 * per gesture so the timer and the contextmenu path can never double-open.
 *
 * Deliberately does NOT set `touch-action: none`: the element stays scrollable, and a scroll gesture
 * cancels the timer through the move/cancel path instead. Pass `onLongPress: undefined` to disable
 * (the handlers become inert) so a caller can conditionally opt out without breaking the hook rules.
 *
 * THE HOLD, SHOWN (M38/02). A hold had no look until it fired, so a thumb could not tell a hold in
 * progress from a dead tap, and nothing on screen said a hold was there to find. So the returned
 * props also carry `data-holding` from {@link HOLD_FEEDBACK_DELAY_MS} after `pointerdown` until the
 * hold fires or is cancelled, and an `animationDuration` that stretches index.css's fill over exactly
 * the time left to the hold's mark. Every surface that spreads the props gets it with no work of its
 * own: dashboard rows, pane pills, workspace and tab chips. The look is a transform and a tint, never
 * a box change (DESIGN.md §2). It ends AT ONCE, on the fire as on every cancel (movement past the
 * tolerance, `pointerup`, `pointerleave`, `pointercancel`, which is also how a touch scroll arrives),
 * because the one `clear` that stops the timer drops it. The fire gives one haptic tick
 * (`lib/haptics.ts`): the press registered, before the sheet has drawn a pixel.
 */
export function useLongPress(
  onLongPress: (() => void) | undefined,
  {
    delayMs = LONG_PRESS_MS,
    moveTolerance = MOVE_CANCEL_PX,
    onReleaseAfterLongPress,
    showHold = true,
    onTap,
    tapMoveTolerance = TAP_MOVE_PX,
  }: LongPressOptions = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  // The origin of a press that may still end as a tap. Dropped by movement past `tapMoveTolerance`, a cancel or a
  // leave; kept apart from `startPos` because the hold's own bound is looser and a fired hold clears that one.
  const tapFrom = useRef<{ x: number; y: number } | null>(null);
  // A long-press fired on the in-progress gesture → suppress the ensuing click so it doesn't navigate.
  const fired = useRef(false);
  const releaseHandled = useRef(false);
  // The hold's look (`data-holding`): armed by its own shorter timer, dropped by `clear`.
  const [holding, setHolding] = useState(false);
  const feedback = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (feedback.current !== null) {
      clearTimeout(feedback.current);
      feedback.current = null;
    }
    startPos.current = null;
    setHolding(false);
  }, []);

  // Drop a pending timer if the element unmounts mid-hold.
  useEffect(() => clear, [clear]);

  // Open the sheet exactly once per gesture. Shared by the hold timer and the contextmenu trigger, so
  // whichever wins the race opens it and the other is a no-op. Also disarms the timer so a pending
  // hold can't re-open after contextmenu already did.
  const fire = useCallback(() => {
    if (!onLongPress || fired.current) return;
    fired.current = true;
    // `clear` drops the look too: it ends the moment the hold counts, not when the finger lifts.
    clear();
    buzz();
    onLongPress();
  }, [onLongPress, clear]);

  const finish = useCallback(() => {
    if (!fired.current || releaseHandled.current) return;
    releaseHandled.current = true;
    onReleaseAfterLongPress?.();
  }, [onReleaseAfterLongPress]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!onLongPress) return;
      // A fresh press starts a fresh gesture: clear the one-shot flag FIRST, before the button check,
      // so a repeat that reaches us via `contextmenu` (desktop right-click's pointerdown is button 2)
      // can open again rather than being blocked by the previous gesture's still-set flag.
      fired.current = false;
      releaseHandled.current = false;
      // Primary pointer only (0 for touch/pen too) — ignore right-click / secondary contacts for the
      // hold timer (right-click still opens via onContextMenu below).
      if (e.button !== 0) return;
      startPos.current = { x: e.clientX, y: e.clientY };
      tapFrom.current = onTap === undefined ? null : { x: e.clientX, y: e.clientY };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(fire, delayMs);
      if (feedback.current !== null) clearTimeout(feedback.current);
      const show = showHold === "touch" ? e.pointerType === "touch" || e.pointerType === "pen" : showHold;
      feedback.current =
        show && delayMs > HOLD_FEEDBACK_DELAY_MS ? setTimeout(() => setHolding(true), HOLD_FEEDBACK_DELAY_MS) : null;
    },
    [onLongPress, delayMs, fire, showHold, onTap],
  );

  // THE ONE MOVEMENT GATE. A press that wanders past a bound is a scroll or a drag: past the hold's bound it is no
  // hold, past the tap's it is no tap.
  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (movedPast(tapFrom.current, e, tapMoveTolerance)) tapFrom.current = null;
      if (movedPast(startPos.current, e, moveTolerance)) clear();
    },
    [clear, moveTolerance, tapMoveTolerance],
  );

  const finishPointerGesture = useCallback(
    (e?: ReactPointerEvent) => {
      tapFrom.current = null;
      clear();
      if (!fired.current) return;
      // Do not let the button's pointer-up default action reclaim focus after the completion callback
      // moves it elsewhere (the exact ordering that otherwise closes a newly-opened phone keyboard).
      e?.preventDefault();
      finish();
    },
    [clear, finish],
  );

  // The lift that ends a press: a tap when the press is still a candidate and no hold fired on it.
  const onPointerUp = useCallback(
    (e?: ReactPointerEvent) => {
      const tapped = tapFrom.current !== null && !fired.current;
      finishPointerGesture(e);
      if (tapped && e !== undefined) onTap?.(e);
    },
    [finishPointerGesture, onTap],
  );

  // Android Chrome raises `contextmenu` at the end of a long-press (desktop does on right-click). When
  // actions are enabled we (1) preventDefault so the native menu never hijacks the gesture, and (2)
  // trigger the sheet — this is the fallback path when a native `pointercancel` already killed the
  // hold timer (the exact mobile failure this fixes). `fire` is idempotent, so if our timer already
  // opened the sheet this only suppresses the native menu.
  const onContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      if (!onLongPress) return;
      e.preventDefault();
      fire();
      finish();
    },
    [onLongPress, fire, finish],
  );

  const onClickCapture = useCallback(
    (e: ReactMouseEvent) => {
      if (!fired.current) return;
      finish();
      fired.current = false;
      releaseHandled.current = false;
      // Capture phase runs before the element's own bubble-phase onClick; stopping here cancels it.
      e.preventDefault();
      e.stopPropagation();
    },
    [finish],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave: finishPointerGesture,
    onPointerCancel: finishPointerGesture,
    onContextMenu,
    onClickCapture,
    // Present (as `""`) only while held, so a resting element carries neither attribute nor style.
    "data-holding": holding ? "" : undefined,
    // The fill runs over the time LEFT to the hold's mark, so it reaches "pressed" as the hold fires.
    style: holding ? { animationDuration: `${delayMs - HOLD_FEEDBACK_DELAY_MS}ms` } : undefined,
  };
}

/** Whether the pointer stands further than `tolerance` px from `origin` on either axis. No origin: no press to judge. */
function movedPast(origin: { x: number; y: number } | null, e: ReactPointerEvent, tolerance: number): boolean {
  if (origin === null) return false;
  return Math.abs(e.clientX - origin.x) > tolerance || Math.abs(e.clientY - origin.y) > tolerance;
}
