/**
 * A row whose whole face opens one thing (an About sheet), while the controls in it stay their own targets.
 *
 * The open action is ONE button, the row's name, so the keyboard and the screen reader meet one control with
 * the name it always had. Its `::after` is stretched over the whole row (`ROW_OPEN_ROW` is the positioned
 * box it fills), so a tap on the description, the places, the source line or the empty space is a tap on
 * that button. Nothing is nested: a switch, an Add or an Undo is a SIBLING of the button, and each one is
 * positioned (`ROW_OPEN_CONTROL`, or its own `relative`) so it stands above the stretched layer in the same
 * stacking order and takes its own taps. A tap on it never reaches the button.
 *
 * The press shows on the row's own ground, below the text, through `:has()` (DESIGN.md §2: paint only, no
 * box changes). The hover look waits for a pointer that hovers, so a tap on a phone leaves no tint behind
 * under the sheet it opened. The focus ring is drawn on the stretched layer, inside the row's edge, so it
 * reads as the row's ring and no ancestor clips it. `outline-solid` sets the style on the layer itself: the
 * button's own `outline-none` reaches the layer through the inherited `--tw-outline-style` (DESIGN.md §7.2).
 *
 * Settings, Tricks: a trick's row, an official entry before Add, and the Hill's built-in row.
 */
export const ROW_OPEN_ROW =
  "relative transition-colors [@media(hover:hover)]:has-[[data-row-open]:hover]:bg-muted/50 has-[[data-row-open]:active]:bg-muted/60";

/** The open button. Its `::after` fills the row; put `data-row-open` on it so the row can show the press. */
export const ROW_OPEN_BUTTON =
  "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-solid focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring";

/** A control inside such a row: above the stretched layer, so its taps stay its own. */
export const ROW_OPEN_CONTROL = "relative z-10";

/**
 * The switch of such a row (`ui/switch.tsx`, 24 by 44): above the layer, and a transparent `::before` 10px
 * above and below and 8px to each side, so its reach is the 44px floor (DESIGN.md §6). A near miss of the
 * switch toggles it rather than opening the sheet. The row's `gap-4` leaves the text 8px clear of the reach.
 */
export const ROW_OPEN_SWITCH = "relative z-10 before:absolute before:-inset-x-2 before:-inset-y-2.5 before:content-['']";
