/**
 * The 44px tap floor, bought back as HIT AREA by the two buttons inside the composer's box.
 *
 * DESIGN.md §6 states the floor and also states this trade: where drawn height is expensive, a
 * control may measure less and reach out with a transparent `::before`, exactly as
 * `STRIP_TAP_TARGET` does for the strips. It is expensive here. The two buttons stand INSIDE the
 * composer's box, on the field's own row, so their face sets the height of an empty composer, and
 * every pixel of it is a pixel of mirror the operator stops seeing.
 *
 * The arithmetic, and it is the whole reason this is a constant and not a class at two call sites:
 * the face is `size-9`, 36px, and `-inset-1` reaches 4px out on all four sides, so 36 + 8 = 44 in
 * BOTH axes. The box's own `p-1` is 4px, so the reach stays inside the border and the box's inner
 * height is exactly that 44px: one row. Beside the field the reach runs into the row's `gap-1`, so
 * no hit box crosses the textarea's own edge. Change the face, the inset, the box's padding or the
 * gap and all of these facts must be re-checked together (ADR 0057, amended 2026-09-22).
 */
export const TOOLBAR_TAP_TARGET = "relative before:absolute before:-inset-1 before:content-['']";

// Also worn by the voice takeover's OK and trash (components/voice-takeover.tsx), so OK stands on the
// mic's own 44px reach, in the same box.

// ── THE DASHBOARD'S FIVE SHORT TARGETS (hitbox investigation, proposal 6) ──────────────────────────
//
// Five controls on the dashboard drew less than the 44px floor with nothing to stop them reaching out:
// the session pill (81x26), the summary line (314x32), a section heading's fold button (289x36), the
// "+" that adds a space (36x36) and the spaces filter. Each buys the floor back as HIT AREA with a
// transparent `::before`, the move `STRIP_TAP_TARGET` makes, and each constant below states its own
// arithmetic, because a `::before` resolves its insets against the PADDING box, 1px inside a border.
//
// THE RULE EVERY ONE OF THEM OBEYS: the reach may not overlap a neighbour's visible box. It is
// measured, not argued: `web/e2e/hitbox/census.run.ts` reads every target's hit rectangle and flags a
// neighbour that a reach covers (REGRESSIONS.md, proposal 6).

/**
 * The 26px bordered pills in the app header (the session pill, the host pill). 24px of padding box
 * plus `-10px` on both sides is 44, vertical only: the header row is 48px and the pills stand 4px apart,
 * so the reach stays inside the row and never touches a pill's neighbour. Change the pill's height,
 * its border, or the header's row and this must be re-measured.
 */
export const HEADER_PILL_TAP_TARGET =
  "relative before:absolute before:inset-x-0 before:-inset-y-[10px] before:content-[''] active:before:-inset-x-[3%]";

/**
 * The dashboard's summary line: a 32px button with no border inside a 44px row (`min-h-11`, items
 * centred), so `-6px` above and below is 44 and ends exactly on the row's edges. Only where that row
 * exists: alone, the line has 4px of gap below it, and 6px of reach would lie over the next row.
 */
export const SUMMARY_LINE_TAP_TARGET = "relative before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']";

/**
 * A foldable section heading's button: 36px (`min-h-9`) with no border, `-4px` above and below is 44.
 * The sections are `gap-2` (8px) apart, so the reach never lies over the group beneath it.
 */
export const HEADING_TAP_TARGET = "relative before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

/**
 * A square 36px button with no border: `-4px` on every side is 44 by 44. It stands in a trailing slot
 * whose `gap-1` is exactly that 4px, so two of them, or one beside a count, touch and never overlap.
 */
export const SQUARE_36_TAP_TARGET = "relative before:absolute before:-inset-1 before:content-['']";

// ── A PRESS MAY NOT SHRINK THE HIT AREA (hitbox investigation, proposal 5) ─────────────────────────────
//
// `active:scale-95` scales the element's box about its centre, and the hit area goes with it: a pill 81px
// wide loses 2px at each edge, the floating button 2.4px, so a tap that lands in that rim is aimed at
// whatever lies beneath the shrunken box (for the floating button, a row: a tap on "New" opens a pane).
// Measured with real touches, any press length from 40ms (REGRESSIONS.md, proposal 5).
//
// The fix keeps the look and gives the hit area back. WHILE PRESSED only, the element grows a
// transparent `::before` reaching out by the share the scale takes away. At rest there is no pseudo-element
// at all, so no rest geometry changes and no neighbour can be covered by a reach that is not there. It
// needs no `relative`: a non-`none` `scale` makes the element the containing block of its absolute
// descendants, and it is only ever drawn while `scale` is set.
//
// 3% each way is the 95% scale's loss (2.6%) rounded up; the 98% of `Button` loses 1%, so it takes 1.5%.

/** For an element that scales to 95% while pressed and has no `::before` of its own. */
export const PRESS_REACH = "active:before:absolute active:before:-inset-[3%] active:before:content-['']";

/**
 * For `Button`, which scales to 98% while pressed and is worn by callers that bring a reach of their own
 * (`TOOLBAR_TAP_TARGET`, the belt's pills). It is the class `.press-reach-soft` in `index.css`, 1.5% each way,
 * at zero specificity and below the utilities layer: a caller's reach always wins and is never shrunk by the
 * press, where an `active:before:` utility (0,2,1) would beat it.
 */
export const PRESS_REACH_SOFT = "press-reach-soft";

/** For a full-width row that scales to 99%: sideways only, so the next row's edge is never covered. */
export const PRESS_REACH_ROW = "active:before:absolute active:before:-inset-x-[1%] active:before:inset-y-0 active:before:content-['']";

/**
 * The compact New button in a sheet's title row (`FabButton size="compact"`): 32px tall with a 1px border, so
 * a 30px padding box, and `-7px` above and below is 44. Vertical only: the face is wider than 44px, and
 * its neighbour, the close button, stands 4px to its right with a hit area of its own. The reach lies in
 * the grab handle's row above and the title row's `pb-3` below, which hold no control. While pressed
 * (`active:scale-95`) it also reaches 3% sideways, as `HEADER_PILL_TAP_TARGET` does, so the shrunken
 * face never loses the rim.
 */
export const SHEET_ACTION_TAP_TARGET =
  "relative before:absolute before:inset-x-0 before:-inset-y-[7px] before:content-[''] active:before:-inset-x-[3%]";
