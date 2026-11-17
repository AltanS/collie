import { useLayoutEffect, useRef, type RefObject } from "react";

const REVEAL_MARGIN = 12;

/** How long a tap's "this change is mine" claim stays good, so a tap that changed nothing cannot
 *  swallow a later reveal for ever. */
const TAP_CLAIM_MS = 10_000;

interface StripMemory {
  /** The scroller's last `scrollLeft`, so a remounted strip lands where the old one stood. */
  left: number | undefined;
  /** When a tap on a non-active item last happened here; `0` once the change it caused was seen. */
  tappedAt: number;
}

const memories = new Map<string, StripMemory>();

function memoryFor(key: string): StripMemory {
  const found = memories.get(key);
  if (found) return found;
  const fresh: StripMemory = { left: undefined, tappedAt: 0 };
  memories.set(key, fresh);
  return fresh;
}

// Keeps the active tab/chip/pill visible in a horizontally scrolling strip: on mount, and on every
// selection change, scrolls the element carrying `aria-current="true"` to the nearest edge of the
// scroller's visible range if it isn't already fully inside it, with 12px of air past the edge it
// lands on. An item that is fully visible is never moved. Never centres — a browser tab bar reveals to
// the nearest edge, not the middle, because centring would also move tabs that were already visible.
//
// `scrollIntoView` is deliberately not used: it can scroll ANCESTORS (the page itself) vertically to
// bring the element into view, which is exactly the kind of page-wide movement this hook must not
// cause. `scroller.scrollTo` only ever moves the one element this hook was given.
//
// `behavior` is `"auto"` (instant) on the very first run after mount — arriving at a screen must not
// animate — and `"smooth"` on every later run (a genuine selection change), except when the device
// has asked for reduced motion, which stays `"auto"` always.
//
// WHY THERE IS A MEMORY KEY. The pane screen is remounted for every pane it opens (`DetailRoute` keys
// `AgentChat` by pane), and the tab strip and the pane strip live inside it. A tap on a tab used to
// build a brand-new scroller at `scrollLeft` 0, and the reveal then put the active tab on the right
// edge: the tapped tab jumped from under the finger to the screen edge (operator, 2026-11-17). With a
// `memoryKey` the strip remembers its `scrollLeft` (module level, in memory only, as
// `lib/scroll-memory.ts` does) and puts it back before it looks, so the tapped item is still where it
// was. Without a key the memory lives in the hook instance, which is enough for a strip that stays
// mounted.
//
// A TAP DOES NOT SCROLL. A click on a non-active item in the strip claims the change that follows:
// the strip restores its position and leaves it alone, even when the item was only partly in view.
// The strip scrolls only for a change nobody tapped here (a switch made elsewhere, the first open).
export function useRevealActive(
  scrollerRef: RefObject<HTMLElement | null>,
  activeKey: string | null,
  memoryKey?: string,
): void {
  const hasRevealed = useRef(false);
  const local = useRef<StripMemory>({ left: undefined, tappedAt: 0 });
  const memory = memoryKey === undefined ? local.current : memoryFor(memoryKey);

  // Tracks the position, and notes a tap on an item that is not the active one. It reads only, and
  // changes no behaviour of the strip's own buttons. No dependency list on purpose: a strip that
  // draws nothing until it has two panes gets its scroller later, and the listeners must find it.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      memory.left = scroller.scrollLeft;
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target.closest("button, a, [role]") : null;
      if (!target || !scroller.contains(target)) return;
      if (target.closest('[aria-current="true"]')) return;
      memory.tappedAt = Date.now();
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("click", onClick, true);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("click", onClick, true);
    };
  });

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Spend the tap's claim on this run, whatever else it does, so it can never outlive the change.
    const tapped = memory.tappedAt !== 0 && Date.now() - memory.tappedAt < TAP_CLAIM_MS;
    memory.tappedAt = 0;
    // jsdom lays nothing out: every box reports 0, so `clientWidth` is 0 and the "off-screen" check
    // below would always read true against a real, painted scroller. Guarding here (rather than
    // skipping the whole hook) still lets a unit test drive the effect by stubbing these numbers.
    if (scroller.clientWidth === 0) return;

    const isFirstReveal = !hasRevealed.current;
    hasRevealed.current = true;

    // A remounted strip starts at 0; put it back where the last one stood, before anything is measured.
    if (isFirstReveal && memory.left !== undefined) scroller.scrollLeft = memory.left;

    // The operator tapped this item: it stays under the finger and just becomes the active one.
    if (tapped) return;

    const active = scroller.querySelector<HTMLElement>('[aria-current="true"]');
    if (!active) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();

    // Fully inside the scroller's own box: an item the operator can see whole is never moved.
    const isVisible = activeRect.left >= scrollerRect.left && activeRect.right <= scrollerRect.right;
    if (isVisible) return;

    // Nearest edge: if the active element sits to the left of the visible range, its left edge lands
    // on the scroller's left edge (plus the air below); if it sits to the right, its RIGHT edge lands
    // on the scroller's right edge. Both are expressed relative to the scroller's own content, via the
    // current `scrollLeft` plus the measured delta between the two rects, not via `offsetLeft`,
    // which a caller relying only on `getBoundingClientRect` stubs (as the unit test does) would
    // never populate.
    const deltaLeft = activeRect.left - scrollerRect.left;
    const deltaRight = activeRect.right - scrollerRect.right;
    const target =
      activeRect.left < scrollerRect.left
        ? scroller.scrollLeft + deltaLeft - REVEAL_MARGIN
        : scroller.scrollLeft + deltaRight + REVEAL_MARGIN;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const behavior: ScrollBehavior = isFirstReveal || reducedMotion ? "auto" : "smooth";

    scroller.scrollTo({ left: Math.max(0, target), behavior });
    // `scrollerRef` is a stable ref object identity across renders, so listing it costs nothing —
    // the effect still only re-runs on a real `activeKey` change.
  }, [activeKey, scrollerRef, memory]);
}
