// THE OPERATOR'S WELL, in one place. Every surface that draws the person's own words as a well reads
// these strings, so the resting turn (chat-cards.tsx), the History turn (transcript-view.tsx) and the
// prompt pin that holds a turn at the top of Chat (prompt-pin.tsx) cannot drift apart. When the pin
// had its own copy, the pin kept the old full-width layout after the turn leaned right, and the
// message jumped sideways the moment it stuck (found on a phone, 2026-11-10).

/** The well itself: orange wash, hairline, radius, padding. */
export const USER_WELL = "rounded-md border border-status-working/25 bg-status-working/8 px-3 py-2";

/** The hugging look (`ChatLook.userTurn` "hug"): the well sizes to its text, at most 85 percent of the column, at the right. */
export const USER_WELL_HUG = "ml-auto w-fit max-w-[85%]";

/** The words in the well: content type (DESIGN.md §5), small. */
export const USER_WELL_TEXT = "font-content whitespace-pre-wrap break-words text-sm";

/**
 * The line of small print at the well's right edge: the time, and at rest the pending clock and the walky
 * note beside it. In the resting turn it floats at the right of the text's last line, so a short line costs no
 * second row. The prompt pin (a fixed two-line box that clamps its text) cannot float it after text it
 * hides, so it makes the same element a flex item at the well's right edge, first line: a float does nothing
 * on a flex item, and every other class here is the same. `ml-3` is the gap between the words and the time.
 */
export const USER_WELL_META = "float-right mt-1 ml-3 flex h-4 items-center gap-1 font-sans text-[10px] font-medium tabular-nums text-status-working";

/** The time inside {@link USER_WELL_META}. */
export const USER_WELL_TIME = "opacity-80";
