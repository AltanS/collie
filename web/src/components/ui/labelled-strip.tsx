import { createContext, useContext, useId, type ReactNode } from "react";

import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/utils";

/**
 * The 44px tap floor for a strip pill, bought without a single pixel of drawn height.
 *
 * A transparent `::before` extends the button's HIT box above and below its drawn box, so a 34px
 * pill answers a 46px touch while the row still measures 34px. Nothing about the pill's paint, its
 * 2px corner or its box changes, in any state — so this survives both the no-shift rule (C1) and
 * the `border-transparent` recipe untouched.
 *
 * Two measured numbers hold this together, and both are load-bearing:
 *
 *  1. **`-7px`, not `-6px`.** An absolutely positioned child resolves its insets against the
 *     button's PADDING box, and every pill here carries the C1 1px transparent border. At `-6px`
 *     the reach past the visible edge is therefore 5px, not 6, and the hit box came out at exactly
 *     34+5+5 = 44 — the floor with nothing to spare. `-7px` reaches a true 6px and measures 46.
 *  2. **6px is the scroller's `py-1.5` below, and the extension may not exceed it.** `overflow-x:
 *     auto` forces `overflow-y` to compute to `auto` (measured — the scroller is a scroll container
 *     on BOTH axes), so anything past the scroller's padding box is clipped away and stops taking
 *     taps. Verified by `document.elementFromPoint`: before the padding moved here, a probe 2px
 *     above a chip hit the <nav>, not the chip. That is why the row's vertical padding was moved off
 *     the <nav> and off the label and onto the scroller — the same pixels, but now inside the clip
 *     boundary where a tap area can use them.
 *
 * So: change `py-1.5` below, or add/remove the pill's border, and re-measure this inset. Get it
 * wrong in one direction and the floor silently drops; wrong in the other and the scroller grows a
 * vertical scrollbar.
 */
export const STRIP_TAP_TARGET =
  "relative before:absolute before:inset-x-0 before:-inset-y-[7px] before:content-['']";

/**
 * {@link STRIP_TAP_TARGET} for the square 32px "+" buttons, which are the only things in these rows
 * narrower than 44px. Having no border, they reach the full 7px, so 32 + 14 = 46 in both axes. The
 * horizontal half is safe only because they are LAST in their row — the pills carry no horizontal
 * extension, and the row's `gap-2` (8px) is wider than the reach, so no two hit boxes touch. Do not
 * put this on a pill that has a neighbour on both sides.
 */
export const STRIP_TAP_TARGET_SQUARE = `${STRIP_TAP_TARGET} before:-inset-x-[7px]`;

/**
 * Whether the strips in this subtree DRAW their names, or only expose them to a screen reader.
 *
 * This is a ROUTE-level treatment and deliberately not a prop. `hideLabel` used to be a prop and was
 * deleted, because a per-strip switch lets one strip on a page be 47px while its neighbour is 63px,
 * and the page then jumps 16px as a conditional strip appears — the same fault as a list row growing
 * on hover. A context cannot express that: the value is read from an ancestor, so every strip under
 * one provider answers it identically, and the only thing a caller can choose is where the provider
 * goes. Put it around the route's content region and there is no "some strips" to get wrong.
 *
 * Default is `true`: every route that does not opt in draws its labels exactly as before.
 */
const StripLabelsVisible = createContext(true);

/**
 * The pane screen's treatment: strips keep their accessible names and lose their visible ones.
 *
 * The pane route stacks TWO strips (Tabs, then Panes) between a breadcrumb header that already says
 * which space and tab you are in and the terminal mirror you came to read. Measured at 390x844: the
 * chrome above the mirror was 231px, 27% of the viewport, and 126px of it was the two strips. The
 * words TABS and PANES restate the header, so on this route only they are dropped from the paint
 * and kept in the a11y tree via `sr-only` — the `aria-labelledby` pairing is untouched, so the rows
 * are still named "Tabs" and "Panes" to a screen reader.
 *
 * That takes each strip to 47px: 1px top rule + the scroller's 6+34+6. That is the FLOOR, not a
 * guess — the scroller's `py-1.5` is the room the pills' 44px tap area reaches into (see
 * STRIP_TAP_TARGET), so it cannot be trimmed further without dropping the tap floor. Nothing else on
 * this row is removable.
 */
export function CompactStripLabels({ children }: { children: ReactNode }) {
  return <StripLabelsVisible.Provider value={false}>{children}</StripLabelsVisible.Provider>;
}

