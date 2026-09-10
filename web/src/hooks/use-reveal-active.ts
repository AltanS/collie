import { useLayoutEffect, useRef, type RefObject } from "react";

const REVEAL_MARGIN = 12;

// Keeps the active tab/chip/pill visible in a horizontally scrolling strip: on mount, and on every
// selection change, scrolls the element carrying `aria-current="true"` to the nearest edge of the
// scroller's visible range if it isn't already inside it (with a 12px margin either side, so a tab
// sitting right on the edge doesn't count as hidden). Never centres — a browser tab bar reveals to
// the nearest edge, not the middle, because centring would also move tabs that were already visible.
//
// `scrollIntoView` is deliberately not used: it can scroll ANCESTORS (the page itself) vertically to
// bring the element into view, which is exactly the kind of page-wide movement this hook must not
// cause. `scroller.scrollTo` only ever moves the one element this hook was given.
//
// `behavior` is `"auto"` (instant) on the very first run after mount — arriving at a screen must not
// animate — and `"smooth"` on every later run (a genuine selection change), except when the device
// has asked for reduced motion, which stays `"auto"` always.
export function useRevealActive(scrollerRef: RefObject<HTMLElement | null>, activeKey: string | null): void {
  const hasRevealed = useRef(false);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // jsdom lays out nothing: every box reports 0, so `clientWidth` is 0 and the "off-screen" check
    // below would always read true against a real, painted scroller. Guarding here (rather than
    // skipping the whole hook) still lets a unit test drive the effect by stubbing these numbers.
    if (scroller.clientWidth === 0) return;

    const active = scroller.querySelector<HTMLElement>('[aria-current="true"]');
    if (!active) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    const visibleLeft = scrollerRect.left + REVEAL_MARGIN;
    const visibleRight = scrollerRect.right - REVEAL_MARGIN;
    const isVisible = activeRect.left >= visibleLeft && activeRect.right <= visibleRight;

    const isFirstReveal = !hasRevealed.current;
    hasRevealed.current = true;

    if (isVisible) return;

    // Nearest edge: if the active element sits to the left of the visible range, its left edge lands
    // on the scroller's left padding edge; if it sits to the right, its RIGHT edge lands on the
    // scroller's right edge. Both are expressed relative to the scroller's own content, via the
    // current `scrollLeft` plus the measured delta between the two rects — not via `offsetLeft`,
    // which a caller relying only on `getBoundingClientRect` stubs (as the unit test does) would
    // never populate.
    const deltaLeft = activeRect.left - scrollerRect.left;
    const deltaRight = activeRect.right - scrollerRect.right;
    const target =
      activeRect.left < visibleLeft
        ? scroller.scrollLeft + deltaLeft - REVEAL_MARGIN
        : scroller.scrollLeft + deltaRight + REVEAL_MARGIN;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const behavior: ScrollBehavior = isFirstReveal || reducedMotion ? "auto" : "smooth";

    scroller.scrollTo({ left: Math.max(0, target), behavior });
    // `scrollerRef` is a stable ref object identity across renders, so listing it costs nothing —
    // the effect still only re-runs on a real `activeKey` change.
  }, [activeKey, scrollerRef]);
}
