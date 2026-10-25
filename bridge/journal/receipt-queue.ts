// The live window's queue, filled from Collie's own receipts (ADR 0122). A send into a running turn
// settles `sent` + `queued`, and most harnesses write nothing about the wait into their journal until
// the turn yields, so their reducer answers no queue at all (`RowReducer.queued`). Collie's receipts
// do know: the Send Protocol keeps every open queued send with its text (bridge/surface/queued.ts).
//
// THE RULE: a queued send is a card until the journal shows its text as a prompt. A `user` turn the
// window holds, written no earlier than the send's submit key (less a small clock skew), whose text
// equals the send's text with white space folded, takes ONE send off the list, oldest first, the way
// Claude Code's reducer lets one delivery clear one place. Two identical texts queued are two cards,
// and one prompt clears one of them.
//
// A harness whose journal DOES record its queue (`JournalAdapter.recordsQueue`, Claude Code and Muse)
// keeps the journal as the source of the queued cards; the receipts add only cards that came back to the
// box, which no journal records as a queue. That flag is an optimisation, not the guard: a receipt card
// whose folded text equals a text the journal lists as queued is never drawn, whatever the flag says,
// so a message is never drawn twice even when an adapter starts recording its queue.
//
// The receipt cards ride only in `queuedSends`, never in the legacy `queued` list: a phone one release
// behind would draw them under its journal card with a Send now button that cannot work for them.
//
// Pure: no clock, no disk, no harness name.

import type { QueuedSendState, ReceiptQueued } from "../surface/queued.ts";
import type { TranscriptEntry } from "./types.ts";

export type { ReceiptQueued };

/**
 * How much earlier than a send's submit key a prompt's journal time may be and still count as that
 * send's. The journal's clock is the harness's and the receipt's is the bridge's, on one machine; the
 * slack covers a timestamp rounded down or written a moment ahead of the redraw.
 */
export const PROMPT_SKEW_MS = 2_000;

/** One card of the window's receipt queue on the wire: the request id, where it stands, and its text. */
export interface QueuedSendWire {
  requestId: string;
  state: QueuedSendState;
  text: string;
}

/** A text as this rule compares it: every run of white space one space, the ends cut. */
function folded(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** A turn's prompt text and journal time, or null when it is no prompt the operator wrote. */
function promptOf(entry: TranscriptEntry): { text: string; at: number } | null {
  if (entry.role !== "user" || entry.abandoned === true) return null;
  const text = folded(entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n"));
  const at = Date.parse(entry.ts);
  if (text === "" || Number.isNaN(at)) return null;
  return { text, at };
}

/**
 * The sends still open after the journal: each send, oldest first, loses its card to the first
 * unclaimed prompt with its text written no earlier than its submit key less {@link PROMPT_SKEW_MS}.
 * A returned send counts too: its text landing as a prompt (sent at the desk, or from the card) ends it.
 */
export function stillOpen(sends: readonly ReceiptQueued[], entries: readonly TranscriptEntry[]): ReceiptQueued[] {
  if (sends.length === 0) return [];
  const prompts = entries.flatMap((entry) => {
    const prompt = promptOf(entry);
    return prompt === null ? [] : [prompt];
  });
  const claimed = new Set<number>();
  const open: ReceiptQueued[] = [];
  for (const send of sends.toSorted((a, b) => a.at - b.at)) {
    const text = folded(send.text);
    const landed = prompts.findIndex((prompt, i) => !claimed.has(i) && prompt.text === text && prompt.at >= send.at - PROMPT_SKEW_MS);
    if (landed === -1) open.push(send);
    else claimed.add(landed);
  }
  return open;
}

/**
 * The window's receipt cards: the sends the journal does not show as a prompt yet, less every card whose
 * text the journal lists as queued, and, for a harness that records its queue, less every card that is
 * not back in the box.
 */
export function receiptQueue(
  sends: readonly ReceiptQueued[],
  entries: readonly TranscriptEntry[],
  recordsQueue: boolean,
  journalQueued: readonly string[],
): QueuedSendWire[] {
  const listed = new Set(journalQueued.map(folded));
  return stillOpen(sends, entries)
    .filter((send) => (!recordsQueue || send.state === "returned") && !listed.has(folded(send.text)))
    .map((send) => ({ requestId: send.requestId, state: send.state, text: send.text }));
}