interface LabelledStripProps {
  /**
   * The row's name — Spaces · Tabs · Panes. Both the visible label and the strip's accessible name,
   * which is the point: a screen reader announces the same word the eye can see.
   *
   * It is never optional and never conditional. A strip that drew its name in one state and not in
   * another would change height across that state — 50px against 67px on the space strip, measured
   * — and a whole page jumping 17px on a navigation is the same fault as a list row growing on
   * hover, just larger. The label is a fixed part of the row, so the row is one height.
   *
   * A route may hide every strip's label at once with {@link CompactStripLabels}, which is a
   * property of the subtree rather than of a strip: the name is still required, still rendered and
   * still the row's accessible name — it is only unpainted, and unpainted for all of them together.
   */
  label: string;
  /** Extra classes for the OUTER, non-scrolling element: the strip's borders, ground and padding. */
  className?: string;
  /** Extra classes for the INNER scroller — the element the pills actually live in. */
  scrollerClassName?: string;
  children: ReactNode;
}

// The structural half of the "name the row" pattern: a horizontally scrolling strip of pills with
// its name on the line ABOVE, not beside.
//
// Three things are load-bearing here, and each of them is why this is a component rather than a
// prop on `SectionLabel` — a <span> can restructure none of them:
//
//  1. **The label sits OUTSIDE the scroller.** Inline, it is the scroller's first child, so it
//     scrolls away with the pills and the row loses its only name half way through a gesture. The
//     outer element does not scroll; the inner one does.
//  2. **`aria-labelledby` pairs the two.** Inline, the label was a stray word in front of an
//     unnamed run of buttons — the row had no accessible name at all. The id is generated here so
//     the pairing cannot be forgotten at a fourth strip later.
//  3. **`-mx-4 px-4` makes the scroller edge-to-edge.** The padding moves from the outer element
//     onto the scroller and is then cancelled by a negative margin, so the last pill can scroll
//     clean off the screen instead of stopping 16px short, while the first pill still starts
//     aligned under the label. The two halves are ONE number and must move together: the route's
//     gutter. It is 16px (`px-4`) everywhere under R2 — one left edge per route — so a pill's left
//     edge lands on the same x as the content column beside it. Change one half alone and the row
//     either stops short of the screen edge or starts its first pill off the gutter.
//  4. **The row's VERTICAL padding lives on the scroller too, for the same kind of reason.** The
//     scroller clips on both axes (see STRIP_TAP_TARGET), so padding parked on the <nav> is padding
//     the pills' tap areas cannot reach. Moved inside, the same pixels become the 44px floor. The
//     <nav> keeps only `pt-1.5`, which sits above the label and is genuinely the label's air.
//
// The typography stays in `SectionLabel` (`placement="above"`), so Spaces · Tabs · Panes · Controls
// cannot drift apart. This owns the structure; that owns the word.
export function LabelledStrip({ label, className, scrollerClassName, children }: LabelledStripProps) {
  const id = useId();
  // Route-level, never per-strip: see StripLabelsVisible. Under a compact route the label keeps its
  // id, its text and the `aria-labelledby` pairing and loses only its paint and its 16px of row.
  const labelVisible = useContext(StripLabelsVisible);
  return (
    <nav
      aria-labelledby={id}
      // shrink-0: these strips are children of a `flex-1 flex-col` scroller, so without it the strip
      // flex-shrinks while its pills overflow and the row below paints straight over them.
      // pt-1.5 rather than pt-2 buys back 2px of the label's line, so the row grows by less than the
      // label costs. There is no `pb-*`: the row's bottom air is the scroller's `py-1.5`, which is
      // the same pixels one element further in, where the tap areas can use them.
      // pt-1.5 is the LABEL's air and goes with it: with the word unpainted there is nothing above
      // the scroller for it to separate, and keeping it would spend 6px on a blank line.
      className={cn("shrink-0 px-4", labelVisible && "pt-1.5", className)}
    >
      {/* mb-0 overrides the placement's own mb-1 for the same reason: that 4px gap is now the top
          half of the scroller's `py-1.5`, inside the clip boundary instead of outside it.
          sr-only rather than a conditional render: the element must stay in the tree, keep its id
          and keep answering the nav's aria-labelledby, or the row loses its accessible name. */}
      <SectionLabel id={id} placement="above" className={labelVisible ? "mb-0" : "sr-only"}>
        {label}
      </SectionLabel>
      <div
        className={cn(
          "-mx-4 flex items-center gap-2 overflow-x-auto px-4 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          scrollerClassName,
        )}
      >
        {children}
      </div>
    </nav>
  );
}
