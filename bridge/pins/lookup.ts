// Which block a Chat item id names, found in the journal's own entries (M90). The phone sends the id
// it draws (web/src/lib/chat-items.ts `itemsOf`); the bridge finds the block in the log it reads for
// that pane and copies the text itself, so a pin never holds a word the phone typed.
//
// The id rule is the phone's, restated: a tool part's own id where the harness gave one (Claude's
// `tool_use_id`), else `<entry.uuid>:<partIndex>`. `lookup.test.ts` holds the two in step by running
// the same entries through both. It reads `TranscriptEntry[]` and nothing else, so it is the same for
// every harness: an adapter that fills `uuid`, `parts` and a tool part's `id` is pinnable.

import { MAX_TEXT_CHARS } from "../journal/text.ts";
import type { TranscriptEntry, TranscriptPart } from "../journal/types.ts";
import type { PinDraft, PinKind } from "./store.ts";

export type PinLookup =
  | { readonly ok: true; readonly draft: PinDraft }
  | { readonly ok: false; readonly reason: "not_found" | "not_pinnable" };

const NOT_FOUND = { ok: false, reason: "not_found" } as const;
const NOT_PINNABLE = { ok: false, reason: "not_pinnable" } as const;

function idOf(entry: TranscriptEntry, part: TranscriptPart, index: number): string {
  return part.kind === "tool" && part.id ? part.id : `${entry.uuid}:${index}`;
}

function speechKind(role: TranscriptEntry["role"]): PinKind {
  if (role === "user") return "user";
  if (role === "assistant") return "reply";
  return "notice";
}

function draftOf(entry: TranscriptEntry, part: TranscriptPart, itemId: string): PinLookup {
  const ts = entry.ts === "" ? {} : { ts: entry.ts };
  if (part.kind === "image") return NOT_PINNABLE;
  if (part.kind === "tool") {
    const input = part.summary === "" ? {} : { input: part.summary };
    // The result as the journal capped it: Chat draws that text and so does the pin.
    return { ok: true, draft: { itemId, kind: "tool", text: part.result?.text ?? "", tool: { name: part.name, ...input }, ...ts } };
  }
  // Chat draws no block for a blank text or thinking part, so there is nothing to pin.
  if (part.text.trim() === "") return NOT_FOUND;
  const kind: PinKind = part.kind === "thinking" ? "thinking" : speechKind(entry.role);
  return { ok: true, draft: { itemId, kind, text: part.text.slice(0, MAX_TEXT_CHARS), ...ts } };
}

/**
 * The block `itemId` names, or why there is none: `not_found` when no entry holds it (the id is
 * wrong, or the turn lies outside what the journal reader holds for this log), `not_pinnable` for
 * the two kinds Chat draws that carry no pinnable text, an image and a compaction marker.
 */
export function findPinnable(entries: readonly TranscriptEntry[], itemId: string): PinLookup {
  for (const entry of entries) {
    // A compaction is one item, `<uuid>:0`, whatever parts its recap holds.
    if (entry.role === "summary") {
      if (`${entry.uuid}:0` === itemId) return NOT_PINNABLE;
      continue;
    }
    for (const [index, part] of entry.parts.entries()) {
      if (idOf(entry, part, index) === itemId) return draftOf(entry, part, itemId);
    }
  }
  return NOT_FOUND;
}
