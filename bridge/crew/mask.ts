import {
  maskChatBody,
  maskDiff,
  maskFileBody,
  maskHistoryPage,
  maskPaneRead,
} from "../answer-mask.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import type { ChatBody } from "../journal/live.ts";
import type { ChangeDiff, FileReadAnswer, PaneReadResponse } from "../types.ts";
import type { AnswerMask, TextAnswer } from "./forward.ts";

// The LEAD's mask over a member's text answer (CREW_PROTOCOL.md §9.1). The member's body is parsed,
// checked for the shape its route answers with, and masked by the very function the lead's own route
// uses for the same answer (`bridge/answer-mask.ts`). Nothing here masks by a rule of its own.
//
// ── FAIL CLOSED, BY SHAPE ────────────────────────────────────────────────────
// `null` means "do not pass this on": the body is not JSON, or it is not the answer the route makes.
// The check is exactly as deep as the mask needs, no deeper: every field the mask walks must be the
// type it walks, because a field of another type would be passed over rather than masked. Turns are
// walked whole by `redactEntry` (every string in a part but a label the bridge wrote), so a turn needs
// only its `parts` list and an image part its `url` string. A field the mask does not touch on the
// lead's own route (a cursor, a count, a root, a commit list) is not checked and not touched here
// either, so a member one release ahead with a new field still answers.
//
// ── NO CHANGE, NO NEW BYTES ──────────────────────────────────────────────────
// An answer with nothing to mask (`available: false`, a listing, a commit list) goes back as the
// member's own bytes, unparsed past the shape check. A masked answer is re-serialised with
// `JSON.stringify`, the member's own serialiser, so a body a 1.18 member already masked comes back
// byte for byte: parse then stringify is a fixed point on stringify's output, and the mask is a fixed
// point on its own output.

/** A member's text answer, masked, or `null` when it cannot be read as that answer. */
export const maskForwardedAnswer: AnswerMask = (answer: TextAnswer, raw: string): string | null => {
  let body: JsonValue;
  try {
    // SAFETY: `JSON.parse` returns a JSON value by definition; `JsonValue` is the name for that type.
    body = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  if (!isObject(body)) return null;
  try {
    return maskBody(answer, body, raw);
  } catch {
    // The checks above the mask cover every field it reads; a throw past them is a shape nobody
    // planned for, and it is refused like any other.
    return null;
  }
};

function maskBody(answer: TextAnswer, body: JsonObject, raw: string): string | null {
  switch (answer) {
    case "pane":
      return isPaneRead(body) ? JSON.stringify(maskPaneRead(body)) : null;
    case "history":
      if (body.available === false) return raw;
      return body.available === true && isHistoryPage(body)
        ? JSON.stringify(maskHistoryPage(body))
        : null;
    case "chat":
      if (body.available === false) return raw;
      return body.available === true && isChatBody(body) ? JSON.stringify(maskChatBody(body)) : null;
    case "changes":
      // A list and a commit carry no diff, and the lead's own route masks neither.
      if (!("diff" in body)) return raw;
      return isDiff(body) ? JSON.stringify(maskDiff(body, true)) : null;
    case "files":
      // A listing is names only; the lead's own route masks a file's text alone.
      if (!("text" in body)) return raw;
      return isFileText(body) ? JSON.stringify(maskFileBody(body, true)) : null;
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
}

function isPaneRead(body: JsonObject): body is JsonObject & PaneReadResponse {
  return typeof body.text === "string" && (body.logicalText === undefined || typeof body.logicalText === "string");
}

/** A turn as `redactEntry` walks it: a `parts` list of objects, an image part with its `url` a string. */
function isEntry(value: JsonValue | undefined): value is JsonObject & TranscriptEntry {
  if (!isObject(value) || !Array.isArray(value.parts)) return false;
  return value.parts.every((part) => isObject(part) && (part.kind !== "image" || typeof part.url === "string"));
}

function isEntryList(value: JsonValue | undefined): value is (JsonObject & TranscriptEntry)[] {
  return Array.isArray(value) && value.every(isEntry);
}

function isHistoryPage(body: JsonObject): body is JsonObject & { entries: TranscriptEntry[] } {
  return isEntryList(body.entries);
}

function isChatBody(body: JsonObject): body is JsonObject & ChatBody {
  if (!isEntryList(body.upserts)) return false;
  // An older page carries no queue; a live window always does, as a list of strings.
  if (body.page === "older") return true;
  return body.page === "live" && Array.isArray(body.queued) && body.queued.every((q) => typeof q === "string");
}

function isDiff(body: JsonObject): body is JsonObject & Extract<ChangeDiff, { available: true }> {
  return body.available === true && typeof body.diff === "string";
}

function isFileText(body: JsonObject): body is JsonObject & Extract<FileReadAnswer, { available: true }> {
  return body.available === true && typeof body.text === "string";
}
