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
// ONE EXCEPTION, and it is the journal's own place, not a receipt card: a harness that records its
// queue can record a place with no words (`RowReducer.unnamedQueued`; Claude Code while it compacts).
// The journal then says a message waits and cannot say which, so the open queued sends give those
// places their words when they are no more than the places (`unnamedFill`), and the text rides in `queued` because it IS the journal's
// card, with the journal's Send now, the one the harness draws for it too.
//
// THE HARNESS'S OWN SPELLING. "The same text" above means equal after white space is folded, OR a text the
// harness wrote in its own words for the one Collie sent (`JournalAdapter.spellsSend`): Claude Code writes an
// attached picture's path as `[Image #N]` in its queue row and in the prompt, so a send of a screenshot never
// equals its journal place by text. The adapter answers as data, beside the harness's own paste grammar; this
// file only asks. A place the adapter matches is drawn in the send's own words (`spelledQueue`), so the card
// shows what the person sent and the phone's own line for the send hands over to it (lib/durable-pending.ts).
//
// ONE PLACE, ONE SEND. A journal place absorbs at most one send and a send at most one place, oldest send
// first, an equal text before a spelling. Two pictures sent as two messages need two places: one place hides
// one of them, never both. A wrong "same" hides a message that waits; a wrong "different" only shows it twice,
// so the adapter's answer is strict and short is the safe side.
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

/**
 * Whether `written`, a text the journal holds (a queued place or a prompt), can be the harness's own spelling
 * of `sent`, the text Collie sent, when the two are not equal by text (`JournalAdapter.spellsSend`).
 */
export type SpellsSend = (sent: string, written: string) => boolean;

/** No spelling of its own: only an equal text is the same message. */
const LITERAL: SpellsSend = () => false;

/** A text as this rule compares it: every run of white space one space, the ends cut. */
function folded(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** How one send meets one journal text: `equal` by folded text, `spelled` by the harness's grammar, or not at all. */
function meets(send: string, written: string, spells: SpellsSend): "equal" | "spelled" | null {
  if (folded(send) === folded(written)) return "equal";
  return spells(send, written) ? "spelled" : null;
}

/**
 * Which journal place each send takes, ONE PLACE PER SEND AND ONE SEND PER PLACE: oldest send first, and every
 * equal text before any spelling, so a send's own words are never taken by another send's picture form.
 * Answers, per place index, the send that took it and how.
 */
function claimPlaces(
  sends: readonly ReceiptQueued[],
  places: readonly string[],
  spells: SpellsSend,
): Map<number, { send: ReceiptQueued; how: "equal" | "spelled" }> {
  const taken = new Map<number, { send: ReceiptQueued; how: "equal" | "spelled" }>();
  const placed = new Set<ReceiptQueued>();
  const ordered = sends.toSorted((a, b) => a.at - b.at);
  for (const how of ["equal", "spelled"] as const) {
    for (const send of ordered) {
      if (placed.has(send)) continue;
      const at = places.findIndex((place, i) => !taken.has(i) && meets(send.text, place, spells) === how);
      if (at === -1) continue;
      taken.set(at, { send, how });
      placed.add(send);
    }
  }
  return taken;
}

/** The sends no journal place takes ({@link claimPlaces}), in the order given. */
function unplaced(sends: readonly ReceiptQueued[], places: readonly string[], spells: SpellsSend): ReceiptQueued[] {
  const placed = new Set([...claimPlaces(sends, places, spells).values()].map((claim) => claim.send));
  return sends.filter((send) => !placed.has(send));
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
 * unclaimed prompt with its text (or the harness's spelling of it, {@link SpellsSend}) written no
 * earlier than its submit key less {@link PROMPT_SKEW_MS}. A returned send counts too: its text
 * landing as a prompt (sent at the desk, or from the card) ends it.
 */
export function stillOpen(sends: readonly ReceiptQueued[], entries: readonly TranscriptEntry[], spells: SpellsSend = LITERAL): ReceiptQueued[] {
  if (sends.length === 0) return [];
  const prompts = entries.flatMap((entry) => {
    const prompt = promptOf(entry);
    return prompt === null ? [] : [prompt];
  });
  const claimed = new Set<number>();
  const open: ReceiptQueued[] = [];
  for (const send of sends.toSorted((a, b) => a.at - b.at)) {
    const after = (prompt: { at: number }, i: number) => !claimed.has(i) && prompt.at >= send.at - PROMPT_SKEW_MS;
    const equal = prompts.findIndex((prompt, i) => after(prompt, i) && meets(send.text, prompt.text, LITERAL) === "equal");
    const landed = equal !== -1 ? equal : prompts.findIndex((prompt, i) => after(prompt, i) && meets(send.text, prompt.text, spells) === "spelled");
    if (landed === -1) open.push(send);
    else claimed.add(landed);
  }
  return open;
}

/**
 * The journal's queued places, each one a send takes by the harness's spelling ({@link claimPlaces}) given that
 * send's own words: the card then shows what the person sent (the picture's path and the words beside it, not a
 * bare `[Image #24]`), and the phone's line for that send finds its text on the card and hands over to it.
 * A place equal by text, or taken by no send, keeps the journal's words. Only sends still open count.
 */
export function spelledQueue(
  sends: readonly ReceiptQueued[],
  entries: readonly TranscriptEntry[],
  journalQueued: readonly string[],
  spells: SpellsSend = LITERAL,
): string[] {
  if (sends.length === 0 || journalQueued.length === 0) return [...journalQueued];
  const claims = claimPlaces(stillOpen(sends, entries, spells), journalQueued, spells);
  return journalQueued.map((place, i) => {
    const claim = claims.get(i);
    return claim?.how === "spelled" ? claim.send.text : place;
  });
}

/**
 * The window's receipt cards: the sends the journal does not show as a prompt yet, less every card a
 * place the journal lists as queued takes (one place, one card), and, for a harness that records its
 * queue, less every card that is not back in the box.
 */
export function receiptQueue(
  sends: readonly ReceiptQueued[],
  entries: readonly TranscriptEntry[],
  recordsQueue: boolean,
  journalQueued: readonly string[],
  spells: SpellsSend = LITERAL,
): QueuedSendWire[] {
  return unplaced(stillOpen(sends, entries, spells), journalQueued, spells)
    .filter((send) => !recordsQueue || send.state === "returned")
    .map((send) => ({ requestId: send.requestId, state: send.state, text: send.text }));
}

/**
 * The words for the places a journal holds without any (`RowReducer.unnamedQueued`): the texts of the
 * sends still `queued` and still open after the journal, less every text the journal already lists, in
 * send order. NO GUESS AMONG SEVERAL: only when those sends are no more than the places does each get
 * one; more sends than places draws nothing, as before this rule, because the log cannot say which of
 * them the places hold. Fewer sends than places leaves the rest unnamed, which draws nothing too (a
 * message queued at the terminal has no receipt). Short is the safe side.
 */
export function unnamedFill(
  sends: readonly ReceiptQueued[],
  entries: readonly TranscriptEntry[],
  journalQueued: readonly string[],
  unnamed: number,
  spells: SpellsSend = LITERAL,
): string[] {
  if (unnamed <= 0 || sends.length === 0) return [];
  const open = stillOpen(sends, entries, spells).filter((send) => send.state === "queued");
  const waiting = unplaced(open, journalQueued, spells);
  if (waiting.length > unnamed) return [];
  return waiting.map((send) => send.text);
}
