// A row of single-key items (`1: Bad   2: Fine   0: Dismiss`, `a approve | s request changes`), read
// by the modal cues (cues.ts) and by the notice reader (notice.ts). Both split a row into items the
// same way, so a separator one of them reads the other reads too.
//
// Pure, and it names no harness (no-harness-names.test.ts).

const YES_NO = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/iu;
const ANY_KEY = /\bpress any key\b/iu;
/** What sets two items of a key row apart: a gap of two spaces or more, or one of the separator glyphs. */
export const ITEM_SPLIT = /\s{2,}|\s*[|│·•]\s*/u;
/** A keyed item: a letter key then a colon or a space, or a digit key then a colon or a parenthesis.
 *  A digit and a space is a count ("6 plugins"), not a key. */
const SINGLE_KEY_ITEM = /^(?:([A-Za-z])(:\s*|\s+)|(\d)([:)]\s*))[A-Za-z]/u;

/** The row's items, split on {@link ITEM_SPLIT}, empty ones dropped. */
export function keyRowItems(text: string): string[] {
  return text
    .trim()
    .split(ITEM_SPLIT)
    .filter((item) => item.length > 0);
}

/** Whether a row is a single-key prompt: `(y/n)`, "press any key", or a row of single-key items. */
export function isSingleKeyRow(text: string): boolean {
  if (YES_NO.test(text) || ANY_KEY.test(text)) return true;
  const items = keyRowItems(text);
  if (items.length < 2) return false;
  const keyed = items.map((item) => SINGLE_KEY_ITEM.exec(item)).filter((m) => m !== null);
  if (keyed.length < 2 || keyed.length * 5 < items.length * 3) return false;
  // Two prose words separated by a wide gap can look like keyed items. A colon or a digit key says
  // the row names keys; so do three keyed items.
  return keyed.length >= 3 || keyed.some((m) => m[3] !== undefined || m[2]!.startsWith(":"));
}
