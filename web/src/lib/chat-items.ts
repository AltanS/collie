// A journal turn as the blocks Chat draws.
//
// The journal answers in `TranscriptEntry[]` — one turn holding several parts — and a card draws ONE
// thing. This is the whole distance between the two, and it is small on purpose: the tool vocabulary
// on both sides is already the same ten kinds (`bridge/journal/tool-call.ts`), so what is left is a
// role-to-kind table, an `output` field, and a status.
//
// It lives beside the cards rather than in the bridge because it is a VIEW decision. Whether a
// compaction summary reads as speech or as a notice, whether a picture the agent drew is drawn inline,
// and whether a denied call is drawn like a failed one are all questions about what the
// reader sees; the bridge has already said everything it knows by the time an entry gets here.
//
// Nothing in it is async, touches the DOM or imports React, so every rule in it is table-testable.

import type { ToolCall, TranscriptEntry, TranscriptPart } from "./types";
import { firstLine, parseEnvelopeHeader, type EnvelopeHeader } from "./walky";

/** What became of a tool call, as a card colours it. */
export type ChatToolStatus = "running" | "done" | "failed" | "denied";

/**
 * The five kinds whose card can show what the call PRINTED, given the room.
 *
 * The others have nothing to print: an edit draws its diff, a read draws its range, a delete leaves
 * no output at all, and a plan's result is the list the card already draws (ADR 0119). Writing the
 * union as a conditional over {@link ToolCall} rather than as a second list of branches is what stops
 * the two from drifting when another kind lands.
 */
type WithOutput<T> = T extends { kind: "execute" | "search" | "fetch" | "task" | "other" }
  ? T & { output?: string }
  : T;

/** A tool call as a card draws it: the journal's own call, plus what it printed where that fits. */
export type ChatToolCall = WithOutput<ToolCall>;

/**
 * One block of the stream.
 *
 * `id` is the part's own id where the harness gave it one (a tool call's `tool_use_id`), so a host
 * with something waiting on a call can name the card directly, with no table in between.
 */
export type ChatItem =
  // `requestId`: the send that made this line, when the program says so (a durable pane): the phone's own pending line
  // is matched to it and replaced (lib/durable-pending.ts).
  // `walky`: the turn's first line is a walky talky envelope header (lib/walky.ts). A CLAIM, not a fact:
  // the card draws only when the pane's own log holds the id (components/walky-card.tsx).
  | { id: string; ts?: string; kind: "user"; text: string; requestId?: string; walky?: EnvelopeHeader }
  // `partial`: the program is still writing this text and will write it again under the same id (a durable pane,
  // WIRE.md 7.15). The card draws a cursor at its end until the flag goes.
  | { id: string; ts?: string; kind: "reply"; text: string; partial?: true }
  | { id: string; ts?: string; kind: "thinking"; text: string; partial?: true }
  | { id: string; ts?: string; kind: "notice"; text: string; note?: true; partial?: true }
  // A compaction. `text` is the agent's recap of its own history and is present only when the reader
  // asked for it (Settings → Appearance → Compaction summaries); without it the item is a one-line
  // marker, so the recap's thousands of characters are never built into a block at all.
  | { id: string; ts?: string; kind: "compacted"; text?: string }
  // `image`: a picture the call returned (a `Read` of an image, a screenshot), drawn under its card.
  | { id: string; ts?: string; kind: "tool"; tool: ChatToolCall; status: ChatToolStatus; image?: string }
  | { id: string; ts?: string; kind: "image"; url: string };

/**
 * The item as a finished text: `partial` dropped. A text the program was writing when the pane stopped working will not
 * grow any more (WIRE.md 7.15 lets a reader draw it as final), so no cursor is left on it.
 */
export function finished(item: ChatItem): ChatItem {
  if (item.kind === "reply") return { id: item.id, ts: item.ts, kind: "reply", text: item.text };
  if (item.kind === "thinking") return { id: item.id, ts: item.ts, kind: "thinking", text: item.text };
  if (item.kind === "notice" && item.partial === true) return { id: item.id, ts: item.ts, kind: "notice", text: item.text, note: item.note };
  return item;
}

/**
 * A call plus what it printed, on the kinds that can carry it.
 *
 * A switch rather than one spread, because `output` is not a field of every branch and TypeScript is
 * right to refuse the shortcut: a `read` with an `output` would be a shape no card knows how to draw.
 */
export function withToolOutput(call: ToolCall, output: string): ChatToolCall {
  switch (call.kind) {
    case "execute":
      return { ...call, output };
    case "search":
      return { ...call, output };
    case "fetch":
      return { ...call, output };
    case "task":
      return { ...call, output };
    case "other":
      return { ...call, output };
    // A plan has no output to print: its result only echoes the list the card draws row by row.
    default:
      return call;
  }
}

