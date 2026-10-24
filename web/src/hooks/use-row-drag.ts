import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { buzz } from "@/lib/haptics";
import { HOLD_FEEDBACK_DELAY_MS } from "@/hooks/use-long-press";

// The gestures a pane row takes on a large screen (ADR 0120): a long-press, or a right-click for a
// mouse, opens the row's menu ("Open here", "Open beside"), and a drag carries the row into the strip
// of columns. Pointer Events only, so touch and mouse share one path.
//
// DELEGATED. The rows belong to the real `ThreadSidebar` and to the rail, which take only a tap, so
// the handlers go on a host element around the list and read the row off the event target: any
// element carrying `data-pane-key`. Nothing in the list knows about the gestures.
//
// WHY A TOUCH DRAG NEEDS A SHORT HOLD FIRST. The list scrolls vertically, and a finger that moves at
// once is a scroll. So on touch a row arms for a drag only after a short hold; a finger that moves
// earlier is left to the browser. The armed hold turns `touchmove` into a preventDefault, which is
// what stops the list scrolling under the drag. A mouse has no such conflict and drags after a few
// pixels. A hold that never moves reaches the long-press mark and opens the menu instead.

/** Same mark as hooks/use-long-press.ts. */
const LONG_PRESS_MS = 450;
/** A touch row is armed for a drag after this hold, before the long-press mark. */
const TOUCH_ARM_MS = 220;
const MOUSE_DRAG_PX = 6;
const TOUCH_SCROLL_PX = 10;
/** How often the strip scrolls at its edge while a drag holds there. */
const EDGE_TICK_MS = 16;

/** Where a drop would land, in the strip's own scroll coordinates. */
export interface DropTarget {
  readonly index: number;
  /** The boundary's x inside the strip's scroll content, for the drop bar. */
  readonly markerX: number;
}

export interface RowDrag {
  readonly key: string;
  /** Pointer position in client px, for the dragged row's ghost. */
  readonly x: number;
  readonly y: number;
  /** Where the drop would land, or null while the pointer is outside the strip. */
  readonly drop: DropTarget | null;
}

interface Options {
  onMenu: (rowKey: string) => void;
  /** Where in the strip a client point would drop; null outside the strip. */
  locate: (clientX: number, clientY: number) => DropTarget | null;
  onDrop: (rowKey: string, index: number) => void;
  /** Called on a short beat while dragging, so the strip can scroll at its edges. */
  edgeScroll: (clientX: number, clientY: number) => void;
}

interface Gesture {
  pointerId: number;
  key: string;
  row: HTMLElement;
  touch: boolean;
  startX: number;
  startY: number;
  armed: boolean;
  dragging: boolean;
  longTimer: ReturnType<typeof setTimeout> | null;
  armTimer: ReturnType<typeof setTimeout> | null;
  shownTimer: ReturnType<typeof setTimeout> | null;
}

/** The row a pointer target stands for: the nearest element with `data-pane-key`. */
function rowOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>("[data-pane-key]");
}

