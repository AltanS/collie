import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

/** A press on a grip that has become a move: where the row was, and where a release would put it. */
export interface GripDrag {
  from: number;
  to: number;
}

interface LiveDrag {
  pointerId: number;
  from: number;
  pressY: number;
  y: number;
  /** Set once the pointer leaves the press by more than SLOP: a press that stays there moves nothing. */
  travelled: boolean;
  frame: number;
}

/** How close to the sheet's edge the pointer starts scrolling it, in px. */
const EDGE = 56;
/** The motion that says "further that way", from a press already inside an edge's band. */
const SLOP = 4;
const MAX_STEP = 14;

/** Marks the rows that can move and be moved between. */
export const DRAG_ROW = "data-drag-row";

/** The nearest ancestor that scrolls: a sheet's dialog role and its scroll sit on different elements. */
function scrollerOf(element: Element): Element | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    if (/auto|scroll/u.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

function dragRows(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(`[${DRAG_ROW}]`)];
}

/** The place a release at `y` gives the row: one past each other row whose middle lies above `y`. */
function placeAt(list: HTMLElement, { from, y, travelled }: LiveDrag): number {
  if (!travelled) return from;
  return dragRows(list).filter((row, index) => {
    if (index === from) return false;
    const rect = row.getBoundingClientRect();
    return rect.top + rect.height / 2 < y;
  }).length;
}

/**
 * Scrolls the sheet while the pointer is in an edge's band. A press inside a band does not count until
 * it moves further that way: the last row in view starts there, and carrying it up must not scroll down.
 */
function scrollAtEdge(scroller: Element, drag: LiveDrag): void {
  const { top, bottom } = scroller.getBoundingClientRect();
  const below = drag.y - Math.max(bottom - EDGE, drag.pressY + SLOP);
  const above = Math.min(top + EDGE, drag.pressY - SLOP) - drag.y;
  if (below > 0) scroller.scrollTop += Math.ceil((Math.min(below, EDGE) / EDGE) * MAX_STEP);
  else if (above > 0) scroller.scrollTop -= Math.ceil((Math.min(above, EDGE) / EDGE) * MAX_STEP);
}

/**
 * Drag a row of `list` by its grip, with a mouse or a finger. The rows stay where they are until the
 * release: moving the grip's node in the document would end its pointer capture.
 */
export function useGripDrag(list: RefObject<HTMLElement | null>, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<GripDrag | null>(null);
  const live = useRef<LiveDrag | null>(null);

  const stop = useCallback(() => {
    if (live.current !== null) cancelAnimationFrame(live.current.frame);
    live.current = null;
    setDrag(null);
  }, []);
  useEffect(() => stop, [stop]);

  const place = useCallback((current: LiveDrag) => {
    const element = list.current;
    if (element === null) return;
    const to = placeAt(element, current);
    setDrag((was) => (was?.to === to ? was : { from: current.from, to }));
  }, [list]);

  const tick = useCallback(() => {
    const current = live.current;
    const element = list.current;
    if (current === null || element === null) return;
    const scroller = scrollerOf(element);
    if (scroller !== null) scrollAtEdge(scroller, current);
    place(current);
    current.frame = requestAnimationFrame(tick);
  }, [list, place]);

  const gripProps = (from: number) => ({
    // A sheet takes a pull from its top as a close, and this same finger is carrying a row.
    "data-sheet-no-drag": true,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (live.current !== null || event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const pressY = event.clientY;
      live.current = { pointerId: event.pointerId, from, pressY, y: pressY, travelled: false, frame: requestAnimationFrame(tick) };
      setDrag({ from, to: from });
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = live.current;
      if (current?.pointerId !== event.pointerId) return;
      current.y = event.clientY;
      current.travelled ||= Math.abs(current.y - current.pressY) > SLOP;
      place(current);
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const current = live.current;
      const element = list.current;
      if (current?.pointerId !== event.pointerId) return;
      current.y = event.clientY;
      const to = element === null ? current.from : placeAt(element, current);
      stop();
      if (to !== current.from) onMove(current.from, to);
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (live.current?.pointerId === event.pointerId) stop();
    },
  });

  return { drag, gripProps };
}
