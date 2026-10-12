// CLEANING AND CAPS FOR EVERYTHING THAT COMES OFF THE DURABLE SOCKET (WIRE.md section 6).
//
// A string from the program is untrusted, like screen text is. The adapter cleans every display
// string here before anything else reads it, and it does not trust that the program stayed inside
// the caps. Ids are different: an id is never cleaned and never cut. It is valid or the object
// that carries it is dropped.

import { isValidMuxId } from "../identity.ts";

/** The byte caps of WIRE.md section 6. Bytes are UTF-8 bytes. */
export const CAPS = {
  id: 128,
  hostName: 64,
  title: 256,
  askTitle: 256,
  starterLabel: 128,
  optionLabel: 128,
  harness: 64,
  cwd: 4096,
  reason: 2048,
  problemMessage: 512,
  toolName: 128,
  toolSummary: 1024,
  toolOutput: 16384,
  /** Item `text` of a user, reply, thinking or notice item. */
  itemText: 65536,
  /** Item `ts`: an ISO 8601 stamp. Over the cap it reads as absent. */
  itemTs: 40,
  settledReason: 128,
  /** `SendRequest.text`: 1 to this many bytes. The adapter refuses before it sends. */
  sendText: 32768,
  /** Not in the table. The ask kind is a short word. */
  askKind: 32,
  /** Not in the table. The pane state is a short word. */
  state: 32,
  workspaces: 64,
  tabs: 256,
  panes: 256,
  openAsksPerPane: 50,
  optionsPerAsk: 6,
  starters: 50,
  /** Events in one plain events reply. */
  eventsPerReply: 1000,
  /** Items in a reset view, the newest. */
  resetItems: 2000,
} as const;

/** The reply caps of WIRE.md section 6, in bytes. */
export const REPLY_CAPS = {
  hello: 16 * 1024,
  snapshot: 4 * 1024 * 1024,
  events: 8 * 1024 * 1024,
  post: 16 * 1024,
} as const;

/** One cleaning rule: how long the string may be, and whether it may span lines. */
export interface TextRule {
  readonly maxBytes: number;
  readonly multiline: boolean;
}

/** A one-line display string with a byte cap. */
export function lineRule(maxBytes: number): TextRule {
  return { maxBytes, multiline: false };
}

/** A display string that may keep newlines and tabs, with a byte cap. */
export function blockRule(maxBytes: number): TextRule {
  return { maxBytes, multiline: true };
}

const TAB = 0x09;
const NEWLINE = 0x0a;
const ELLIPSIS = "…";
const ELLIPSIS_BYTES = 3;

/** C0 controls, DEL and C1 controls. */
function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/** The direction marks, overrides and isolates that can reorder the text around them. */
function isDirectionMark(codePoint: number): boolean {
  return (
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x061c ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/**
 * Characters with no width that can hide text or split a word a reader would otherwise recognise:
 * the zero-width space, non-joiner and joiner (U+200B to U+200D), the word joiner (U+2060), the
 * byte order mark (U+FEFF), and the tag characters (U+E0000 to U+E007F), which can carry a whole
 * invisible sentence.
 */
function isInvisible(codePoint: number): boolean {
  return (
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0x2060 ||
    codePoint === 0xfeff ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}

/** How many UTF-8 bytes one code point takes. A lone surrogate is cleaned away before this runs. */
function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** The UTF-8 length of a string, in bytes. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Clean one display string (WIRE.md section 6, "Cleaning").
 *
 * 1. Remove C0 controls, DEL and C1 controls. A multi-line field keeps `\n` and `\t`.
 * 2. Remove the direction marks, the zero-width characters and the tag characters.
 * 3. Cut to the byte cap at a whole code point, leaving room for `…`, and append it.
 */
export function cleanText(text: string, rule: TextRule): string {
  // A lone surrogate is not text. It would be written as U+FFFD, which is 3 bytes.
  const wellFormed = text.toWellFormed();
  let kept = "";
  for (const symbol of wellFormed) {
    const codePoint = symbol.codePointAt(0) ?? 0;
    if (isControl(codePoint)) {
      const allowed = rule.multiline && (codePoint === TAB || codePoint === NEWLINE);
      if (!allowed) continue;
    }
    if (isDirectionMark(codePoint) || isInvisible(codePoint)) continue;
    kept += symbol;
  }
  if (byteLength(kept) <= rule.maxBytes) return kept;

  const room = rule.maxBytes - ELLIPSIS_BYTES;
  let used = 0;
  let cut = "";
  for (const symbol of kept) {
    const size = utf8Size(symbol.codePointAt(0) ?? 0);
    if (used + size > room) break;
    used += size;
    cut += symbol;
  }
  return cut + ELLIPSIS;
}

/** Whether cleaning changed `text`: a character was removed, or the string was cut. */
export function changedByCleaning(text: string, rule: TextRule): boolean {
  return cleanText(text, rule) !== text;
}

/**
 * Whether `value` is an id the wire accepts: 1 to 128 bytes, and the mux id rule
 * (`isValidMuxId`: no control character, no whitespace, none of `/`, `?` or `#`).
 *
 * `isValidMuxId` counts UTF-16 units, the wire counts bytes, so both are checked.
 */
export function isWireId(value: string): boolean {
  return byteLength(value) <= CAPS.id && isValidMuxId(value);
}
