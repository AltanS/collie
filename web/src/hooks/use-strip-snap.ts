import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import { nearestColumnStart } from "@/lib/strip-snap";

// A wheel gesture is over when no wheel or scroll event has arrived for this long. A trackpad's
// inertia keeps firing events, so it is part of the gesture and ends it only when it dies down.
const IDLE_MS = 120;
// Already this close to a start: the browser's own snap got there first, so there is nothing to move.
const AT_START_PX = 1;

interface StripSnapOptions {
  /** The scroll position of every column's left edge, read when a gesture ends. */
  columnStarts: () => number[];
  /** Runs once per gesture, after the strip has stopped at its final position. */
  onSettled?: (scrollLeft: number) => void;
  /** Settle with no animation. */
  reducedMotion: boolean;
}

/**
 * Settles a wheel or trackpad scroll of the strip on a column's left edge, like niri. CSS
 * `scroll-snap-type: x mandatory` already does that for touch and for keyboard scrolls, so touch
 * is left alone here. The wheel is where the browser's snap is too eager or too late, so this
 * waits for the gesture to end and then eases to the nearest start. If the position already is a
 * start, nothing moves and `onSettled` still runs. Shift plus a vertical wheel scrolls sideways.
 *
 * `stripRef` is a ref object or the element itself, so a state-held callback ref works too.
 */
export function useStripSnap(stripRef: RefObject<HTMLElement | null> | HTMLElement | null, options: StripSnapOptions) {
  // The latest options, read when a gesture ends, so a new closure each render never re-subscribes.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const el = stripRef !== null && "current" in stripRef ? stripRef.current : stripRef;
    if (el === null) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    // A wheel gesture, or our own scroll to a start, is under way: scroll events then extend the wait.
    let busy = false;
    // Our own scroll to a start is under way: the wait is for it to stop, not for the wheel.
    let settling = false;
    let touching = false;
    // Where Shift plus the wheel has taken the strip. Read back, a column snap may have pulled the
    // position to a start already, so the gesture's own sum is what the end settles from.
    let shiftTarget: number | null = null;

    const settled = () => {
      busy = false;
      settling = false;
      shiftTarget = null;
      latest.current.onSettled?.(el.scrollLeft);
    };

    const end = () => {
      timer = undefined;
      if (settling) return settled();
      const { columnStarts, reducedMotion } = latest.current;
      const target = nearestColumnStart(shiftTarget ?? el.scrollLeft, columnStarts());
      shiftTarget = null;
      if (Math.abs(el.scrollLeft - target) <= AT_START_PX) return settled();
      settling = true;
      el.scrollTo({ left: target, behavior: reducedMotion ? "auto" : "smooth" });
      // No scroll event may follow (a clamped or instant scroll), so the wait starts here too.
      timer = setTimeout(end, IDLE_MS);
    };

    const extend = () => {
      clearTimeout(timer);
      timer = setTimeout(end, IDLE_MS);
    };

    const onWheel = (e: WheelEvent) => {
      // A plain vertical turn (a column's own scroller) never moves the strip; only a sideways or
      // a Shift one does.
      if (touching || (!e.shiftKey && e.deltaX === 0)) return;
      // A wheel turn during our own ease is the person taking over; the gesture starts afresh.
      settling = false;
      busy = true;
      if (e.shiftKey && e.deltaX === 0 && e.deltaY !== 0) {
        e.preventDefault();
        const max = el.scrollWidth - el.clientWidth;
        shiftTarget = Math.min(Math.max((shiftTarget ?? el.scrollLeft) + e.deltaY, 0), max);
        el.scrollTo({ left: shiftTarget, behavior: "auto" });
      }
      extend();
    };
    const onScroll = () => {
      if (busy) extend();
    };

    // Touch scrolls with native momentum and CSS snap. Drop a pending wheel wait and ignore wheels
    // while a finger is down (a touch screen with a pen or mouse can send both).
    const touchStart = () => {
      touching = true;
      clearTimeout(timer);
      timer = undefined;
      busy = false;
      settling = false;
      shiftTarget = null;
    };
    const touchEnd = () => {
      touching = false;
    };
    const pointerDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") touchStart();
    };
    const pointerUp = (e: PointerEvent) => {
      if (e.pointerType === "touch") touchEnd();
    };

    // Not passive: Shift plus the wheel is taken over above and needs preventDefault. Every other
    // wheel event leaves it alone, so the browser's own scrolling is not held up by the listener.
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchend", touchEnd, { passive: true });
    el.addEventListener("touchcancel", touchEnd, { passive: true });
    el.addEventListener("pointerdown", pointerDown, { passive: true });
    el.addEventListener("pointerup", pointerUp, { passive: true });
    el.addEventListener("pointercancel", pointerUp, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchend", touchEnd);
      el.removeEventListener("touchcancel", touchEnd);
      el.removeEventListener("pointerdown", pointerDown);
      el.removeEventListener("pointerup", pointerUp);
      el.removeEventListener("pointercancel", pointerUp);
    };
  }, [stripRef]);
}
