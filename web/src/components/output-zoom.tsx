import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Minus, Plus, X } from "lucide-react";

import { AnsiOutput } from "@/components/ansi-output";
import { BackBar, PHONE_QUERY, type BackControl } from "@/components/back-bar";
import { FileLinksProvider } from "@/components/file-links";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/components/ui/sheet";
import type { Hand } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { useMediaQuery } from "@/hooks/use-media-query";
import { hasResizeObserver } from "@/lib/env";
import { t } from "@/lib/i18n";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  TAP_SLOP,
  clampScroll,
  distance,
  doubleTapTarget,
  formatScale,
  isDoubleTap,
  pinchMove,
  pinchStart,
  stepScale,
  zoomAbout,
  type PinchStart,
  type Point,
  type Size,
  type Tap,
  type ZoomView,
} from "@/lib/zoom-gesture";
import { cn } from "@/lib/utils";

// THE PANE'S OUTPUT, ZOOMED. The mirror's text and nothing else, over the whole screen, for reading
// on a phone: two fingers pinch it bigger about the point between them, one finger pans it in both
// axes (and scrolls it at 1×), a double tap toggles between 1× and 2.5× about the tapped line. The
// buttons in the header do the same in steps, for a reader with one pointer (WCAG 2.5.1).
//
// IT READS, IT NEVER WRITES. The text is the pane loader's, the same string the mirror draws, so it
// keeps updating while the view is open. Nothing here asks Herdr for a zoom or a resize: a pane's
// geometry is the operator's screen and Collie writes none of it (ADR 0008, amended 2026-09-05).
// Paths the agent printed are not links here (an empty FileLinksProvider): a pinch that starts on
// one must not open Files.
//
// THE MECHANICS. The text is laid out once, at the viewport's width (or its own, with Wrap off), and
// drawn scaled by a transform. Around it a box is sized to the scaled text, so the browser's own
// scroller pans it, with its own momentum and its own bounds. A gesture therefore moves two numbers,
// the scale and the scroll offset, and lib/zoom-gesture.ts holds every rule for them as pure
// functions. The listeners are native and non-passive, because a two-finger move must
// `preventDefault()` the browser's own pinch and scroll, and React attaches touch handlers passive.
//
// It is a LEVEL, `/pane/:id/zoom` (ADR 0067): the phone's back closes it, and so does the ✕, which
// is an up. AgentChat stays mounted underneath, so the composer and the mirror come back as they
// were.

export interface OutputZoomProps {
  /** The pane's text, live: the pane loader's, never the mirror's frozen copy. */
  text: string;
  logicalText?: string;
  /** The operator's Wrap and size, so 1× reads exactly as the mirror does. */
  wrap: boolean;
  fontSize: number;
  /** Picks the native mirror's colour space only; the grammars do not run here (see AgentChat). */
  agent?: string;
  nativeMirror?: boolean;
  /** The chosen terminal font (`mirrorFont`), on the same element the mirror wears it on. */
  face: { className?: string; style?: CSSProperties };
  /** The pane's name, for the heading. */
  title: string;
  /** Which thumb holds the phone: the side the bottom Back stands on. */
  hand: Hand;
  /** An up: back to the pane. */
  onClose: () => void;
}

const NO_SIZE: Size = { width: 0, height: 0 };

