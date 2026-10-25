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
// keeps the journal as the source of the queued cards; the receipts add only rows that came back to the
// box, which no journal records as a queue. One reducer answer, never two cards for one message.
//
// Pure: no clock, no disk, no harness name.

import type { ReceiptQueued } from "../surface/queued.ts";
import type { TranscriptEntry } from "./types.ts";

export type { ReceiptQueued };

/**
 * How much earlier than a send's submit key a prompt's journal time may be and still count as that
 * send's. The journal's clock is the harness's and the receipt's is the bridge's, on one machine; the
 * slack covers a timestamp rounded down or written a moment ahead of the redraw.
 */
export const PROMPT_SKEW_MS = 2_000;

/** One row of the window's receipt queue on the wire: the request id, where it stands, and its text. */
export interface QueuedSendWire {
  requestId: string;
  state: "queued" | "returned";
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

/** What the window takes from the receipts: the rows on the wire, and the texts its `queued` list gains. */
export interface ReceiptQueueAnswer {
  rows: QueuedSendWire[];
  queued: string[];
}

/**
 * What the window answers from the receipts. A harness that records its queue in the journal gains no
 * `queued` text and shows only the returned rows; every other harness shows both.
 */
export function receiptQueue(
  sends: readonly ReceiptQueued[],
  entries: readonly TranscriptEntry[],
  recordsQueue: boolean,
): ReceiptQueueAnswer {
  const open = stillOpen(sends, entries).filter((send) => !recordsQueue || send.state === "returned");
  return {
    rows: open.map((send) => ({ requestId: send.requestId, state: send.state, text: send.text })),
    queued: open.flatMap((send) => (send.state === "queued" ? [send.text] : [])),
  };
}
