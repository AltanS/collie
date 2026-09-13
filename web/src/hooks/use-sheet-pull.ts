import { useEffect, useRef, useState } from "react";

// Finger-tracked reveal for the pane switcher. useSwipeUp (use-swipe.ts) only reads the
// start/end points and fires once on release, which reads as a swipe gesture, not a native sheet
// that follows the thumb. This hook reports every intermediate point so the caller can paint the
// sheet peeking up under the finger, then decides on release whether the drag crossed into "open"
// (far enough, or fast enough) the same way ui/sheet.tsx's drag-to-dismiss decides "close".
//
// IT NOW SITS ON A SURFACE THAT ALSO SCROLLS SIDEWAYS, SO IT MUST YIELD TO THAT SCROLL. The node
// this attaches to used to be the switcher's own 28x16 chevron, where every touch was the hook's.
// It is the whole actions belt now (actions-row.tsx), which is a horizontal scroller carrying every
// pill the composer owns — so a touch starting on it may be a sideways pan, a tap on a pill, or the
// upward drag this hook is for, and the hook has to decide which WITHOUT stealing the other two.
//
// The arbitration is in `onMove` and it is one axis comparison, made once per gesture:
//
//   * a move that is mostly VERTICAL (|dy| > SLOP and |dy| >= |dx|) engages, and only from then on
//     does the hook call preventDefault, so the browser keeps the gesture until it is ours;
//   * a move that is mostly HORIZONTAL (|dx| > SLOP and |dx| > |dy|) ABANDONS the gesture for the
//     rest of that touch — no engage, no preventDefault, ever, even if the finger later turns
//     upward. A pan that re-engages half way reads as the scroller being yanked out from under the
//     thumb, which is worse than the drag being missed;
//   * neither, and the gesture is still undecided; a touch that ends there was a tap and the belt's
//     own buttons get their click, because nothing was prevented.
//
// The belt itself carries `touch-action: pan-x`, so the browser hands vertical movement to this hook
// and keeps horizontal panning for the scroller. When it takes the pan it fires `touchcancel`, which
// routes to `onEnd` here and does nothing, because an abandoned gesture never engaged.

/** Upward travel (px) past which a release always opens, regardless of speed. */
export const OPEN_PX = 120;
/** Upward speed (px/ms) past which a release opens even on a short pull, a fling. */
export const FLING_PX_PER_MS = 0.6;
/** Travel (px) below which a touch is a tap, not a drag; mirrors ui/sheet.tsx's own SLOP. */
export const SLOP = 6;

/**
 * Pure open/cancel decision, exported on its own so it is unit-testable without simulating touch
 * events. `pull` is upward travel in px (0 for a downward or absent drag); `velocity` is the upward
 * px/ms over roughly the last 80ms of the gesture.
 */
export function shouldOpen(pull: number, velocity: number): boolean {
  if (pull >= OPEN_PX) return true;
  // A short, fast upward flick opens too, matching the fling most native sheets honour. A
  // measurement past pure noise (SLOP) is required so a stationary finger with jittery velocity
  // near zero pull can never trip it.
  return pull > SLOP && velocity >= FLING_PX_PER_MS;
}

/** Trailing window (ms) the velocity is measured over, recent enough to read as "how fast now". */
const VELOCITY_WINDOW_MS = 80;

/**
 * Given the anchor node's own distance from the viewport bottom (`anchor`, px) and the sheet's own
 * max-height (`sheetMax`, px, defaulting to 0.82 * innerHeight — BottomSheet's `max-h-[82dvh]`),
 * the most `pull` may report without the peeking panel's top edge overshooting that max-height.
 * Exported bare so the clamp is testable without a touch simulation: it's the one piece of the
 * anchor math with a wrong answer worth pinning on its own.
 */
export function maxPullForAnchor(anchor: number, sheetMax?: number): number {
  const cap = sheetMax ?? window.innerHeight * 0.82;
  return Math.max(0, cap - anchor);
}

interface UseSheetPullOptions {
  /** Fired on every tracked move once the drag has engaged, with the current upward pull in px. */
  onPull: (px: number) => void;
  /**
   * Fired once per gesture, on touchstart, with the attached node's distance (px) from the viewport
   * bottom at that moment — `window.innerHeight - node.getBoundingClientRect().top`. The caller
   * feeds this straight to `BottomSheet`'s `pullFrom` prop so the peeking panel's TOP edge starts at
   * that node rather than at the screen's bottom edge, which is where a raw `pull` value alone would
   * put it (the node sits above the composer, with the composer in between).
   *
   * The node is the actions belt, so this is the belt's own top edge — which is exactly where the
   * chevron rides, so the peek rises from the mark whether the drag started on it or on a pill.
   */
  onAnchor: (px: number) => void;
  /** Fired on release when the drag crossed the open threshold ({@link shouldOpen}). */
  onOpen: () => void;
  /** Fired on release when it didn't; the caller resets its pull state back to 0. */
  onCancel: () => void;
  /**
   * Hard clamp on the reported pull. Defaults to `maxPullForAnchor(anchor)` — the sheet's own
   * 0.82 * innerHeight max-height, less whatever the anchor already spent — so `anchor + pull`
   * never overshoots the sheet's own ceiling regardless of how far the finger travels.
   */
  max?: number;
}