export function useRowDrag(options: Options) {
  const opts = useRef(options);
  opts.current = options;
  const gesture = useRef<Gesture | null>(null);
  const armedRef = useRef(false);
  const suppressClick = useRef(false);
  const lastPoint = useRef({ x: 0, y: 0 });
  const [drag, setDrag] = useState<RowDrag | null>(null);

  const stop = useCallback(() => {
    const g = gesture.current;
    if (g === null) return;
    if (g.longTimer !== null) clearTimeout(g.longTimer);
    if (g.armTimer !== null) clearTimeout(g.armTimer);
    if (g.shownTimer !== null) clearTimeout(g.shownTimer);
    delete g.row.dataset.holding;
    g.row.style.removeProperty("animation-duration");
    if (g.row.hasPointerCapture?.(g.pointerId) === true) g.row.releasePointerCapture(g.pointerId);
    gesture.current = null;
    armedRef.current = false;
    setDrag(null);
  }, []);

  useEffect(() => stop, [stop]);

  // A touchmove must be non-passive to be allowed to stop the list scrolling, and React registers
  // its own touch listeners passive, so this one is attached by hand. It acts only while armed.
  useEffect(() => {
    const onTouchMove = (e: TouchEvent) => {
      if (armedRef.current && e.cancelable) e.preventDefault();
    };
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => document.removeEventListener("touchmove", onTouchMove);
  }, []);

  // While dragging, the strip scrolls at its edges even if the pointer holds still.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const id = window.setInterval(() => opts.current.edgeScroll(lastPoint.current.x, lastPoint.current.y), EDGE_TICK_MS);
    return () => window.clearInterval(id);
  }, [dragging]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const row = rowOf(e.target);
      const key = row?.dataset.paneKey;
      if (row === null || key === undefined) return;
      stop();
      suppressClick.current = false;
      const touch = e.pointerType !== "mouse";
      const g: Gesture = {
        pointerId: e.pointerId,
        key,
        row,
        touch,
        startX: e.clientX,
        startY: e.clientY,
        armed: !touch,
        dragging: false,
        longTimer: null,
        armTimer: null,
        shownTimer: null,
      };
      lastPoint.current = { x: e.clientX, y: e.clientY };
      // The hold shows itself from one place (DESIGN.md §2, "A hold shows itself in paint").
      g.shownTimer = setTimeout(() => {
        row.dataset.holding = "";
        row.style.animationDuration = `${LONG_PRESS_MS - HOLD_FEEDBACK_DELAY_MS}ms`;
      }, HOLD_FEEDBACK_DELAY_MS);
      g.longTimer = setTimeout(() => {
        suppressClick.current = true;
        stop();
        buzz();
        opts.current.onMenu(key);
      }, LONG_PRESS_MS);
      if (touch) {
        g.armTimer = setTimeout(() => {
          g.armed = true;
          armedRef.current = true;
        }, TOUCH_ARM_MS);
      }
      gesture.current = g;
    },
    [stop],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (g === null || e.pointerId !== g.pointerId) return;
      lastPoint.current = { x: e.clientX, y: e.clientY };
      const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (!g.dragging) {
        // A touch that moves before it is armed is a scroll. Leave it to the browser.
        if (g.touch && !g.armed && dist > TOUCH_SCROLL_PX) {
          suppressClick.current = false;
          stop();
          return;
        }
        if (!g.armed || dist <= MOUSE_DRAG_PX) return;
        g.dragging = true;
        suppressClick.current = true;
        if (g.longTimer !== null) clearTimeout(g.longTimer);
        g.longTimer = null;
        if (g.shownTimer !== null) clearTimeout(g.shownTimer);
        delete g.row.dataset.holding;
        g.row.setPointerCapture?.(g.pointerId);
      }
      setDrag({ key: g.key, x: e.clientX, y: e.clientY, drop: opts.current.locate(e.clientX, e.clientY) });
    },
    [stop],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const g = gesture.current;
      if (g === null || e.pointerId !== g.pointerId) return;
      if (!g.dragging) {
        stop();
        return;
      }
      const drop = opts.current.locate(e.clientX, e.clientY);
      const key = g.key;
      stop();
      if (drop !== null) opts.current.onDrop(key, drop.index);
    },
    [stop],
  );

  const onPointerCancel = useCallback(() => {
    suppressClick.current = false;
    stop();
  }, [stop]);

  // A completed hold or a drag must not also tap the row.
  const onClickCapture = useCallback((e: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  }, []);

  // Right-click, and Android's long-press, raise contextmenu. Same menu.
  const onContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      const key = rowOf(e.target)?.dataset.paneKey;
      if (key === undefined) return;
      e.preventDefault();
      // Android raises contextmenu on its own long-press, after our timer may already have opened
      // the menu; a second open is the same menu, so it is harmless. Only a press still held then
      // owes its release no tap. A right-click is no press here (the button is not 0) and is
      // followed by no click, so it must leave the next real tap alone.
      if (gesture.current !== null) suppressClick.current = true;
      stop();
      opts.current.onMenu(key);
    },
    [stop],
  );

  return {
    drag,
    hostProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture, onContextMenu },
  };
}

/**
 * A vertical swipe on an element that is `touch-action: none` (the space header). Capture starts only
 * once the finger has really moved, so a plain tap on a button inside still reaches the button.
 */
export function useVerticalSwipe(onSwipe: (dx: number, dy: number) => void) {
  const start = useRef<{ id: number; x: number; y: number; captured: boolean } | null>(null);
  const cb = useRef(onSwipe);
  cb.current = onSwipe;
  return {
    onPointerDown: useCallback((e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      start.current = { id: e.pointerId, x: e.clientX, y: e.clientY, captured: false };
    }, []),
    onPointerMove: useCallback((e: ReactPointerEvent<HTMLElement>) => {
      const s = start.current;
      if (s === null || s.id !== e.pointerId || s.captured) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) {
        s.captured = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
    }, []),
    onPointerUp: useCallback((e: ReactPointerEvent<HTMLElement>) => {
      const s = start.current;
      if (s === null || s.id !== e.pointerId) return;
      start.current = null;
      cb.current(e.clientX - s.x, e.clientY - s.y);
    }, []),
    onPointerCancel: useCallback(() => {
      start.current = null;
    }, []),
  };
}
