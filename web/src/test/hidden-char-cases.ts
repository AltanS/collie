// THE ONE TABLE OF HIDDEN CHARACTERS (review 7 M1). The phone's suite (web/src/lib/hidden-chars.test.ts)
// and the bridge's (bridge/tricks/hidden-chars.test.ts) both run every row, so the two sides refuse the
// same characters. A row the review's probe used is marked `probe`.

export interface HiddenCharCase {
  ch: string;
  name: string;
  hidden: boolean;
}

export const HIDDEN_CHAR_CASES: readonly HiddenCharCase[] = [
  // Shown as themselves: kept.
  { ch: "a", name: "a Latin letter", hidden: false },
  { ch: " ", name: "U+0020 space", hidden: false },
  { ch: "\n", name: "line feed", hidden: false },
  { ch: "\t", name: "tab", hidden: false },
  { ch: "é", name: "e with acute", hidden: false },
  { ch: "日", name: "a CJK ideograph", hidden: false },
  { ch: "ㄱ", name: "a Hangul compatibility letter that shows", hidden: false },
  { ch: "😀", name: "an emoji", hidden: false },
  { ch: "↪", name: "the wrap mark", hidden: false },
  { ch: "•", name: "the mask dot", hidden: false },
  { ch: "−", name: "U+2212 minus", hidden: false },
  { ch: "…", name: "ellipsis", hidden: false },
  { ch: "�", name: "replacement character", hidden: false },
  // Controls: C0 but line feed and tab, DEL, C1.
  { ch: "\u0000", name: "NUL", hidden: true },
  { ch: "\r", name: "carriage return", hidden: true },
  { ch: "\u001b", name: "escape", hidden: true },
  { ch: "\u007f", name: "DEL", hidden: true },
  { ch: "\u0080", name: "C1 U+0080", hidden: true },
  { ch: "\u0085", name: "next line", hidden: true },
  // Line and paragraph separators: a JavaScript line end (probe).
  { ch: " ", name: "line separator", hidden: true },
  { ch: " ", name: "paragraph separator", hidden: true },
  // Blank-looking letters (probe).
  { ch: "ㅤ", name: "Hangul filler", hidden: true },
  { ch: "ᅟ", name: "Hangul choseong filler", hidden: true },
  { ch: "ᅠ", name: "Hangul jungseong filler", hidden: true },
  { ch: "ﾠ", name: "half-width Hangul filler", hidden: true },
  { ch: "⠀", name: "blank braille pattern", hidden: true },
  // Zero-width and format characters (probe).
  { ch: "​", name: "zero-width space", hidden: true },
  { ch: "‌", name: "zero-width non-joiner", hidden: true },
  { ch: "‍", name: "zero-width joiner", hidden: true },
  { ch: "­", name: "soft hyphen", hidden: true },
  { ch: "⁡", name: "function application", hidden: true },
  { ch: "⁢", name: "invisible times", hidden: true },
  { ch: "⁣", name: "invisible separator", hidden: true },
  { ch: "⁤", name: "invisible plus", hidden: true },
  { ch: "͏", name: "combining grapheme joiner", hidden: true },
  { ch: "؜", name: "Arabic letter mark", hidden: true },
  { ch: "឴", name: "Khmer vowel inherent aq", hidden: true },
  { ch: "᠎", name: "Mongolian vowel separator", hidden: true },
  { ch: "﻿", name: "byte order mark", hidden: true },
  { ch: "￰", name: "unassigned special U+FFF0", hidden: true },
  // Direction marks, overrides, isolates.
  { ch: "‎", name: "left-to-right mark", hidden: true },
  { ch: "‮", name: "right-to-left override", hidden: true },
  { ch: "⁦", name: "left-to-right isolate", hidden: true },
  // Variation selectors and tags.
  { ch: "️", name: "variation selector 16", hidden: true },
  { ch: "\u{e0100}", name: "variation selector 17", hidden: true },
  { ch: "\u{e0041}", name: "tag A", hidden: true },
  { ch: "\u{1bca0}", name: "shorthand format letter overlap", hidden: true },
  { ch: "\u{1d173}", name: "musical symbol begin beam", hidden: true },
  // Spaces that are not U+0020.
  { ch: " ", name: "no-break space", hidden: true },
  { ch: " ", name: "em space", hidden: true },
  { ch: " ", name: "narrow no-break space", hidden: true },
  { ch: "　", name: "ideographic space", hidden: true },
  // Private use, unassigned, a lone surrogate.
  { ch: "", name: "private use U+E000", hidden: true },
  { ch: "\u{f0000}", name: "private use plane 15", hidden: true },
  { ch: "͸", name: "unassigned U+0378", hidden: true },
  { ch: "\ud800", name: "a lone high surrogate", hidden: true },
];
