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
// A DOOR'S SEND (ADR 0141 point 4) is proved by the same rule, and the proof is written back: the
// window answers which door sends the journal settled (`DoorProof`), and the Send Protocol records it on
// the receipt. A prompt equal to the text lands it. A door send no equal prompt claims, whose NEXT
// prompt in the journal (the first one written no earlier than its submit less the skew) contains its
// text without equalling it, was merged or changed on the way in: the agent merged it with a queued one,
// or an input handler rewrote it. Only the next prompt, so a short text ("ok") is never read into a
// later prompt the person typed at the desk, and never into a prompt another send landed as its own.
// The containing prompt is not claimed: two door sends folded into one
// turn are both merged. A screen send keeps the exact rule alone.
//
// The receipt cards ride only in `queuedSends`, never in the legacy `queued` list: a phone one release
// behind would draw them under its journal card with a Send now button that cannot work for them.
//
// Pure: no clock, no disk, no harness name.

import type { DoorProof, QueuedSendState, ReceiptQueued } from "../surface/queued.ts";
import type { TranscriptEntry } from "./types.ts";

export type { DoorProof, ReceiptQueued };

/**
 * How much earlier than a send's submit key a prompt's journal time may be and still count as that
 * send's. The journal's clock is the harness's and the receipt's is the bridge's, on one machine; the
 * slack covers a timestamp rounded down or written a moment ahead of the redraw.
 */
export const PROMPT_SKEW_MS = 2_000;

/**
 * One card of the window's receipt queue on the wire: the request id, where it stands, and its text.
 * `merged`: a door's send the journal shows only inside a longer or changed prompt (ADR 0141 point 4).
 */
export interface QueuedSendWire {
  requestId: string;
  state: QueuedSendState | "merged";
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

/** The sends the journal does not settle, and what it proved of the door sends it does. */
export interface Settled {
  readonly open: ReceiptQueued[];
  readonly proofs: DoorProof[];
}

/**
 * Each send, oldest first, loses its card to the first unclaimed prompt with its text written no earlier
 * than its submit key less {@link PROMPT_SKEW_MS}. A returned send counts too: its text landing as a
 * prompt (sent at the desk, or from the card) ends it. A door send that keeps its card is merged when its
 * next prompt holds its text (see the header); a send already marked merged is not proved again.
 */
export function settle(sends: readonly ReceiptQueued[], entries: readonly TranscriptEntry[]): Settled {
  if (sends.length === 0) return { open: [], proofs: [] };
  const prompts = entries.flatMap((entry) => {
    const prompt = promptOf(entry);
    return prompt === null ? [] : [prompt];
  });
  const claimed = new Set<number>();
  const open: ReceiptQueued[] = [];
  const proofs: DoorProof[] = [];
  for (const send of sends.toSorted((a, b) => a.at - b.at)) {
    const text = folded(send.text);
    const landed = prompts.findIndex((prompt, i) => !claimed.has(i) && prompt.text === text && prompt.at >= send.at - PROMPT_SKEW_MS);
    if (landed === -1) {
      open.push(send);
      continue;
    }
    claimed.add(landed);
    if (send.door === true) proofs.push({ requestId: send.requestId, how: "landed" });
  }
  for (const send of open) {
    if (send.door !== true || send.merged === true) continue;
    const text = folded(send.text);
    const at = prompts.findIndex((prompt) => prompt.at >= send.at - PROMPT_SKEW_MS);
    // A prompt another send landed as its own is that send's, never this one's merge.
    const next = at === -1 || claimed.has(at) ? undefined : prompts[at];
    if (next !== undefined && text !== "" && next.text !== text && next.text.includes(text)) proofs.push({ requestId: send.requestId, how: "merged" });
  }
  return { open, proofs };
}

/** The window's receipt cards, and what the journal proved of the door sends among them. */
export interface ReceiptCards {
  readonly cards: QueuedSendWire[];
  readonly proofs: DoorProof[];
}

/**
 * The window's receipt cards: the sends the journal does not show as a prompt yet, less every card whose
 * text the journal lists as queued, and, for a harness that records its queue, less every card that is
 * neither back in the box nor merged. Beside them, what the journal proved of the door sends.
 */
export function receiptQueue(
  sends: readonly ReceiptQueued[],
  entries: readonly TranscriptEntry[],
  recordsQueue: boolean,
  journalQueued: readonly string[],
): ReceiptCards {
  const listed = new Set(journalQueued.map(folded));
  const { open, proofs } = settle(sends, entries);
  const merged = new Set(proofs.flatMap((proof) => (proof.how === "merged" ? [proof.requestId] : [])));
  const cards = open
    .map((send): QueuedSendWire => ({ requestId: send.requestId, state: send.merged === true || merged.has(send.requestId) ? "merged" : send.state, text: send.text }))
    .filter((card) => (!recordsQueue || card.state === "returned" || card.state === "merged") && !listed.has(folded(card.text)));
  return { cards, proofs };
}
