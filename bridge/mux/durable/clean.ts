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
  /** Options of a `choice` ask, and of a `choice` field of a form (WIRE.md 7.14). */
  choiceOptions: 8,
  /** Fields of a `form` ask. */
  formFields: 6,
  starters: 50,
  /** Belt actions per pane (WIRE.md section 4, `PaneAction`). */
  actionsPerPane: 4,
  /** Events in one plain events reply. */
  eventsPerReply: 1000,
  /** Items in a reset view, the newest. */
  resetItems: 2000,
  /** A history cursor, in bytes (WIRE.md 7.16). */
  historyCursor: 512,
  /** Rows in one `conversations` page. */
  conversationsPerPage: 100,
  /** Items in one page of a conversation's history. */
  historyItems: 1000,
} as const;

/** The reply caps of WIRE.md section 6, in bytes. */
export const REPLY_CAPS = {
  hello: 16 * 1024,
  snapshot: 4 * 1024 * 1024,
  events: 8 * 1024 * 1024,
  /** A page of the program's conversation list (WIRE.md 7.16): 100 rows. */
  conversations: 1024 * 1024,
  /** A page of one conversation's items (WIRE.md 7.16). */
  conversationItems: 8 * 1024 * 1024,
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

/** The longest belt action label, in characters (code points). WIRE.md section 4. */
export const ACTION_LABEL_MAX = 16;

/** A belt action label, cleaned and cut to {@link ACTION_LABEL_MAX} characters. Empty when nothing is left. */
export function actionLabelOf(label: string): string {
  return [...cleanText(label, lineRule(CAPS.starterLabel)).trim()].slice(0, ACTION_LABEL_MAX).join("").trim();
}

/** The longest push title and push line an ask may carry, in characters (code points). WIRE.md section 6. */
export const PUSH_TITLE_MAX = 60;
export const PUSH_LINE_MAX = 120;

/** One part of an ask's push words: cleaned as a one-line string, trimmed and cut to `max` characters. May be empty. */
export function pushPartOf(text: string, max: number): string {
  return [...cleanText(text, lineRule(CAPS.askTitle)).trim()].slice(0, max).join("").trim();
}

/** The longest title a rename may carry, in characters (code points). WIRE.md section 7.8. */
export const RENAME_TITLE_MAX = 120;

/**
 * The title a rename asks for: trimmed, 1 to {@link RENAME_TITLE_MAX} characters, no control character.
 * Null when it breaks the rule, so nothing leaves that the program would answer 400.
 */
export function renameTitleOf(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === "" || [...trimmed].length > RENAME_TITLE_MAX) return null;
  for (const symbol of trimmed) {
    if (isControl(symbol.codePointAt(0) ?? 0)) return null;
  }
  return trimmed;
}

// ── Subtitle and badge (WIRE.md section 7.11) ─────────────────────────────────

/** The longest subtitle, in characters (code points). */
export const SUBTITLE_MAX = 120;

/** The longest text badge, in characters (code points). */
export const BADGE_TEXT_MAX = 12;

/** The largest count badge. A count is an integer from 0 to this. */
export const BADGE_COUNT_MAX = 9999;

/** One small mark next to a pane's title: a count or a short word. Exactly one of the two keys. */
export type Badge = { readonly count: number } | { readonly text: string };

/**
 * Clean one display string that is capped in characters, not bytes: control characters, direction
 * marks and zero-width characters out, trimmed, then cut at a whole code point with `…` as the last
 * character when it was over `maxChars`. Undefined when nothing is left.
 */
export function shortLine(text: string, maxChars: number): string | undefined {
  // Four bytes a character is the widest a code point gets, so this step never cuts on its own.
  const cleaned = cleanText(text, lineRule(maxChars * 4 + ELLIPSIS_BYTES)).trim();
  if (cleaned === "") return undefined;
  const symbols = [...cleaned];
  if (symbols.length <= maxChars) return cleaned;
  return `${symbols.slice(0, maxChars - 1).join("")}${ELLIPSIS}`;
}

// ── Ask kinds (WIRE.md section 7.14) ──────────────────────────────────────────

/** The longest `placeholder` of a `text` ask, in characters (code points). */
export const PLACEHOLDER_MAX = 60;

/** The largest `maxLength` of a `text` ask or a text field, in characters. */
export const ANSWER_TEXT_MAX = 2000;

/** The `maxLength` a text ask or a text field has when the program names none. */
export const ANSWER_TEXT_DEFAULT = 500;

/** The most bytes a text answer may take: {@link ANSWER_TEXT_MAX} characters at four bytes each. */
export const ANSWER_TEXT_BYTES = ANSWER_TEXT_MAX * 4;

// ── Rich items (WIRE.md section 7.13) ─────────────────────────────────────────

/** The largest `text` of a markdown or code item, in bytes. */
export const ITEM_RICH_BYTES = 32768;

/** The longest code language, in characters. */
export const LANG_MAX = 24;

/** The longest link target, in characters (UTF-16 units, as a URL is measured). */
export const HREF_MAX = 2048;

/** The longest link label, in characters (code points). */
export const LINK_LABEL_MAX = 120;

const LANG_RULE = /^[A-Za-z0-9_+#.-]+$/u;
const WHITESPACE = /\s/u;

/**
 * A code item's language: 1 to 24 of letters, digits and `_ + # . -`, after a trim. Anything else reads as no
 * language and the block is kept. The strictness is the point: the name goes after a fence in markdown, and a
 * name with a backtick or a newline could close that fence early.
 */
export function langOf(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.length >= 1 && trimmed.length <= LANG_MAX && LANG_RULE.test(trimmed) ? trimmed : undefined;
}

/**
 * A link item's target: an `https://` URL of at most 2048 characters with a host, no user or password, and no
 * whitespace, control or invisible character. Returns the URL as the platform writes it, or undefined for
 * anything else (`http:`, `javascript:`, `data:`, a relative path and a malformed URL all read as undefined).
 */
export function httpsHrefOf(text: string): string | undefined {
  if (text === "" || text.length > HREF_MAX || WHITESPACE.test(text)) return undefined;
  if (changedByCleaning(text, lineRule(HREF_MAX * 4))) return undefined;
  if (!URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") return undefined;
  return url.href.length <= HREF_MAX ? url.href : undefined;
}

// ── Progress (WIRE.md section 7.12) ───────────────────────────────────────────

/** The most steps a progress carries. */
export const PROGRESS_STEPS_MAX = 12;

/** The longest step or percent label, in characters (code points). */
export const PROGRESS_LABEL_MAX = 60;

export type StepState = "done" | "running" | "todo";

export interface ProgressStep {
  readonly label: string;
  readonly state: StepState;
}

/** How far a working pane is: a list of steps, or a percent. */
export type Progress =
  | { readonly kind: "steps"; readonly steps: readonly ProgressStep[] }
  | { readonly kind: "percent"; readonly value: number; readonly label?: string };
