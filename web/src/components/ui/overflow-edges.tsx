import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";

// A SIDEWAYS SCROLLER THAT SAYS WHICH WAY IT SCROLLS — the fade and a chevron on the edge that
// actually hides something, and on no other edge.
//
// The composer's two strips (the actions row and the key rail) are wider than a phone. On a Claude
// Code pane at 390px the general capsule alone measures ~396px against a ~382px row, so the harness
// capsule is entirely off-screen at rest and the row looks like it ENDS at the last visible pill.
// The old cue was STRIP_SCROLLER's edge mask, which faded BOTH ends unconditionally — including the
// left, where nothing was hidden — so the one thing it said, it said in both directions at once,
// and a fade alone was too quiet to read as "flick me". Altan, on his phone: "it should be a bit
// clearer now though that this bar is scrollable."
//
// IT MEASURES, IT DOES NOT GUESS. `scrollLeft`, `clientWidth` and `scrollWidth` are read on mount,
// on every `scroll` (passive), and whenever the scroller or its content changes size. A locale
// change needs no listener of its own: the words re-render, the content box changes, and the
// ResizeObserver reports it. The answer is written on the wrapper as
// `data-overflow="none|left|right|both"`, so the playground and the tests read one attribute rather
// than sniffing for a class.
//
// WHY A RENDER PROP and not `cloneElement` or a `scrollerRef` prop like LabelledStrip's. The state
// and the ref are one thing — the element measured IS the element the state describes — so the
// primitive owns both and hands the ref out. `cloneElement` would type-check nothing: hand it a
// component instead of a host element and the ref silently goes nowhere, with a row that never
// fades again and no error anywhere. A `scrollerRef` prop splits the pair: the caller would create
// the ref, and a caller that forgets to attach it gets the same silent nothing. `LabelledStrip`
// keeps its prop because there the ref is the CALLER's (it drives the scroll position from the
// outside); here it is ours.
//
// NOTHING ANIMATES, so there is nothing to gate on `prefers-reduced-motion`: no nudge, no bounce,
// no sliding chevron. The mask and the chevron appear and disappear, and that is all.

/** Which side, if either, still hides content. `none` when the row fits. */
export type OverflowEdge = "none" | "left" | "right" | "both";

/**
 * The fade, per state, at the 1.5rem STRIP_SCROLLER used to fade both ends by.
 *
 * Full literal class strings on purpose: Tailwind v4 scans source text, so a mask assembled from
 * pieces at runtime compiles to no CSS at all and fails silently.
 */
const MASK = {
  none: "",
  left: "[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]",
  right: "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]",
  both: "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
} satisfies Record<OverflowEdge, string>;

function edgeOf(left: boolean, right: boolean): OverflowEdge {
  if (left && right) return "both";
  if (left) return "left";
  if (right) return "right";
  return "none";
}

/**
 * The measuring half, split out so a future scroller can wear the answer without this wrapper.
 *
 * Returns the ref to put on the SCROLLING element and the edge it currently hides content on. The
 * 1px slack on both comparisons is the usual sub-pixel guard: a scroller at rest reports a
 * `scrollWidth` a fraction over its `clientWidth` often enough that an exact test would fade a row
 * that fits.
 */
export function useOverflowEdges<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [edge, setEdge] = useState<OverflowEdge>("none");

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    // React bails out of a re-render when the value is unchanged, so this runs on every scroll
    // event without costing a render per frame.
    setEdge(edgeOf(left, right));
  }, []);

  // Before paint, on every render: this is what covers a content change React made itself — the
  // harness capsule arriving, a pill gaining a word, a general action withdrawing.
  // Two layout reads on a two-div subtree, and a render only when the answer moved.
  useLayoutEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    return () => el.removeEventListener("scroll", measure);
  }, [measure]);

  // The asynchronous half: a font finishing, the viewport narrowing, the keyboard opening. The
  // scroller's own box AND its children, because a capsule growing inside a flex-sized scroller
  // never changes the scroller's border box. New children are picked up as they arrive, the way
  // `use-auto-scroll` does it. Guarded for jsdom, which has no ResizeObserver.
  useEffect(() => {
    const el = ref.current;
    if (!el || !hasResizeObserver()) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    const mo = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) ro.observe(node);
        }
      }
      measure();
    });
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [measure]);

  return { ref, edge };
}

interface OverflowEdgesProps {
  /** Extra classes for the WRAPPER — the flex sizing the scroller used to carry itself. No padding
   *  belongs here: each strip still pairs its own `px-*` with the `-mx-*` on its parent. */
  className?: string;
  /** The scroller, built by the caller, with the handed-out ref on it. */
  children: (ref: React.RefObject<HTMLDivElement | null>) => ReactNode;
}

/**
 * The wrapper: three elements, and each of the three is load-bearing.
 *
 *  1. The OUTER one is `relative` and carries `data-overflow`. It is a flex box with one child so
 *     that the scroller's own `min-w-0 flex-1` keeps working one level in; it adds no padding, no
 *     margin and no height of its own.
 *  2. The MIDDLE one wears the mask. It cannot be merged into the outer one: a mask applies to an
 *     element's whole subtree, and the chevron sits 4px from an edge the fade has already taken to
 *     ~17% alpha — masked with the pills, it would be invisible exactly where it is needed.
 *  3. The CHEVRONS are absolutely positioned against the outer box, so they take no layout space
 *     and the row's height and the pills' positions are identical in all four states (DESIGN.md §2,
 *     the no-shift rule). `pointer-events-none` keeps them from eating a tap meant for the pill
 *     underneath, and `aria-hidden` keeps them out of the accessibility tree — a screen reader gets
 *     the buttons themselves, which were never hidden from it.
 */
export function OverflowEdges({ className, children }: OverflowEdgesProps) {
  const { ref, edge } = useOverflowEdges<HTMLDivElement>();
  return (
    <div data-overflow={edge} className={cn("relative flex min-w-0 flex-1", className)}>
      <div className={cn("flex min-w-0 flex-1", MASK[edge])}>{children(ref)}</div>
      {(edge === "left" || edge === "both") && (
        <ChevronLeft aria-hidden className="pointer-events-none absolute top-1/2 left-1 size-3 -translate-y-1/2 text-muted-foreground" />
      )}
      {(edge === "right" || edge === "both") && (
        <ChevronRight aria-hidden className="pointer-events-none absolute top-1/2 right-1 size-3 -translate-y-1/2 text-muted-foreground" />
      )}
    </div>
  );
}