/**
 * One journal tool part as the call a card draws.
 *
 * An adapter not yet taught to fill `call` degrades to `other` carrying the name and the one-line
 * summary, which is exactly what the transcript view drew before the structured call existed.
 *
 * The result text is taken as the journal already capped it (`MAX_RESULT_CHARS`), never re-capped
 * here: two caps on one string means the smaller one is the real rule and the other is decoration.
 */
export function toolOf(part: Extract<TranscriptPart, { kind: "tool" }>): ChatToolCall {
  const call: ToolCall = part.call ?? { kind: "other", name: part.name, summary: part.summary };
  const output = part.result?.text;
  return output === undefined || output === "" ? call : withToolOutput(call, output);
}

/**
 * What became of a call.
 *
 * "denied" is not "failed", and drawing the two alike tells the reader a lie about their own
 * session: nothing went wrong, somebody said no. The journal keeps them apart and so does this.
 */
export function toolStatus(part: Extract<TranscriptPart, { kind: "tool" }>): ChatToolStatus {
  const result = part.result;
  if (result === undefined) return "running";
  if (result.denied) return "denied";
  if (result.isError) return "failed";
  // A background job or sub-agent answers "started" at once; the call says it has not ended.
  if (part.call && "ongoing" in part.call && part.call.ongoing === true) return "running";
  return "done";
}

/**
 * One turn as the blocks a stream draws.
 *
 * A turn holds several parts and a block holds one thing, so one entry becomes several items. The id
 * is the part's own where it has one; everything else is `<uuid>:<n>`, which is stable because a
 * reducer emits a turn's parts in one order and only ever adds to the end.
 *
 * An ABANDONED turn is translated like any other. `TranscriptEntry.abandoned` is a flag and not a
 * filter, on purpose and for the whole journal: a page cursor still has to resolve a hidden turn's
 * uuid, so hiding it is the screen's job, exactly as it is on the History page.
 */
export function itemsOf(entry: TranscriptEntry, showCompactions = false): ChatItem[] {
  const ts = entry.ts || undefined;
  if (entry.role === "summary") {
    // ONE item per compaction, whatever the recap's parts: it is a single event, and the marker has
    // nothing to say per part.
    const text = entry.parts.flatMap((p) => (p.kind === "text" && p.text.trim() ? [p.text] : [])).join("\n\n");
    const marker: ChatItem = { id: `${entry.uuid}:0`, ts, kind: "compacted" };
    if (showCompactions && text) marker.text = text;
    return [marker];
  }
  const said = entry.role === "user" ? "user" : entry.role === "assistant" ? "reply" : "notice";
  const items: ChatItem[] = [];
  // Only a turn the program is still writing, and only a text a person reads: never a tool, never the user's own line.
  const grows = entry.partial === true && entry.role !== "user" ? ({ partial: true } as const) : {};
  const asked = entry.role === "user" && entry.requestId !== undefined ? { requestId: entry.requestId } : {};
  // Only the FIRST text of a turn can open with an envelope: the body follows the header, and a header
  // quoted further down a turn is only text.
  let firstText = true;
  entry.parts.forEach((part, i) => {
    const id = part.kind === "tool" && part.id ? part.id : `${entry.uuid}:${i}`;
    switch (part.kind) {
      case "text": {
        // A `note` is machine-injected, so it is a notice rather than a reply. (A compaction summary
        // never gets here: it is its own item above.)
        if (!part.text.trim()) return;
        if (said === "user") {
          const header = firstText ? parseEnvelopeHeader(firstLine(part.text)) : null;
          const item: ChatItem = { id, ts, kind: said, text: part.text, ...asked };
          if (header !== null) item.walky = header;
          firstText = false;
          items.push(item);
          return;
        }
        firstText = false;
        items.push(
          said === "notice"
            ? { id, ts, kind: said, text: part.text, note: true, ...grows }
            : { id, ts, kind: said, text: part.text, ...grows },
        );
        return;
      }
      case "thinking":
        if (part.text.trim()) items.push({ id, ts, kind: "thinking", text: part.text, ...grows });
        return;
      case "image":
        items.push({ id, ts, kind: "image", url: part.url });
        return;
      case "tool": {
        const item: ChatItem = { id, ts, kind: "tool", tool: toolOf(part), status: toolStatus(part) };
        if (part.result?.imageUrl) item.image = part.result.imageUrl;
        items.push(item);
        return;
      }
    }
  });
  return items;
}
