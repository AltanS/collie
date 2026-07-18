import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

// Hold a pill this long before the press counts as a long-press. Long enough that a tap or a scroll
// fling never trips it, short enough to feel intentional rather than sluggish.
const LONG_PRESS_MS = 450;
// Movement past this (px, from the press origin) cancels the pending long-press — that's a scroll or
// a drag, not a hold. Keeps the strip's horizontal scroll working: a sideways pan cancels the timer.
const MOVE_CANCEL_PX = 10;

interface LongPressOptions {
  delayMs?: number;
  moveTolerance?: number;
}

/**
 * Pointer-based long-press. Spread the returned handlers onto the element you want to long-press
 * (`<button {...useLongPress(open)} />`). `pointerdown` arms a timer; movement past `moveTolerance`,
 * or `pointerup`/`pointercancel`/`pointerleave`, cancels it. When it fires we set a one-shot flag and
 * suppress the click that follows on release (via a capture-phase `onClickCapture` that stops the
 * event before the element's own `onClick`) — so a long-press opens the sheet WITHOUT also navigating.
 *
 * Deliberately does NOT set `touch-action: none`: the element stays scrollable, and a scroll gesture
 * cancels the timer through the move/cancel path instead. Pass `onLongPress: undefined` to disable
 * (the handlers become inert) so a caller can conditionally opt out without breaking the hook rules.
 */
export function useLongPress(
  onLongPress: (() => void) | undefined,
  { delayMs = LONG_PRESS_MS, moveTolerance = MOVE_CANCEL_PX }: LongPressOptions = {},
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  // A long-press fired on the in-progress gesture → suppress the ensuing click so it doesn't navigate.
  const fired = useRef(false);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startPos.current = null;
  }, []);

  // Drop a pending timer if the element unmounts mid-hold.
  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!onLongPress) return;
      // Primary pointer only (0 for touch/pen too) — ignore right-click / secondary contacts.
      if (e.button !== 0) return;
      fired.current = false;
      startPos.current = { x: e.clientX, y: e.clientY };
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        startPos.current = null;
        fired.current = true;
        onLongPress();
      }, delayMs);
    },
    [onLongPress, delayMs],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const s = startPos.current;
      if (!s) return;
      if (Math.abs(e.clientX - s.x) > moveTolerance || Math.abs(e.clientY - s.y) > moveTolerance) {
        clear();
      }
    },
    [clear, moveTolerance],
  );

  const onClickCapture = useCallback((e: ReactMouseEvent) => {
    if (!fired.current) return;
    fired.current = false;
    // Capture phase runs before the element's own bubble-phase onClick; stopping here cancels it.
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onClickCapture,
  };
}
