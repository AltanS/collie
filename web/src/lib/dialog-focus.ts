// The composer's "Answer the dialog" word is a way TO the dialog card, not a send. It scrolls the card
// dock into view and puts focus on the card's first action button, so a phone user whose keyboard is
// up lands on the card with one tap. It sends no text and no key: the answer is still the card's own
// race-guarded button (field case 2026-10-15, ADR 0009).

/** Scroll the dock into view and focus its first enabled ANSWER button. The card's own terminal/back
 *  toggle is skipped: it changes the card's view, it does not answer it. Returns whether a button took
 *  focus. */
export function focusDialogCard(dock: HTMLElement | null): boolean {
  if (dock === null) return false;
  dock.scrollIntoView({ block: "nearest" });
  const first = dock.querySelector<HTMLButtonElement>('button:not([disabled]):not([data-slot="card-view-toggle"])');
  if (first === null) return false;
  first.focus();
  return true;
}
