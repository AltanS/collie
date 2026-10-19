import type { TranscriptEntry } from "@/lib/types";
import { normalizePrompt } from "@/lib/surface/edges";

// A SEND THAT ENDED `unknown`, REMEMBERED UNTIL THE JOURNAL SETTLES IT (#511).
//
// The bridge could not tell whether the text went through, so the composer keeps the draft and says
// so. The person's way out is by hand (Keys → Enter), and when that works the exchange lands in Chat
// — but nothing used to connect the two, so the notice and the kept draft stood over a conversation
// that had plainly happened, one Send tap away from sending the text twice. The journal's own user
// turn is the evidence: a NEW user turn (never one already on screen when Send was tapped), carrying
// exactly the text the send typed, timestamped no earlier than the tap. Manual recovery has no
// clock — minutes may pass at the desk — so there is deliberately NO upper bound like
// `durable-pending`'s 30 seconds; the uuid's novelty is what makes a late match honest. One record
// is consumed by one turn, and anything short of this exact match retires nothing: the draft is
// kept, which is the safe side to be wrong on. A turn carrying another send's `requestId` (durable
// panes only) is that send's line and never text-matches, the house rule `durable-pending` keeps.

/** One unknown-outcome send, remembered by the composer for this pane view only. */
export interface UnknownSend {
  /** The line the send typed: the draft with every chip marker swapped for its path. */
  sentText: string;
  /** The field's own words at the tap (markers and all) — the draft is cleared only while it still reads exactly this. */
  draftText: string;
  /** Whether the send carried the field's draft, as against a quick reply or a command. */
  isDraft: boolean;
  /** When the send started, milliseconds since the epoch. A matching turn is never earlier. */
  at: number;
  /** Every journal uuid on screen when the send started: none of those can be this send's landing. */
  seenUserUuids: ReadonlySet<string>;
}

/** The text of a turn: its text parts, joined, as `durable-pending` reads them. */
function wordsOf(entry: TranscriptEntry): string {
  return entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
}

/**
 * The user turn that proves `pending` went through, or undefined while there is no such proof.
 * PURE. Both sides are read as the bridge hashes a typed prompt (`normalizePrompt`), so a journal
 * that stores `\r\n` still matches the line the send typed.
 */
export function findUnknownSendMatch(
  pending: UnknownSend,
  entries: readonly TranscriptEntry[],
): TranscriptEntry | undefined {
  const wanted = normalizePrompt(pending.sentText);
  return entries.find((entry) => {
    if (entry.role !== "user" || entry.abandoned === true || entry.requestId !== undefined) return false;
    if (pending.seenUserUuids.has(entry.uuid)) return false;
    const landed = Date.parse(entry.ts);
    if (Number.isNaN(landed) || landed < pending.at) return false;
    return normalizePrompt(wordsOf(entry)) === wanted;
  });
}
