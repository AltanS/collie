import { useCallback, useEffect, useRef, useState } from "react";

import {
  MIN_ZOOM,
  TAP_SLOP,
  clampToBox,
  distance,
  doubleTapTarget,
  isDoubleTap,
  panMove,
  pinchMove,
  pinchStart,
  zoomAbout,
  type PanStart,
  type PinchStart,
  type Point,
  type Tap,
  type ZoomView,
} from "@/lib/zoom-gesture";
import { cn } from "@/lib/utils";

// A PICTURE YOU CAN ZOOM, in its own box (2026-11-11). At 1× the picture fits the box the caller's
// classes give it. Two fingers pinch it bigger about the point between them (up to the shared
// MAX_ZOOM), one finger pans it while it is zoomed, bounded to the picture's own edges, and a double
// tap toggles between 1× and 2.5× about the tapped point. A trackpad's pinch (a wheel with ctrlKey)
// zooms too, and a plain wheel pans while zoomed. The rules are lib/zoom-gesture.ts, the same ones the
// zoomed output uses; this file only feeds them fingers.
//
// THE BOX NEVER GROWS. The picture is drawn scaled and shifted by a transform inside a box that clips
// it, so zooming moves no layout around it. The view is two numbers, the scale and the offset into
// the scaled picture, clamped so the picture always covers the box (`clampToBox`).
//
// THE PAGE NEVER ZOOMS FROM HERE. `touch-action: pan-x pan-y` at 1× hands the browser one-finger
// scrolls only (the sheet still scrolls and still drags down to close), never its own pinch or
// double-tap zoom; zoomed, `none` hands it nothing. A two-finger move is also `preventDefault`ed, for a
// browser that reads touch-action loosely. Page zoom stays on everywhere else.
//
// THE SHEET STANDS DOWN WHILE THE PICTURE HOLDS THE FINGERS. Every move this picture claims (a pinch,
// a pan while zoomed) is `preventDefault`ed before it bubbles to the sheet's panel, and `BottomSheet`
// never pulls to close on a move a part inside it claimed or on a second finger (ui/sheet.tsx). At 1×
// a one-finger drag is not claimed, so a pull down on the picture closes the sheet as before.
//
// The listeners are native and non-passive, as in output-zoom.tsx: React attaches touch handlers
// passive, and a passive handler may not `preventDefault()`.

const REST: ZoomView = { scale: MIN_ZOOM, scroll: { x: 0, y: 0 } };

/**
 * The `BottomSheet` class of a sheet that shows a `ZoomPicture`: its panel takes one-finger scrolls
 * and the pull to close, never the browser's pinch or double-tap zoom, so a pinch whose fingers land
 * partly beside the picture (the title, the pager row, the gutter) still cannot zoom the page.
 */
export const PICTURE_SHEET = "[touch-action:pan-x_pan-y]";

export interface ZoomPictureProps {
  src: string;
  alt: string;
  /** The picture's size at 1×, as caps on the `<img>`: `max-h-[70dvh]`, say. */
  className?: string;
  onError?: () => void;
}

