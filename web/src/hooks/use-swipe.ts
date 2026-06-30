import { useRef } from "react";
import type { TouchEvent } from "react";

// Min vertical travel (px) before an upward drag counts as a swipe — small enough to feel light,
// large enough that a tap or scroll jitter never trips it.
const SWIPE_THRESHOLD = 36;

/**
 * Pure swipe-up test: a dominant upward movement past the threshold. `dy` is end − start, so an
 * upward fling is negative. Horizontal-dominant moves (|dx| ≥ |dy|) are rejected so a sloppy
 * sideways drag never fires. Exported on its own so the decision logic is unit-testable.
 */
export function isSwipeUp(dx: number, dy: number, threshold = SWIPE_THRESHOLD): boolean {
  return dy < -threshold && Math.abs(dy) > Math.abs(dx);
}

/**
 * Touch handlers that fire `onSwipeUp` on an upward fling. Spread the result onto the element you
 * want to swipe (`<button {...useSwipeUp(open)} />`). We only read the start/end points — no
 * per-frame tracking — so it's cheap and never fights the browser's own scrolling elsewhere.
 */
export function useSwipeUp(onSwipeUp: () => void, threshold = SWIPE_THRESHOLD) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      if (!t) return;
      if (isSwipeUp(t.clientX - s.x, t.clientY - s.y, threshold)) onSwipeUp();
    },
  };
}
