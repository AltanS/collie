// A notice drawn above a live input box (the profile's `idle.notices`): a head row the profile names,
// up to three continuation rows indented by two spaces, one row of `<digit>: <label>` keys, then only
// blank rows and rows the profile names (`idle.noticeGaps`) down to the box's top edge. The harness
// reads its keys only when the box's whole value is one of those digits, so the box keeps the keys and a message of any other text goes in as typed.
//
// The reader fails closed: any row out of that order, any key item that is not a digit and a label, a
// head the profile does not name, returns null, and the modal cues then read the rows as they always do.
//
// Pure, and it names no harness (no-harness-names.test.ts): the head comes from the profile.

import { isSingleKeyRow, keyRowItems } from "./key-row";
import type { NoticeHead } from "./profile";

/** The most continuation rows a notice's text wraps onto under its head. */
const MAX_CONTINUATION_ROWS = 3;
/** A continuation row: exactly two spaces, then text. */
const CONTINUATION = /^ {2}\S/u;
/** One printed key: a digit, a colon, the label. */
const KEY_ITEM = /^(\d):\s*(\S(?:.*\S)?)$/u;
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
  /** The key row. */
  readonly last: number;
  /** The last row before the box's top edge: the blank and gap rows under the key row belong to the notice. */
  readonly end: number;
  /** The head without its leading glyph, and each continuation row, joined by one space. */
  readonly text: string;
  /** The keys in the order the row printed them. */
  readonly keys: readonly NoticeKey[];
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

/** The key row's items, split as the modal cues split them, as printed keys; null when one item is
 *  not `<digit>: <label>`, or its label holds another keyed item. */
function keysOf(text: string): NoticeKey[] | null {
  if (!isSingleKeyRow(text)) return null;
  const keys: NoticeKey[] = [];
  for (const item of keyRowItems(text)) {
    const match = KEY_ITEM.exec(item);
    if (match === null || KEYED_IN_LABEL.test(match[2]!)) return null;
    keys.push({ key: match[1]!, label: match[2]! });
  }
  return keys;
}

/**
 * The notice whose key row stands over the box's top edge `boxTop`, with only blank rows and rows a
 * pattern of `gaps` matches between, or null when the rows there are not exactly a notice the profile
 * names.
 */
export function readAboveNotice(texts: readonly string[], boxTop: number, notices: readonly NoticeHead[], gaps: readonly string[]): AboveNotice | null {
  if (notices.length === 0) return null;
  const gapRows = gapPatterns(gaps);
  const skipped = (text: string): boolean => text.trim().length === 0 || gapRows.some((gap) => gap.test(text.trimEnd()));
  let last = boxTop - 1;
  while (last >= 0 && skipped(texts[last]!)) last--;
  if (last < 1) return null;
  const keys = keysOf(texts[last]!);
  if (keys === null) return null;
  const heads = headPatterns(notices);
  const continuation: string[] = [];
  for (let row = last - 1; row >= 0 && continuation.length <= MAX_CONTINUATION_ROWS; row--) {
    const text = texts[row]!.trimEnd();
    if (heads.some((head) => head.test(text))) {
      const head = text.trim().replace(/^\S+\s+/u, "");
      return { first: row, last, end: boxTop - 1, text: [head, ...continuation].join(" "), keys };
    }
    if (!CONTINUATION.test(text) || isSingleKeyRow(text) || continuation.length === MAX_CONTINUATION_ROWS) return null;
    continuation.unshift(text.trim());
  }
  return null;
}
