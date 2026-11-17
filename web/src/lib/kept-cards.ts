import type { QueuedSendRow } from "@/lib/types";

// THE QUEUED CARD THE PHONE KEEPS (the M102 review 3). A queued card's Send again drops the card on the bridge
// first, then asks the composer to send its text. When the composer refuses after the drop and the box holds a
// draft, the card's words are not put after the draft (the next Send would send both as one message): the card
// stays a card, drawn by the phone in place of the one the bridge dropped, with the same Send again and Discard.
//
// Memory only, per pane address, so a pane switch keeps it and a reload does not. The text is a message the person
// already sent once, never a sign-in code: a code is never kept for a resend (the M102 review, A), and its send
// never reaches a queued card.

/** The request id prefix of a card the phone keeps: the pane view answers its taps itself, never the bridge. */
export const KEPT_PREFIX = "kept:";

/** Per pane address: the dropped card's request id, and its text while the kept card stands (null once it ended). */
const kept = new Map<string, Map<string, string | null>>();

/** Keep the card the bridge dropped, by its own request id, on this pane. */
export function keepCard(address: string, requestId: string, text: string): void {
  const cards = kept.get(address) ?? new Map<string, string | null>();
  cards.set(requestId, text);
  kept.set(address, cards);
}

/** End a kept card (its Send again went, or its Discard): it is not drawn again, nor is the card it replaced. */
export function endKeptCard(address: string, keptId: string): void {
  const requestId = keptId.slice(KEPT_PREFIX.length);
  kept.get(address)?.set(requestId, null);
}

/** Whether a card's request id names a card the phone keeps. */
export function isKept(requestId: string): boolean {
  return requestId.startsWith(KEPT_PREFIX);
}

/**
 * The receipt cards to draw on this pane: the window's own, less every card the phone kept in its place, then the
 * kept cards still standing. The same array when this pane keeps nothing.
 */
export function withKeptCards(address: string, rows: readonly QueuedSendRow[]): readonly QueuedSendRow[] {
  const cards = kept.get(address);
  if (cards === undefined || cards.size === 0) return rows;
  const own = rows.filter((row) => !cards.has(row.requestId));
  const standing: QueuedSendRow[] = [];
  for (const [requestId, text] of cards) {
    if (text !== null) standing.push({ requestId: `${KEPT_PREFIX}${requestId}`, state: "unconfirmed", text });
  }
  return [...own, ...standing];
}

/** Tests only: forget every kept card. */
export function __forgetKeptCards(): void {
  kept.clear();
}
