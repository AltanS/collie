import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
//
// THE CHEVRON IS OPT-OUT, via `cue`. The bare glyph is `"soft"`, the default, and every caller keeps
// it unless it asks for `"none"`. The actions belt tried a bigger, darker glyph on its own chrome
// patch (`"strong"`) for one commit, against Altan's verdict from the phone that the bare glyph was
// "barely visible" over the belt's tint — but the fix Altan actually wanted, on reflection, was no
// chevron at all: the tint and the fade already say the row scrolls, and a chevron the fixed Switch
// pill's own hit box then overlapped was unreachable besides. `"none"` draws the fade masks and no
// glyph; `actions-row.tsx` is the one caller that asks for it.
//
// THE RIGHT MASK IS ALSO OPT-OUT, via `edges`, for the caller whose right end draws its OWN fade.
// `actions-row.tsx`'s pinned Switch block fades in over its own last 32px, constant at every scroll
// position — stack this primitive's right mask on top of that and the belt shows one fade at rest
// (the two overlapping) that visibly SHRINKS the moment the scroller reaches its end and this
// primitive's own mask has nothing left to hide (Altan, from the phone: "the fade is longer by
// default than when I scroll to the very right"). `edges="left"` (default `"both"`) keeps this
// primitive off the right edge entirely — no mask, no chevron, regardless of what the measurement
// says — and leaves that fade to whatever the caller pinned there.

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
  right:
    "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem-var(--edge-inset-right,0px)),transparent_calc(100%-var(--edge-inset-right,0px)))]",
  both: "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem-var(--edge-inset-right,0px)),transparent_calc(100%-var(--edge-inset-right,0px)))]",
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
  /**
   * How far in from the RIGHT edge the right-hand cue sits, in px. `0` (the default) puts it on the
   * edge, which is every caller that owns its whole right end.
   *
   * It exists for the actions belt, which pins the host tag over its own right end: the cue drawn
   * under that tag says nothing, so the fade and the chevron move to just left of it and the tag's
   * own fade continues the line. It is a NUMBER and not a class because the value is a measurement
   * of another element, and Tailwind compiles source text — an assembled class would produce no CSS
   * at all. It reaches the mask as `--edge-inset-right`, read by the literal gradients above.
   *
   * The left edge is untouched: nothing is ever pinned there.
   */
  insetRight?: number;
  /**
   * Which sides this primitive is allowed to paint a fade on. `"both"` (the default) fades
   * whichever edge the measurement says still hides content. `"left"` never paints the right
   * mask or chevron, no matter what the measurement says — for a caller whose right end already
   * carries its OWN fade (the actions belt's pinned Switch block) and would otherwise stack a
   * second one on top of it: at rest the belt's mask fades in over its last 1.5rem AND the
   * Switch block fades its own last 32px, so the two together read as one fade that shrinks the
   * moment the scroller reaches its end and the belt's own mask drops out. `edges="left"` keeps
   * the left mask (still useful once scrolled) and leaves the right edge to whatever the caller
   * draws there itself.
   */
  edges?: "both" | "left";
  /**
   * Whether the fading edge also draws a chevron. `"soft"` (the default) is the original mark —
   * `size-3`, `text-muted-foreground`, no ground of its own — kept as the default so every existing
   * caller (the playground's frozen mocks among them) is
   * byte-identical unless it opts out.
   *
   * `"none"` draws the fade and nothing else: the actions belt's pick, because the belt's own tint
   * plus the fade already say the row scrolls, and a chevron there sat under the fixed Switch pill's
   * hit box and could not be tapped anyway (operator's call, 2026-09-14).
   */
  cue?: "soft" | "none";
}

const CUE_GLYPH = {
  soft: "size-3 text-muted-foreground",
} satisfies Record<Exclude<NonNullable<OverflowEdgesProps["cue"]>, "none">, string>;

/**
 * The wrapper: three elements, and each of the three is load-bearing.
 *
 *  1. The OUTER one is `relative` and carries `data-overflow`. It is a flex box with one child so
 *     that the scroller's own `min-w-0 flex-1` keeps working one level in; it adds no padding, no
 *     margin and no height of its own.
 *  2. The MIDDLE one wears the mask. It cannot be merged into the outer one: a mask applies to an
 *     element's whole subtree, and the chevron sits 4px from an edge the fade has already taken to
 *     ~17% alpha — masked with the pills, it would be invisible exactly where it is needed.
 *  3. The CHEVRONS, when `cue` draws one, are absolutely positioned against the outer box, so they
 *     take no layout space and the row's height and the pills' positions are identical in every
 *     state (DESIGN.md §2, the no-shift rule). `pointer-events-none` keeps them from eating a tap
 *     meant for the pill underneath, and `aria-hidden` keeps them out of the accessibility tree — a
 *     screen reader gets the buttons themselves, which were never hidden from it. `cue="none"` skips
 *     this step entirely: the mask is the whole of the cue.
 */
export function OverflowEdges({
  className,
  children,
  insetRight = 0,
  cue = "soft",
  edges = "both",
}: OverflowEdgesProps) {
  const { ref, edge } = useOverflowEdges<HTMLDivElement>();
  // `edges="left"` downgrades a measured "right"/"both" so the right mask and chevron never
  // paint: "right" hides nothing on the left, so it becomes "none"; "both" keeps its left half.
  // `data-overflow` still publishes the MEASURED edge, unrestricted — it is read by the
  // playground's ground-painting selectors and by a caller that wants the real scroll state, and
  // restricting it here would hide "there is still something to the right" from anyone but the
  // mask.
  const paintEdge: OverflowEdge =
    edges === "left" ? (edge === "right" ? "none" : edge === "both" ? "left" : edge) : edge;
  // A custom property is not a `CSSProperties` key, so the type is widened at the declaration rather
  // than asserted at the call: `style` takes this object as it stands.
  const maskStyle: CSSProperties & Record<string, string> | undefined =
    insetRight > 0 ? { "--edge-inset-right": `${insetRight}px` } : undefined;
  return (
    <div data-overflow={edge} className={cn("relative flex min-w-0 flex-1", className)}>
      <div
        // The inset travels as a custom property so the gradients above can stay whole strings.
        // Unset it entirely at 0 rather than writing `0px`: the fallback in the `var()` is then the
        // one definition of "no inset", and the default caller's DOM is byte-identical to before.
        style={maskStyle}
        className={cn("flex min-w-0 flex-1", MASK[paintEdge])}
      >
        {children(ref)}
      </div>
      {cue !== "none" && (paintEdge === "left" || paintEdge === "both") && (
        <span aria-hidden className="pointer-events-none absolute top-1/2 left-1 flex -translate-y-1/2 items-center justify-center">
          <ChevronLeft className={CUE_GLYPH[cue]} />
        </span>
      )}
      {cue !== "none" && (paintEdge === "right" || paintEdge === "both") && (
        <span
          aria-hidden
          // `right-1` is the 4px the left cue keeps; the inset is added to it, so the mark lands the
          // same distance from whatever its right edge really is.
          style={insetRight > 0 ? { right: `${insetRight + 4}px` } : undefined}
          className="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center justify-center"
        >
          <ChevronRight className={CUE_GLYPH[cue]} />
        </span>
      )}
    </div>
  );
}
