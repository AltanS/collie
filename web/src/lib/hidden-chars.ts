// HIDDEN CHARACTERS (review 7 M1): the one rule for "this text does not show as it is".
//
// A person who reads code on a card must see every character that runs. Some characters do not show as
// themselves: a line separator that JavaScript reads as a line end (`// note<U+2028>evil()` looks like one
// comment, and the engine runs `evil()`), a filler that looks like a blank but is a letter of an
// identifier (U+3164, U+115F), a zero-width joiner, a soft hyphen, a variation selector, a space that is
// not the space bar's. Text that holds one is refused where it must show as it is: the code on a proposal
// card and a new-version card (bridge/tricks/version-diff.ts `readViewLine`, card-group.ts `addedFile`),
// a file name a trick's walk meets (bridge/tricks/code-hash.ts `unsafeText`), and a `diff` or `code` node
// the phone draws (web/src/lib/tricks/schema.ts). The bridge imports this file from `web/src/lib`, as it
// imports json.ts, so the two sides run the same function and cannot drift.
//
// WHAT IS REFUSED ({@link isHiddenChar}):
//
//   * every character of the general categories Cc (but `\n` and `\t`), Cf, Zl, Zp, Co, Cn and Cs;
//   * every space separator (Zs) but U+0020;
//   * every default-ignorable code point and the blank-looking letters, listed in {@link HIDDEN_RANGES}, so
//     the rule does not depend on how new the engine's Unicode tables are;
//   * U+2800, the blank braille pattern.
//
// Category Cn (unassigned) is read from the engine's own Unicode tables. A browser older than the bridge's
// Bun may call a newly assigned character unassigned: the phone then refuses a card the bridge made, which
// fails closed. The listed ranges never depend on the engine.
//
// A later caller with the same need (the `rules.md` of an agent-view trick) takes {@link hasHiddenChar}
// as it is. A field that also refuses a line break checks `\n` on its own.

/** One listed range of hidden code points, both ends inside, and why it is listed. */
export interface HiddenRange {
  from: number;
  to: number;
  why: string;
}

/** The listed hidden code points: default-ignorable ones, blank-looking letters, the blank braille pattern. */
export const HIDDEN_RANGES: readonly HiddenRange[] = [
  { from: 0x00ad, to: 0x00ad, why: "soft hyphen" },
  { from: 0x034f, to: 0x034f, why: "combining grapheme joiner" },
  { from: 0x061c, to: 0x061c, why: "Arabic letter mark" },
  { from: 0x115f, to: 0x1160, why: "Hangul choseong and jungseong fillers" },
  { from: 0x17b4, to: 0x17b5, why: "Khmer inherent vowels" },
  { from: 0x180b, to: 0x180f, why: "Mongolian variation selectors and vowel separator" },
  { from: 0x200b, to: 0x200f, why: "zero-width space, joiners and direction marks" },
  { from: 0x2028, to: 0x2029, why: "line and paragraph separators" },
  { from: 0x202a, to: 0x202e, why: "direction embeddings and overrides" },
  { from: 0x2060, to: 0x206f, why: "word joiner, invisible operators, isolates and deprecated formats" },
  { from: 0x2800, to: 0x2800, why: "blank braille pattern" },
  { from: 0x3164, to: 0x3164, why: "Hangul filler" },
  { from: 0xfe00, to: 0xfe0f, why: "variation selectors" },
  { from: 0xfeff, to: 0xfeff, why: "byte order mark" },
  { from: 0xffa0, to: 0xffa0, why: "half-width Hangul filler" },
  { from: 0xfff0, to: 0xfff8, why: "unassigned specials" },
  { from: 0x1bca0, to: 0x1bca3, why: "shorthand format controls" },
  { from: 0x1d173, to: 0x1d17a, why: "musical format controls" },
  { from: 0xe0000, to: 0xe0fff, why: "tag characters and variation selectors supplement" },
];

/** The general categories refused whole. `\p{Cc}` is checked apart, so `\n` and `\t` pass. */
const HIDDEN_CATEGORY = /^[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]$/u;
const CONTROL = /^\p{Cc}$/u;
const SPACE_SEPARATOR = /^\p{Zs}$/u;

/** Whether one code point is listed in {@link HIDDEN_RANGES}. */
function listed(code: number): boolean {
  return HIDDEN_RANGES.some((range) => code >= range.from && code <= range.to);
}

/**
 * Whether one character (one code point, as `for ... of` over a string yields it) does not show as
 * itself. `\n` and `\t` are not hidden: code holds them. A lone surrogate is hidden (category Cs).
 */
export function isHiddenChar(ch: string): boolean {
  if (ch === "\n" || ch === "\t") return false;
  const code = ch.codePointAt(0) ?? 0;
  if (listed(code)) return true;
  if (CONTROL.test(ch) || HIDDEN_CATEGORY.test(ch)) return true;
  return ch !== " " && SPACE_SEPARATOR.test(ch);
}

/** The first hidden character of `text`, or null when it has none. */
export function firstHiddenChar(text: string): string | null {
  for (const ch of text) if (isHiddenChar(ch)) return ch;
  return null;
}

/** Whether `text` holds a character that does not show as itself ({@link isHiddenChar}). */
export function hasHiddenChar(text: string): boolean {
  return firstHiddenChar(text) !== null;
}

/** A hidden character as a person reads it in a refusal: `U+2028`. */
export function codePointName(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}
