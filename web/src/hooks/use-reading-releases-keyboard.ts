import { useEffect } from "react";

// A FINGER SCROLL UP IN THE CHAT CLOSES THE KEYBOARD, THE BOX STAYS (Altan, 2026-11-07: "chatgpt when
// scrolling up hides the keyboard, I think this makes sense, the collie input stays open though").
//
// While the reply field has focus, a one-finger drag that moves the reading area's content down (the
// person goes back to older text) blurs the field, so the soft keyboard closes. The composer keeps its
// draft, its shape and its buttons: the box opens on content, never on focus. The next tap on the
// field opens the keyboard again, as any tap does.
//
// ONE PAIR OF LISTENERS ON THE READING AREA, never one per message: the area holds both bodies, the
// mirror and the Chat stream, so either is covered, and the listeners are passive, so the scroll
// itself is never held up. Only touch events count, so a desktop pointer, a wheel, a programmatic
// scroll (a send that snaps to the tail, a pin, find) and the scroll the keyboard's own resize causes
// never release anything. A second finger cancels the gesture: two fingers are the pane switch.

/** The upward reading travel, in px of finger movement, before the keyboard is released. */
export const RELEASE_TRAVEL_PX = 24;

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * True when a finger that went down at `start` and now stands at `now` has dragged the content down
 * (towards older text) by at least `travel` px, and more down than sideways, so a table panned
 * sideways does not count.
 */
export function readsOlder(start: Point, now: Point, travel = RELEASE_TRAVEL_PX): boolean {
  const down = now.y - start.y;
  return down >= travel && down > Math.abs(now.x - start.x);
}

/** Blurs the reply field when it holds the focus. Nothing else in the page is touched. */
function releaseField(): void {
  const field = document.activeElement;
  if (field instanceof HTMLTextAreaElement && field.dataset.slot === "chat-input") field.blur();
}

function onlyTouch(event: TouchEvent): Point | null {
  if (event.touches.length !== 1) return null;
  const touch = event.touches[0];
  return touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
}

/** Releases the keyboard on a finger scroll up inside `reading` (see the header). */
export function useReadingReleasesKeyboard(reading: HTMLElement | null): void {
  useEffect(() => {
    if (reading === null) return;
    let start: Point | null = null;
    const onStart = (event: TouchEvent) => {
      start = onlyTouch(event);
    };
    const onMove = (event: TouchEvent) => {
      const now = onlyTouch(event);
      if (start === null || now === null) {
        start = null;
        return;
      }
      if (!readsOlder(start, now)) return;
      // Once per gesture: the rest of this drag is reading.
      start = null;
      releaseField();
    };
    const onEnd = () => {
      start = null;
    };
    const passive = { passive: true } as const;
    reading.addEventListener("touchstart", onStart, passive);
    reading.addEventListener("touchmove", onMove, passive);
    reading.addEventListener("touchend", onEnd, passive);
    reading.addEventListener("touchcancel", onEnd, passive);
    return () => {
      reading.removeEventListener("touchstart", onStart);
      reading.removeEventListener("touchmove", onMove);
      reading.removeEventListener("touchend", onEnd);
      reading.removeEventListener("touchcancel", onEnd);
    };
  }, [reading]);
}
