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
