import { createContext, useContext, useId, type ReactNode, type RefObject } from "react";

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
 * The sideways scroller the composer's thin rows are built on — the key rail and the actions row.
 *
 * Written down once because the recipe is three decisions that only work together: `py-1.5` is the
 * room {@link STRIP_TAP_TARGET} reaches into for its 44px floor, `min-w-0` lets the row shrink
 * inside its flex parent instead of pushing its neighbours off, and the two scrollbar rules hide
 * the one the platform would draw. Change one of them at a call site and that row quietly loses its
 * tap floor or its overflow.
 *
 * The "there is more this way" cue is NOT here any more. It used to be a mask that faded both ends
 * unconditionally, including the left, where nothing was hidden. It now belongs to
 * `ui/overflow-edges.tsx`, which measures the scroller and fades — and draws a chevron over — only
 * the side that actually hides something. Wrap this scroller in `OverflowEdges`; a bare one still
 * scrolls and simply says nothing about it.
 *
 * The horizontal padding is NOT here either: each row pairs its own `px-*` with the negative margin
 * that cancels it, and those two are one number (see LabelledStrip's note 3).
 */
export const STRIP_SCROLLER =
  "flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * The 32px face a button wears inside {@link STRIP_SCROLLER}, **belt-only** — the actions row and
 * the harness section import this directly (`actions-row.tsx`, `harness-bar.tsx`) and nothing else
 * does; the key rail and every other strip keep {@link STRIP_TAP_TARGET} unmodified. That is what
 * makes the next paragraph safe to do here and nowhere else.
 *
 * `before:inset-y-0` CANCELS {@link STRIP_TAP_TARGET}'s `-7px` vertical reach on this pill alone —
 * the horizontal half (`before:-inset-x-px`, next) stays. The belt's own scroller is `py-0`
 * (`actions-row.tsx`, "Option 6" of the belt-shade deck): with no padding round the 32px pill to
 * reach into, the vertical half of the floor had nowhere to go and overflowed the scroller's own
 * box by 6-7px on the bottom edge — measured with the reach in place and gone: `scrollHeight` 38
 * against a `clientHeight` of 32, dropping to 38 = 32 the moment the reach was disabled, with every
 * *visible* child box already reading exactly 32px (`getBoundingClientRect` on each, before and
 * after — the pseudo-element is what moved). Silent because it paints nothing: `before:content-['']`
 * is empty, so the only thing this loses is 12px of invisible touch margin round an already-32px
 * pill, still comfortably past the 24px WCAG AA floor. `cn()` at every call site resolves the two
 * `before:inset-y-*` utilities as one conflicting group and keeps the LAST one in the merged string —
 * this one, because it is appended after `${STRIP_TAP_TARGET}` below — so this is not a second,
 * competing rule left for the cascade to arbitrate; it is the one rule that survives.
 * `before:-inset-x-px` reaches the border edges rather than a neighbour, which is what
 * lets these sit at a 6px gap without two hit boxes overlapping. The caller adds its own colour and
 * typography; nothing about the box is a caller's to pick.
 *
 * `px-2` and not `px-2.5`: when the actions row's general half took its words back, five labelled
 * pills measured 416px against a 382px row, and the 10px came off here rather than off a label or
 * off the type size. It buys 5px a pill — 25px across the five general pills, 20px across a four-button
 * harness section — and it is ONE number for every pill in every strip on purpose, because the
 * actions row's two parts only read as one belt while their pills are the same box. The key rail wears
 * it too; its caps are mono and short, so it lost 5px a key and nothing else.
 *
 * `has-[>svg]:px-2` is not decoration and may not be dropped: `ui/button.tsx`'s `sm` size sets
 * `has-[>svg]:px-2.5`, and tailwind-merge does not read that as conflicting with a bare `px-*` —
 * different modifier, so both survive and the MODIFIED one wins on every pill that carries an icon,
 * which is all of them in the actions row. Measured: the bare number alone moved nothing at all.
 */
export const STRIP_ROW_PILL = `${STRIP_TAP_TARGET} before:-inset-x-px before:inset-y-0 h-8 min-w-11 shrink-0 touch-manipulation px-2 has-[>svg]:px-2 select-none`;

/**
 * A SECTION OF THE BELT — the rectangle a group of {@link STRIP_ROW_PILL}s sits in when it needs a
 * ground of its own inside the actions row. One caller today: the harness's commands.
 *
 * It replaced `STRIP_CAPSULE`, which drew two rounded floating capsules, because the actions row is
 * now one continuous band and the groups on it are parts of that band rather than objects dropped on
 * it (`components/actions-row.tsx` holds the whole argument). So: SQUARE corners, and the box spans
 * the belt's full inner height instead of floating inside it.
 *
 * **`h-8 py-0` is a fixed 32px box — the pill's own height, {@link STRIP_ROW_PILL}'s `h-8` — not a
 * reach into the scroller's padding.** It used to be `-my-1.5` paired with `py-1.5`: the section
 * grew 6px past its own flow box on top and bottom, and relied on the scroller's `py-1.5` being
 * exactly 6px to land back on the scroller's padding box. That broke the moment the belt's own
 * scroller went to `py-0` (`components/actions-row.tsx`, "Option 6" of the belt-shade deck): the
 * section still reached 6px past its flow box, but there was no padding left to reach INTO, so it
 * overflowed the scroller's own border box by 6px on each side — measured as `scrollHeight` 40
 * against `clientHeight` 34. Chromium hid the resulting scrollbar; WebKit let `scrollTop` settle on
 * the 6px and a vertical swipe on the belt could nudge it. A fixed 32px box has nothing to reach
 * into and nothing to overflow: it IS the pill's height, so `scrollHeight === clientHeight` in both
 * engines. `border-y-0`, folded into `border-x` below, is the other half of the same fix — a real
 * (if transparent) top/bottom border on an `h-8` box eats into its own content box and pushes a
 * 32px pill 1px past it on each side, reopening a 2px version of the same overflow.
 *
 * Two numbers remain, each measured against {@link STRIP_SCROLLER}:
 *
 *  1. **`px-1.5` and `gap-1.5` are the belt's own pill gap, 6px**, the same number the scroller uses
 *     between the general pills and this section. One gap everywhere is what makes the belt read as
 *     one strip: the section is told apart by its TINT, not by a wider gap around it.
 *  2. **`border-x border-transparent`** is reserved, never drawn by default. It is the §2 recipe — a
 *     section that needs a hairline on one edge (see the black-branded fallback in
 *     `harness-bar.tsx`) colours the reserved width instead of adding one, so the tinted and the
 *     untinted section are the same box to the pixel. Left and right only, not top and bottom: the
 *     section has never drawn a top or bottom border (`border-l-border` is the only colour override
 *     that exists), so dropping that pair's reserved width paints nothing different — it only frees
 *     the 2px `h-8` needs for the pill's own height.
 *
 * It owns the geometry and NOT the ground. The caller paints it.
 */
export const BELT_SECTION =
  "flex h-8 shrink-0 items-center gap-1.5 border-x border-transparent px-1.5 py-0";

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
  /** A ref onto the INNER scroller, for a caller that needs to read or drive its scroll position
   *  (e.g. {@link import("@/hooks/use-reveal-active").useRevealActive}). */
  scrollerRef?: RefObject<HTMLDivElement | null>;
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
export function LabelledStrip({
  label,
  className,
  scrollerClassName,
  scrollerRef,
  children,
}: LabelledStripProps) {
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
        ref={scrollerRef}
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
