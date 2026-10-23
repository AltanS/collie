// A notice drawn above a live input box (the profile's `idle.notices`), in one of three shapes:
//
//  - the offer: a head row the profile names, up to three continuation rows indented by two spaces,
//    then the key block;
//  - the inline head: a head row that carries the first keys after its own text, then the rest of the
//    key block wrapped under it (`✦ Dismissed.   1: That was helpful   2: Not relevant`, `  0: Dismiss`);
//  - the explanation, only under a head the profile marks `body`: the head and its continuation rows,
//    a blank row, then up to sixty rows, each blank or indented by two spaces or more and none a key
//    row, then the key block.
//
// The key block is one to six rows of `<digit>: <label>` items, or of `<letter>: <label>` items under a
// head the profile marks `letters`. Every row of it but an inline head is indented by exactly two
// spaces, a row may hold a single key, and the whole block reads as one single-key row, as the modal
// cues read one. Under it only blank rows and rows the profile names (`idle.noticeGaps`) go down to the
// box's top edge. The harness reads its keys only when the box's whole value is one of those keys, so
// the box keeps the keys and a message of any other text goes in as typed.
//
// The reader fails closed: any row out of that order, any key item that is not a digit (a letter under a
// `letters` head) and a label, a
// head the profile does not name, returns null, and the modal cues then read the rows as they always do.
//
// Pure, and it names no harness (no-harness-names.test.ts): the head comes from the profile.

import { isSingleKeyRow, keyRowItems } from "./key-row";
import type { NoticeHead } from "./profile";

/** The most continuation rows a notice's text wraps onto under its head. */
const MAX_CONTINUATION_ROWS = 3;
/** The most rows a key block wraps onto, an inline head's row included. */
const MAX_KEY_ROWS = 6;
/** The most rows between the continuation rows and the key block under a head the profile marks `body`. */
const MAX_BODY_ROWS = 60;
/** A continuation row, and a key row under the head: exactly two spaces, then text. */
const CONTINUATION = /^ {2}\S/u;
/** A body row that is not blank: two spaces or more, then text. */
const BODY_ROW = /^ {2,}\S/u;
/** One printed key: a digit, a colon, the label. */
const KEY_ITEM = /^(\d):\s*(\S(?:.*\S)?)$/u;
/** One printed key under a head the profile marks `letters`: a letter, a colon, the label. */
const LETTER_KEY_ITEM = /^([A-Za-z]):\s*(\S(?:.*\S)?)$/u;
/** A keyed item inside a label (`Learn more 2: Knew`): one letter or digit, then a colon or a parenthesis. */
const KEYED_IN_LABEL = /(?:^|\s)[A-Za-z0-9][:)]\s*\S/u;

/** One key the notice printed, as printed. */
export interface NoticeKey {
  readonly key: string;
  readonly label: string;
}

/** A notice read above the box. */
export interface AboveNotice {
  /** The head row. */
  readonly first: number;
  /** The last row of the key block. */
  readonly last: number;
  /** The last row before the box's top edge: the blank and gap rows under the key block belong to the notice. */
  readonly end: number;
  /** The head without its leading glyph, and each continuation row, joined by one space. */
  readonly text: string;
  /** The keys of the whole key block, in the order it printed them, top row first. */
  readonly keys: readonly NoticeKey[];
  /** The rows between the continuation rows and the key block under a `body` head, blank rows at both edges left out; null when there are none. */
  readonly body: { readonly first: number; readonly last: number } | null;
}

/** The rows between a head and its key block, read. */
interface Span {
  readonly continuation: readonly string[];
  readonly body: AboveNotice["body"];
}

const compiled = new WeakMap<readonly NoticeHead[], readonly RegExp[]>();
const compiledGaps = new WeakMap<readonly string[], readonly RegExp[]>();

function headPatterns(notices: readonly NoticeHead[]): readonly RegExp[] {
  const known = compiled.get(notices);
  if (known !== undefined) return known;
  const patterns = notices.map((notice) => new RegExp(notice.head, "u"));
  compiled.set(notices, patterns);
  return patterns;
}

