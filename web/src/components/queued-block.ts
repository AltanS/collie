// The look of a queued message, shared by the native queue card (session-stream.tsx) and the held
// send rows above the composer (composer-held.tsx), so both read as "mine, and not sent yet".

/**
 * THE QUEUE: what the operator typed while the agent was busy.
 *
 * The operator's own colour, because it is the operator's own words, the same `status-working` well
 * `UserTurn` wears (`chat-cards.tsx`), at a lighter weight, so it reads as "mine, and not sent yet"
 * rather than as a turn the agent ignored. A uniform border with a soft shadow and no left accent,
 * per the house rule for a rounded box.
 *
 * Dashed, and that is the one thing carrying "not yet". A solid well would be indistinguishable from
 * a turn that has landed, which is the single mistake this row must not make.
 */
export const QUEUED_BLOCK =
  "mt-1 flex min-w-0 flex-col gap-1 rounded-md border border-dashed border-status-working/40 bg-status-working/5 px-3 py-2";
export const QUEUED_LABEL = "text-xs font-medium text-status-working";
/** The label row. The button, when there is one, is its only other child, at the right. */
export const QUEUED_HEAD = "flex min-h-7 items-center justify-between gap-2";
export const QUEUED_TEXT = "wrap-anywhere text-sm whitespace-pre-wrap text-foreground/80";
/**
 * The queue card's button ("Send now", "Cancel"): drawn 28px tall and bought up to the 44px floor as hit area (DESIGN.md §6), so the
 * card does not grow a row for it. `min-w-11` is the width half of the floor; the `::before` is the
 * height half and reaches into the card's own padding, never into the message text under it.
 */
export const QUEUED_BUTTON =
  "relative h-7 min-w-11 gap-1 px-2 text-xs before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']";
