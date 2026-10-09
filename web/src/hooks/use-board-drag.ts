import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Pointer drag for the key board editor (M48 spec 03). No library: a key is picked up by a pointer
// move past a small slop, a copy of it follows the pointer, and a release drops the key's whole area
// where the pointer is. The grab point is kept: a three-wide key picked up by its right end lands with
// its right end under the finger. What the drop does (move, swap, refuse) is the board model's call,
// not this hook's; the hook only says which cell the key's top-left corner would sit on. Touch works
// because the KEYS carry `touch-none` and nothing else does, so a finger on a key drags and a finger
// on the gaps still scrolls the sheet.
//
// A move under DRAG_SLOP is a tap: the key's own onClick runs. After a real drag the browser still
// sends a click to the key; `justDragged()` is how that click knows to stand down.
//
// The listeners sit on `window`, not on the key: React re-orders the dragged DOM node as the cells
// change, and a listener on a node that moves is a listener that goes quiet mid-drag.

const DRAG_SLOP = 6;
/** How long after a drop a click is still the drag's own. */
const QUIET_MS = 300;

export interface Ghost {
  /** Position of the lifted copy, in the board box's own pixels. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface Lift {
  readonly from: number;
  /** The cell the key's top-left corner would sit on, or null while the pointer is off the board. */
  readonly over: number | null;
  readonly ghost: Ghost;
}

/** The board's columns, to turn a cell number into a column and a row. */
const COLS = 7;

/**
 * The sheet closes when pulled down from its top, and it listens for `touchstart` on its panel to
 * know where the pull began. A finger that starts on a KEY is a drag, not a pull, so the key stops its
 * `touchstart` here, before the panel hears it. A native listener, because the panel's is native too:
 * React's `stopPropagation` runs only after the whole native path has finished.
 */
export function shieldFromSheetPull(el: HTMLElement | null): void {
  el?.addEventListener("touchstart", stop, { passive: true });
}

function stop(e: Event): void {
  e.stopPropagation();
}

function cellAt(box: HTMLElement, x: number, y: number): number | null {
  for (const el of box.querySelectorAll<HTMLElement>("[data-cell]")) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(el.dataset.cell);
  }
  return null;
}

export interface BoardDragOptions {
  /** A key was dropped with its top-left corner on `to`. Never called with `to === from`. */
  readonly onDrop: (from: number, to: number) => void;
  /** Where the key's top-left corner is, as a cell number, for a corner at `col`, `row` (which may lie off the board). The board pulls it back inside its edges. */
  readonly anchorFor: (from: number, col: number, row: number) => number;
}

export function useBoardDrag(options: BoardDragOptions) {
  const boxRef = useRef<HTMLDivElement>(null);
  const live = useRef(options);
  live.current = options;
  const quietUntil = useRef(0);
  const [lift, setLift] = useState<Lift | null>(null);

  const begin = (e: ReactPointerEvent<HTMLElement>, from: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const box = boxRef.current;
    if (box === null) return;
    const key = e.currentTarget.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const pointer = e.pointerId;
    let active = false;
    // Which cell of the key the finger is on: the offset from the anchor to the grab point.
    const grabbed = cellAt(box, startX, startY) ?? from;
    const grabCol = (grabbed % COLS) - (from % COLS);
    const grabRow = Math.floor(grabbed / COLS) - Math.floor(from / COLS);
    const target = (x: number, y: number): number | null => {
      const over = cellAt(box, x, y);
      if (over === null) return null;
      return live.current.anchorFor(from, (over % COLS) - grabCol, Math.floor(over / COLS) - grabRow);
    };

    const place = (x: number, y: number): Lift => {
      const b = box.getBoundingClientRect();
      const over = target(x, y);
      return {
        from,
        over: over === from ? null : over,
        ghost: { x: x - (startX - key.left) - b.left, y: y - (startY - key.top) - b.top, w: key.width, h: key.height },
      };
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_SLOP) return;
      active = true;
      setLift(place(ev.clientX, ev.clientY));
    };
    const finish = (ev: PointerEvent, cancelled: boolean) => {
      if (ev.pointerId !== pointer) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (!active) return;
      quietUntil.current = performance.now() + QUIET_MS;
      const to = cancelled ? null : target(ev.clientX, ev.clientY);
      if (to !== null && to !== from) live.current.onDrop(from, to);
      setLift(null);
    };
    const onUp = (ev: PointerEvent) => finish(ev, false);
    const onCancel = (ev: PointerEvent) => finish(ev, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  return { boxRef, lift, begin, justDragged: () => performance.now() < quietUntil.current };
}