function gapPatterns(gaps: readonly string[]): readonly RegExp[] {
  const known = compiledGaps.get(gaps);
  if (known !== undefined) return known;
  const patterns = gaps.map((gap) => new RegExp(gap, "u"));
  compiledGaps.set(gaps, patterns);
  return patterns;
}

/** The items of one row of a key block, split as the modal cues split them; null when the row holds
 *  none, or one item is not `<digit>: <label>` (`<letter>: <label>` with `letters`), or its label holds
 *  another keyed item. */
function keyItems(text: string, letters: boolean): string[] | null {
  const items = keyRowItems(text);
  if (items.length === 0) return null;
  for (const item of items) {
    const match = (letters ? LETTER_KEY_ITEM : KEY_ITEM).exec(item);
    if (match === null || KEYED_IN_LABEL.test(match[2]!)) return null;
  }
  return items;
}

/** The block's keys, top row first; null when it holds no row or more than {@link MAX_KEY_ROWS}, or
 *  its items, joined, do not read as one single-key row. */
function blockKeys(block: readonly (readonly string[])[], letters: boolean): NoticeKey[] | null {
  if (block.length === 0 || block.length > MAX_KEY_ROWS) return null;
  const items = block.flat();
  if (!isSingleKeyRow(items.join("   "))) return null;
  return items.map((item) => {
    const match = (letters ? LETTER_KEY_ITEM : KEY_ITEM).exec(item)!;
    return { key: match[1]!, label: match[2]! };
  });
}

/** The head without its leading glyph. */
function headText(text: string): string {
  return text.trim().replace(/^\S+\s+/u, "");
}

/** A head row that carries keys after the head's match: its text up to the match's end, and those keys.
 *  A head the profile marks `letters` never carries digits, so it is not read here. */
function inlineHead(text: string, notices: readonly NoticeHead[]): { text: string; items: string[] } | null {
  for (const [i, head] of headPatterns(notices).entries()) {
    if (notices[i]!.letters === true) continue;
    const match = head.exec(text);
    if (match === null) continue;
    const end = match.index + match[0].length;
    const items = keyItems(text.slice(end), false);
    if (items !== null) return { text: headText(text.slice(0, end)), items };
  }
  return null;
}

/** The nearest row at or over `top` a head pattern matches, with only blank and indented rows between; -1 when there is none. */
function headRowOver(texts: readonly string[], top: number, heads: readonly RegExp[]): number {
  for (let row = top; row >= 0 && top - row <= MAX_CONTINUATION_ROWS + MAX_BODY_ROWS; row--) {
    const text = texts[row]!.trimEnd();
    if (heads.some((head) => head.test(text))) return row;
    if (text.length > 0 && !BODY_ROW.test(text)) return -1;
  }
  return -1;
}

/** The rows `first` onward under a `body` head: each blank or indented by two spaces or more, none a key row. */
function readBody(rows: readonly string[], first: number): AboveNotice["body"] | undefined {
  if (rows.length > MAX_BODY_ROWS) return undefined;
  const filled: number[] = [];
  for (const [i, text] of rows.entries()) {
    if (text.length === 0) continue;
    if (!BODY_ROW.test(text) || isSingleKeyRow(text)) return undefined;
    filled.push(first + i);
  }
  return filled.length === 0 ? null : { first: filled[0]!, last: filled.at(-1)! };
}

/** The rows between the head row `head` and the key block, read under the head's rules; null when they break them. */
function readSpan(texts: readonly string[], head: number, top: number, body: boolean): Span | null {
  const rows = texts.slice(head + 1, top + 1).map((text) => text.trimEnd());
  const continuation: string[] = [];
  for (const text of rows) {
    if (text.length === 0) break;
    if (!CONTINUATION.test(text) || isSingleKeyRow(text) || continuation.length === MAX_CONTINUATION_ROWS) return null;
    continuation.push(text.trim());
  }
  if (continuation.length === rows.length) return { continuation, body: null };
  if (!body) return null;
  const read = readBody(rows.slice(continuation.length), head + 1 + continuation.length);
  return read === undefined ? null : { continuation, body: read };
}