export function OutputZoom({ text, logicalText, wrap, fontSize, agent, nativeMirror, face, title, hand, onClose }: OutputZoomProps) {
  useLocale();
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(MIN_ZOOM);
  // The text's own laid-out size (a transform does not change it) and the viewport's width, which
  // is the width the text wraps at.
  const [natural, setNatural] = useState<Size>(NO_SIZE);
  const [viewportWidth, setViewportWidth] = useState(0);
  // The native listeners are attached once, so they read the live values through refs.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  // A gesture's scroll offset waits here for the render that sizes the box to its scale.
  const pendingScroll = useRef<Point | null>(null);
  // Reading the latest output: the view opens on the tail and stays on it while new rows arrive,
  // until the reader scrolls away, the mirror's own rule.
  const following = useRef(true);

  useDialogFocus(true, viewportRef);

  const flushScroll = useCallback(() => {
    const vp = viewportRef.current;
    const next = pendingScroll.current;
    if (!vp || !next) return;
    pendingScroll.current = null;
    const at = clampScroll(next, naturalRef.current, { width: vp.clientWidth, height: vp.clientHeight }, scaleRef.current);
    vp.scrollLeft = at.x;
    vp.scrollTop = at.y;
  }, []);

  const apply = useCallback(
    (next: ZoomView) => {
      pendingScroll.current = next.scroll;
      if (next.scale === scaleRef.current) flushScroll();
      else setScale(next.scale);
    },
    [flushScroll],
  );

  const currentView = useCallback((): ZoomView => {
    const vp = viewportRef.current;
    return { scale: scaleRef.current, scroll: { x: vp?.scrollLeft ?? 0, y: vp?.scrollTop ?? 0 } };
  }, []);

  /** Zoom about the viewport's centre: the header's buttons and the keyboard. */
  const zoomCentred = useCallback(
    (nextScale: number) => {
      const vp = viewportRef.current;
      const centre = { x: (vp?.clientWidth ?? 0) / 2, y: (vp?.clientHeight ?? 0) / 2 };
      apply(zoomAbout(currentView(), centre, nextScale));
    },
    [apply, currentView],
  );

  // The box is sized to the new scale in this commit; the offset that goes with it lands now.
  useLayoutEffect(flushScroll, [scale, flushScroll]);

  // New rows while following: back to the tail, after the box has grown. Not on a scale change: a
  // zoom places the view itself, and the scroll it causes decides `following` again.
  useLayoutEffect(() => {
    const vp = viewportRef.current;
    if (vp && following.current) vp.scrollTop = vp.scrollHeight;
  }, [natural.height]);

  // Measure the text and the viewport. jsdom has no ResizeObserver; there the sizes stay 0 and the
  // box is left to size itself, which is exactly the 1× layout. Re-attached when the text first
  // arrives, because an empty pane draws no text box to observe.
  const empty = text === "";
  useEffect(() => {
    const vp = viewportRef.current;
    const content = contentRef.current;
    if (empty || !vp || !content || !hasResizeObserver()) return;
    const ro = new ResizeObserver(() => {
      setViewportWidth(vp.clientWidth);
      setNatural((prev) =>
        prev.width === content.offsetWidth && prev.height === content.offsetHeight
          ? prev
          : { width: content.offsetWidth, height: content.offsetHeight },
      );
    });
    ro.observe(vp);
    ro.observe(content);
    return () => ro.disconnect();
  }, [empty]);

  // Escape closes, as on every full-screen surface here; + − 0 zoom for a keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomCentred(stepScale(scaleRef.current, 1));
      else if (e.key === "-") zoomCentred(stepScale(scaleRef.current, -1));
      else if (e.key === "0") zoomCentred(MIN_ZOOM);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, zoomCentred]);

  // The touch gestures, and a trackpad's pinch (a wheel event with ctrlKey).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    let pinch: PinchStart | null = null;
    let press: { point: Point; moved: boolean } | null = null;
    let lastTap: Tap | null = null;
    const rel = (touch: Touch): Point => {
      const rect = vp.getBoundingClientRect();
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
    };

    const onStart = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (a && b) {
        pinch = pinchStart(currentView(), rel(a), rel(b));
        press = null;
        lastTap = null;
        following.current = false;
      } else if (a && e.touches.length === 1) {
        press = { point: rel(a), moved: false };
      }
    };
    const onMove = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (pinch && a && b) {
        if (e.cancelable) e.preventDefault();
        apply(pinchMove(pinch, rel(a), rel(b)));
        return;
      }
      if (press && a && distance(rel(a), press.point) > TAP_SLOP) press.moved = true;
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        // A finger left: the pinch is over. One still down pans natively from here; no tap.
        if (e.touches.length < 2) pinch = null;
        press = null;
        return;
      }
      if (press && !press.moved && e.touches.length === 0) {
        const tap: Tap = { at: e.timeStamp, point: press.point };
        if (isDoubleTap(lastTap, tap)) {
          if (e.cancelable) e.preventDefault();
          const now = currentView();
          following.current = false;
          apply(zoomAbout(now, tap.point, doubleTapTarget(now.scale)));
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
      press = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const now = currentView();
      following.current = false;
      apply(zoomAbout(now, { x: e.clientX - rect.left, y: e.clientY - rect.top }, now.scale * Math.exp(-e.deltaY * 0.01)));
    };

    vp.addEventListener("touchstart", onStart, { passive: true });
    vp.addEventListener("touchmove", onMove, { passive: false });
    vp.addEventListener("touchend", onEnd, { passive: false });
    vp.addEventListener("touchcancel", onCancel);
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      vp.removeEventListener("touchstart", onStart);
      vp.removeEventListener("touchmove", onMove);
      vp.removeEventListener("touchend", onEnd);
      vp.removeEventListener("touchcancel", onCancel);
      vp.removeEventListener("wheel", onWheel);
    };
  }, [apply, currentView]);

  const onScroll = () => {
    const vp = viewportRef.current;
    if (vp) following.current = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 4;
  };

  const scaled = natural.width > 0 && natural.height > 0;
  const scaleLabel = formatScale(scale);
  // The view's one way back, as every screen below a pane has it: the ✕ up top and, on a phone, the
  // same act and name again at the bottom on the thumb's side (DESIGN.md §12).
  const phone = useMediaQuery(PHONE_QUERY);
  const back: BackControl = { label: t("changes.backAria.pane"), go: onClose };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("zoom.title")}
      data-slot="output-zoom"
      className="fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col bg-background"
    >
      <div className="flex min-h-12 shrink-0 items-center gap-1 border-b border-rule bg-chrome px-1 pt-[env(safe-area-inset-top)]">
        <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={back.label} onClick={back.go}>
          <X className="size-5" />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("zoom.out")}
          disabled={scale <= MIN_ZOOM}
          onClick={() => zoomCentred(stepScale(scale, -1))}
        >
          <Minus className="size-5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 min-w-14 px-2 font-mono text-sm tabular-nums"
          aria-label={t("zoom.reset", { scale: scaleLabel })}
          onClick={() => zoomCentred(MIN_ZOOM)}
        >
          {scaleLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11"
          aria-label={t("zoom.in")}
          disabled={scale >= MAX_ZOOM}
          onClick={() => zoomCentred(stepScale(scale, 1))}
        >
          <Plus className="size-5" />
        </Button>
      </div>
      <div
        ref={viewportRef}
        // The dialog's focus target (`useDialogFocus`), as a sheet's panel is: focused on open, so the
        // arrow keys and Page Up / Down scroll the text at once, and out of the Tab order.
        tabIndex={-1}
        onScroll={onScroll}
        // `pan-x pan-y`: one finger scrolls natively, and the browser's own pinch and double-tap zoom
        // stand down so the listeners above own them. `overscroll-contain` keeps a pan at the edge
        // from pulling the page (or a refresh) behind the view.
        className={cn(
          "relative min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable] [touch-action:pan-x_pan-y] outline-none",
          face.className,
        )}
        style={face.style}
      >
        {empty ? (
          <div className="py-16 text-center text-sm text-muted-foreground">{t("chat.output.empty")}</div>
        ) : (
          <div style={scaled ? { width: natural.width * scale, height: natural.height * scale } : undefined}>
            <div
              ref={contentRef}
              // The route's own 8px gutter, inside the measured box, so it scales with the text and
              // the wrap width at 1× is the mirror's.
              className="px-2 py-1"
              style={{
                width: wrap ? (viewportWidth > 0 ? viewportWidth : "100%") : "max-content",
                minWidth: viewportWidth > 0 ? viewportWidth : "100%",
                transform: scale === MIN_ZOOM ? undefined : `scale(${scale})`,
                transformOrigin: "0 0",
              }}
            >
              <FileLinksProvider value={null}>
                <AnsiOutput
                  text={text}
                  logicalText={logicalText}
                  wrap={wrap}
                  fontSize={fontSize}
                  agent={agent}
                  grammars={false}
                  nativeMirror={nativeMirror}
                  // With Wrap off the <pre> would be a scroller of its own; here the viewport is the
                  // one scroller, so the <pre> takes its full width and lets it pan.
                  className={wrap ? undefined : "w-max max-w-none overflow-visible"}
                />
              </FileLinksProvider>
            </div>
          </div>
        )}
      </div>
      {phone && <BackBar back={back} hand={hand} />}
    </div>
  );
}
