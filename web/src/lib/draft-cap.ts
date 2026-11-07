// THE DRAFT FIELD'S CAP (Altan, 2026-11-07: "the input box was way too tall and I couldn't work, as I
// was reading and typing a response, we need to cap the max rows to a sane level").
//
// The field grows with its text and stops at the smaller of a number of text rows and a share of the
// height the person can see, then scrolls inside itself. "The height the person can see" is the
// visual viewport, so the cap is measured with the keyboard up (hooks/use-visible-height.ts).
//
// THE NUMBERS, FROM THE OWNER'S SCREENSHOT. A 1080x2424 phone (about 411x923 CSS px) with the keyboard
// up shows about 500 CSS px. The field stood at the old cap, `min(10rem, 30dvh)`, about 150px, so the
// box took about 200px of the 500 and the chat above it kept about 140px: six lines of reading. The
// cap first proposed for this fix, 8 rows and 35%, is about 184px and 175px on that phone, TALLER
// than the cap that was already too tall. So the share is 20% and the rows are 5: on that phone the
// field stops at about 100px (four lines of 15px text), the box at about 150px, and the chat gains
// about 50px. On a tall screen with no keyboard the rows answer first: five lines, then a scroll.

/** The most text rows the field shows before it scrolls. */
export const DRAFT_CAP_ROWS = 5;
/** The most of the visible height the field takes before it scrolls. */
export const DRAFT_CAP_SHARE = 0.2;
/** The field's line height as a multiple of its font size: `text-base`'s unitless 1.5. */
export const DRAFT_LINE_HEIGHT = 1.5;

export interface DraftCapInput {
  /** The draft text's font size in px (Settings → Terminal font → Draft text). */
  readonly fontPx: number;
  /** The field's own top and bottom padding together, in px: its box is `border-box`. */
  readonly paddingPx: number;
  /** The visible height in px: `visualViewport.height`, else `innerHeight`. */
  readonly visiblePx: number;
}

/**
 * The field's max height in whole px: the smaller of {@link DRAFT_CAP_ROWS} rows and
 * {@link DRAFT_CAP_SHARE} of the visible height, and never less than one row, so a short landscape
 * screen still shows the line being typed.
 */
export function draftCapPx({ fontPx, paddingPx, visiblePx }: DraftCapInput): number {
  const line = fontPx * DRAFT_LINE_HEIGHT;
  const rows = DRAFT_CAP_ROWS * line + paddingPx;
  const share = DRAFT_CAP_SHARE * visiblePx;
  const floor = line + paddingPx;
  return Math.round(Math.max(floor, Math.min(rows, share)));
}