/** The last row over `boxTop` that is neither blank nor a row a pattern of `gaps` matches; -1 when there is none. */
function lastRowOver(texts: readonly string[], boxTop: number, gaps: readonly string[]): number {
  const gapRows = gapPatterns(gaps);
  const skipped = (text: string): boolean => text.trim().length === 0 || gapRows.some((gap) => gap.test(text.trimEnd()));
  let last = boxTop - 1;
  while (last >= 0 && skipped(texts[last]!)) last--;
  return last;
}

/** The key rows indented by two spaces over a notice's last row, top row first, and the row over them. */
interface KeyRows {
  /** The row over the indented key rows: an inline head, a head, or a row between the head and the key block. */
  readonly top: number;
  /** Each indented key row's items, top row first. */
  readonly rows: string[][];
}

/** The key rows indented by two spaces, walking up from `last`; lettered keys with `letters`. */
function keyRowsUp(texts: readonly string[], last: number, letters: boolean): KeyRows {
  const rows: string[][] = [];
  let top = last;
  for (; top >= 0; top--) {
    const text = texts[top]!.trimEnd();
    const items = CONTINUATION.test(text) ? keyItems(text, letters) : null;
    if (items === null) break;
    rows.unshift(items);
  }
  return { top, rows };
}

/** The notice whose head stands at or over `top`, the row over its key block, read under the head's
 *  rules: a lettered key block only under a `letters` head, a block of digits only under any other. */
function headedNotice(
  texts: readonly string[],
  top: number,
  notices: readonly NoticeHead[],
  block: Pick<AboveNotice, "last" | "end" | "keys">,
  letters: boolean,
): AboveNotice | null {
  const heads = headPatterns(notices);
  const head = headRowOver(texts, top, heads);
  if (head < 0) return null;
  const headLine = texts[head]!.trimEnd();
  const notice = notices[heads.findIndex((pattern) => pattern.test(headLine))]!;
  if ((notice.letters === true) !== letters) return null;
  const span = readSpan(texts, head, top, notice.body === true);
  if (span === null) return null;
  return { ...block, first: head, text: [headText(headLine), ...span.continuation].join(" "), body: span.body };
}

/**
 * The notice whose key block stands over the box's top edge `boxTop`, with only blank rows and rows a
 * pattern of `gaps` matches between, or null when the rows there are not exactly a notice the profile
 * names.
 */
export function readAboveNotice(texts: readonly string[], boxTop: number, notices: readonly NoticeHead[], gaps: readonly string[]): AboveNotice | null {
  if (notices.length === 0) return null;
  const last = lastRowOver(texts, boxTop, gaps);
  if (last < 1) return null;
  const end = boxTop - 1;
  const digits = keyRowsUp(texts, last, false);
  if (digits.top < 0) return null;
  const inline = inlineHead(texts[digits.top]!.trimEnd(), notices);
  if (inline !== null) {
    const keys = blockKeys([inline.items, ...digits.rows], false);
    return keys === null ? null : { first: digits.top, last, end, text: inline.text, keys, body: null };
  }
  const digitKeys = blockKeys(digits.rows, false);
  if (digitKeys !== null) return headedNotice(texts, digits.top, notices, { last, end, keys: digitKeys }, false);
  // A row of lettered keys is read only for a profile that names a `letters` head, and only under one.
  if (!notices.some((notice) => notice.letters === true)) return null;
  const lettered = keyRowsUp(texts, last, true);
  const letterKeys = lettered.top < 0 ? null : blockKeys(lettered.rows, true);
  return letterKeys === null ? null : headedNotice(texts, lettered.top, notices, { last, end, keys: letterKeys }, true);
}