export function ZoomPicture({ src, alt, className, onError }: ZoomPictureProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ZoomView>(REST);
  // A double tap eases to its target; a finger's move follows the finger with no lag.
  const [eased, setEased] = useState(false);
  // The native listeners are attached once, so they read the live view through a ref.
  const viewRef = useRef(view);

  const apply = useCallback((next: ZoomView, ease: boolean) => {
    const box = boxRef.current;
    const clamped = clampToBox(next, { width: box?.clientWidth ?? 0, height: box?.clientHeight ?? 0 });
    viewRef.current = clamped;
    setEased(ease);
    setView(clamped);
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let pinch: PinchStart | null = null;
    let pan: PanStart | null = null;
    let press: { point: Point; moved: boolean } | null = null;
    let lastTap: Tap | null = null;
    const rel = (touch: Touch): Point => {
      const rect = box.getBoundingClientRect();
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    };
    const zoomed = () => viewRef.current.scale > MIN_ZOOM;
    /** A pan from where this finger is now, or none at 1×, where the finger belongs to the sheet. */
    const panFrom = (touch: Touch | undefined): PanStart | null =>
      touch !== undefined && zoomed() ? { view: viewRef.current, at: rel(touch) } : null;

    const onStart = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (a && b) {
        pinch = pinchStart(viewRef.current, rel(a), rel(b));
        pan = null;
        press = null;
        lastTap = null;
        return;
      }
      if (a && e.touches.length === 1) {
        press = { point: rel(a), moved: false };
        pan = panFrom(a);
      }
    };
    const onMove = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (pinch && a && b) {
        if (e.cancelable) e.preventDefault();
        apply(pinchMove(pinch, rel(a), rel(b)), false);
        return;
      }
      if (!a) return;
      const at = rel(a);
      if (press && distance(at, press.point) > TAP_SLOP) press.moved = true;
      if (pan) {
        if (e.cancelable) e.preventDefault();
        apply(panMove(pan, at), false);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        // A finger left: the pinch is over. One still down pans from here if the picture is zoomed.
        if (e.touches.length < 2) {
          pinch = null;
          pan = panFrom(e.touches[0]);
        }
        press = null;
        return;
      }
      if (e.touches.length > 0) return;
      pan = null;
      if (press && !press.moved) {
        const tap: Tap = { at: e.timeStamp, point: press.point };
        if (isDoubleTap(lastTap, tap)) {
          // No click and no browser zoom after the second tap: it was ours.
          if (e.cancelable) e.preventDefault();
          const now = viewRef.current;
          apply(zoomAbout(now, tap.point, doubleTapTarget(now.scale)), true);
          lastTap = null;
        } else {
          lastTap = tap;
        }
      } else if (press?.moved === true) {
        // A pan between two taps breaks the pair.
        lastTap = null;
      }
      press = null;
    };
    const onCancel = () => {
      pinch = null;
      pan = null;
      press = null;
    };
    const onWheel = (e: WheelEvent) => {
      const now = viewRef.current;
      if (e.ctrlKey) {
        e.preventDefault();
        const rect = box.getBoundingClientRect();
        apply(zoomAbout(now, { x: e.clientX - rect.left, y: e.clientY - rect.top }, now.scale * Math.exp(-e.deltaY * 0.01)), false);
        return;
      }
      if (!zoomed()) return;
      e.preventDefault();
      apply({ scale: now.scale, scroll: { x: now.scroll.x + e.deltaX, y: now.scroll.y + e.deltaY } }, false);
    };

    box.addEventListener("touchstart", onStart, { passive: true });
    box.addEventListener("touchmove", onMove, { passive: false });
    box.addEventListener("touchend", onEnd, { passive: false });
    box.addEventListener("touchcancel", onCancel);
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      box.removeEventListener("touchstart", onStart);
      box.removeEventListener("touchmove", onMove);
      box.removeEventListener("touchend", onEnd);
      box.removeEventListener("touchcancel", onCancel);
      box.removeEventListener("wheel", onWheel);
    };
  }, [apply]);

  const zoomed = view.scale > MIN_ZOOM;
  const moved = zoomed || view.scroll.x !== 0 || view.scroll.y !== 0;
  return (
    <div
      ref={boxRef}
      data-slot="zoom-picture"
      data-zoomed={zoomed ? "true" : undefined}
      className={cn(
        "relative mx-auto block w-fit max-w-full min-w-0 overflow-hidden rounded",
        zoomed ? "[touch-action:none]" : "[touch-action:pan-x_pan-y]",
      )}
    >
      <img
        src={src}
        alt={alt}
        onError={onError}
        className={cn(
          "block h-auto w-auto max-w-full",
          // The double tap's snap eases, and under reduced motion it lands at once.
          eased && "transition-transform duration-200 ease-out motion-reduce:transition-none",
          className,
        )}
        // The origin stays at the corner at 1× too, so the eased snap back to fit runs the same path
        // the zoom took and does not jump to a centred origin on its way.
        style={{
          transformOrigin: "0 0",
          transform: moved ? `translate(${-view.scroll.x}px, ${-view.scroll.y}px) scale(${view.scale})` : undefined,
        }}
      />
    </div>
  );
}
