// THE MOMENT OF ANSWERING, IN TIME (2026-11-10). One calm sequence after a tap on a Decision card:
//
//  1. ACKNOWLEDGE, 0 to HILL_ACK_MS: the tapped option (or Dismiss) takes the chosen look in place and
//     the others dim. Nothing changes height.
//  2. SETTLE, then PRESENCE_MS (240 ms, ui/presence.tsx): the options cross-fade to the one status line
//     ("Sending…", then the receipt) while the card's height eases between the two.
//  3. LEAVE, PRESENCE_MS: once the list says the decision is closed, the card collapses in place and
//     the cards below glide up; a priority group whose last card it was leaves with it.
//  4. ARRIVE: the closed row grows in at the top of Answered.
//
// The list is read again HILL_LIST_READ_AFTER_MS after the tap (lib/hill/store.ts, `readHillNow`), so
// on a quick network the new list lands about when the settle ends and the leave follows it at once.

/** How long the chosen option shows in place before the options give way to the status line, in ms. */
export const HILL_ACK_MS = 100;

/** When, after the tap, an answer that closed its decision reads the list again, in ms. */
export const HILL_LIST_READ_AFTER_MS = 260;