interface UseSheetPullResult {
  ref: (node: HTMLElement | null) => void;
}

export function useSheetPull({
  onPull,
  onAnchor,
  onOpen,
  onCancel,
  max,
}: UseSheetPullOptions): UseSheetPullResult {
  // Callbacks travel through refs so the attach effect below runs once per DOM node rather than
  // re-binding listeners on every render, the same "read via ref, stay stable across renders"
  // shape hooks/use-spaces.ts uses for its own callbacks.
  const onPullRef = useRef(onPull);
  onPullRef.current = onPull;
  const onAnchorRef = useRef(onAnchor);
  onAnchorRef.current = onAnchor;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const maxRef = useRef(max);
  maxRef.current = max;
  // Set once per gesture (onStart), read by the clamp for the rest of it — the anchor cannot
  // change mid-drag, the handle isn't moving, only the finger is.
  const anchorRef = useRef(0);

  // A ref callback stored in state (not a plain useRef), because a plain ref gives the attach effect
  // below nothing to depend on, so it would run before the button exists and never re-run once it
  // does. State makes the node's arrival a render the effect can react to.
  const [node, setNode] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!node) return;

    let startY = 0;
    // Tracked beside startY for the axis comparison in onMove — the belt scrolls sideways, so a
    // gesture's direction is the first thing about it that has to be decided.
    let startX = 0;
    let engaged = false;
    // Set once a gesture proves itself horizontal, cleared only by the next touchstart. It is a
    // ONE-WAY latch on purpose: a pan that turns upward mid-flight stays the scroller's.
    let abandoned = false;
    // Trailing samples for the velocity read, trimmed to the last VELOCITY_WINDOW_MS on each move.
    let samples: { t: number; y: number }[] = [];

    const clamp = (px: number) => {
      const cap = maxRef.current ?? maxPullForAnchor(anchorRef.current);
      return Math.min(Math.max(px, 0), cap);
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      startY = t.clientY;
      startX = t.clientX;
      engaged = false;
      abandoned = false;
      samples = [{ t: e.timeStamp, y: t.clientY }];
      // Measured once per gesture: the belt's own distance from the viewport bottom, so the
      // peek's top edge can start there instead of at the screen's bottom edge (BottomSheet's
      // `pullFrom`). The clamp above reads it back on every subsequent move.
      const anchor = window.innerHeight - node.getBoundingClientRect().top;
      anchorRef.current = anchor;
      onAnchorRef.current(anchor);
    };

    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      // The scroller won this touch already (see the latch above, and the header for why it cannot
      // be given back).
      if (abandoned) return;
      const dy = startY - t.clientY; // positive = moved up
      const dx = t.clientX - startX;
      if (!engaged) {
        const ay = Math.abs(dy);
        const ax = Math.abs(dx);
        // Mostly sideways: this is the belt being panned, so hand the whole touch back.
        if (ax > SLOP && ax > ay) {
          abandoned = true;
          return;
        }
        // Mostly upward or downward: it is ours. The tie (ax === ay) goes to the drag, because the
        // scroller has the browser's own pan-x behind it and needs no help winning a coin flip.
        if (ay > SLOP && ay >= ax) engaged = true;
      }
      if (!engaged) return;

      // Non-passive listener: suppress the browser's own scroll/pull-to-refresh while the drag is
      // ours, same reasoning as ui/sheet.tsx's drag-to-dismiss.
      e.preventDefault();

      samples.push({ t: e.timeStamp, y: t.clientY });
      const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
      samples = samples.filter((s) => s.t >= cutoff);

      onPullRef.current(clamp(dy));
    };

    const onEnd = () => {
      if (!engaged) return;
      engaged = false;
      const last = samples[samples.length - 1];
      const first = samples[0];
      const dy = last ? startY - last.y : 0;
      const pull = clamp(dy);
      let velocity = 0;
      if (first && last && last.t > first.t) {
        velocity = (first.y - last.y) / (last.t - first.t);
      }
      if (shouldOpen(pull, velocity)) onOpenRef.current();
      else onCancelRef.current();
    };

    node.addEventListener("touchstart", onStart, { passive: true });
    node.addEventListener("touchmove", onMove, { passive: false });
    node.addEventListener("touchend", onEnd);
    node.addEventListener("touchcancel", onEnd);
    return () => {
      node.removeEventListener("touchstart", onStart);
      node.removeEventListener("touchmove", onMove);
      node.removeEventListener("touchend", onEnd);
      node.removeEventListener("touchcancel", onEnd);
    };
  }, [node]);

  return { ref: setNode };
}
