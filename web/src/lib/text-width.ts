// East-Asian-aware display width — no dependency.
//
// A terminal lays CJK ideographs, Hangul, and fullwidth forms out at TWO column cells;
// `String.prototype.length` (UTF-16 code units) and even a code-point count both disagree with
// what the pane's own renderer did. `markers.ts` needs this to measure a candidate input-box
// border in the same units Claude's renderer draws it in — a border's minimum width is a claim
// about screen columns, not characters, and a CJK label (`─ 中文 ─`, 8 columns) or a combining-mark
// label (`── é ──`, 7 columns when decomposed) gets that claim wrong in opposite directions if
// measured by `.length`. The table below is written as explicit code-point ranges (no
// `string-width`/`eastasianwidth` package) — it approximates the Unicode East Asian Width
// property's Wide (W) and Fullwidth (F) categories, which is the same set most terminal emulators'
// `wcwidth` implementations treat as double-width. Ambiguous (A) glyphs (→ × ※ …) are deliberately
// left OUT of the wide table and so count as width 1.

// MUST stay sorted ascending by lower bound — `inRanges`'s early-return scan depends on it (a test
// below pins sortedness so a future edit can't silently break the lookup). Transcribed from
// Unicode 17.0's EastAsianWidth.txt (https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt),
// W and F categories only, restricted to the blocks a terminal actually renders double-width. The
// Supplemental Symbols and Pictographs ranges (U+1F300 and up) are intentionally FRAGMENTED, not
// one blanket span: the same blocks also contain plenty of explicitly-Narrow code points (arrows,
// chess pieces, box-sextant glyphs, …) interleaved with the Wide emoji — collapsing them into one
// range would silently mis-widen those. Gaps between consecutive Wide sub-ranges here are
// reserved/narrow code points on purpose, not omissions.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x268a, 0x268f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK Radicals Supplement .. CJK Symbols and Punctuation (incl. U+3000-303E)
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compat Jamo, CJK strokes/compat
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables / Radicals
  [0xa960, 0xa97c], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical Forms
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xfe50, 0xfe52], // Small Form Variants (small punctuation, incl. small comma..full stop)
  [0xfe54, 0xfe66], // Small Form Variants continued (small semicolon..equals sign)
  [0xfe68, 0xfe6b], // Small Form Variants continued (small reverse solidus..commercial at)
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x1b000, 0x1b122], // Kana Supplement .. Kana Extended-A (part 1)
  [0x1b132, 0x1b132], // Hiragana small ko
  [0x1b150, 0x1b152], // Small Kana Extension (hiragana wi/we/wo)
  [0x1b155, 0x1b155], // Small Kana Extension (katakana small ko)
  [0x1b164, 0x1b167], // Small Kana Extension (katakana wi/we/wo/n)
  [0x1b170, 0x1b2fb], // Nushu
  [0x1f004, 0x1f004], // Mahjong Tile Red Dragon
  [0x1f0cf, 0x1f0cf], // Playing Card Black Joker
  [0x1f18e, 0x1f18e], // Negative Squared AB
  [0x1f191, 0x1f19a], // Squared Latin abbreviations (CL, WC, …)
  [0x1f200, 0x1f202], // Squared Katakana / Hiragana
  [0x1f210, 0x1f23b], // Squared CJK Unified Ideographs
  [0x1f240, 0x1f248], // Tortoise-shell-bracketed CJK Unified Ideographs
  [0x1f250, 0x1f251], // Circled Ideograph Advantage/Accept
  [0x1f260, 0x1f265], // Rounded symbols
  [0x1f300, 0x1f320], // Miscellaneous Symbols and Pictographs (part 1: weather/celestial)
  [0x1f32d, 0x1f335], // (hot dog..cactus)
  [0x1f337, 0x1f37c], // (tulip..baby bottle)
  [0x1f37e, 0x1f393], // (bottle with popping cork..graduation cap)
  [0x1f3a0, 0x1f3ca], // (carousel horse..swimmer)
  [0x1f3cf, 0x1f3d3], // (cricket bat/ball..table tennis)
  [0x1f3e0, 0x1f3f0], // (house..european castle)
  [0x1f3f4, 0x1f3f4], // waving black flag
  [0x1f3f8, 0x1f43e], // (badminton..paw prints, incl. Emoji Modifier Fitzpatrick skin tones)
  [0x1f440, 0x1f440], // eyes
  [0x1f442, 0x1f4fc], // (ear..videocassette)
  [0x1f4ff, 0x1f53d], // (prayer beads..down-pointing red triangle)
  [0x1f54b, 0x1f54e], // (kaaba..menorah)
  [0x1f550, 0x1f567], // clock faces
  [0x1f57a, 0x1f57a], // man dancing
  [0x1f595, 0x1f596], // hand gestures
  [0x1f5a4, 0x1f5a4], // black heart
  [0x1f5fb, 0x1f64f], // (mount fuji..person with folded hands, incl. all face emoji)
  [0x1f680, 0x1f6c5], // (rocket..left luggage)
  [0x1f6cc, 0x1f6cc], // sleeping accommodation
  [0x1f6d0, 0x1f6d2], // (place of worship..shopping trolley)
  [0x1f6d5, 0x1f6d8], // (hindu temple..landslide)
  [0x1f6dc, 0x1f6df], // (wireless..ring buoy)
  [0x1f6eb, 0x1f6ec], // airplane departure/arriving
  [0x1f6f4, 0x1f6fc], // (scooter..roller skate)
  [0x1f7e0, 0x1f7eb], // large colored circles/squares
  [0x1f7f0, 0x1f7f0], // heavy equals sign
  [0x1f90c, 0x1f93a], // (pinched fingers..fencer)
  [0x1f93c, 0x1f945], // (wrestlers..goal net)
  [0x1f947, 0x1f9ff], // (medals..nazar amulet — most of Supplemental Symbols and Pictographs)
  [0x1fa70, 0x1fa7c], // Symbols and Pictographs Extended-A (part 1)
  [0x1fa80, 0x1fa8a], // (yo-yo..trombone)
  [0x1fa8e, 0x1fac6], // (treasure chest..fingerprint)
  [0x1fac8, 0x1fac8], // hairy creature
  [0x1facd, 0x1fadc], // (orca..root vegetable)
  [0x1fadf, 0x1faea], // (splatter..distorted face)
  [0x1faef, 0x1faf8], // (fight cloud..rightwards pushing hand)
  [0x20000, 0x2fffd], // CJK Unified Ideographs Extension B..F (plane 2)
  [0x30000, 0x3fffd], // CJK Unified Ideographs Extension G (plane 3)
];

// Combining marks and zero-width formatting controls: these attach to (or sit invisibly beside) a
// base character and add no column width of their own. Not exhaustive of Unicode's Mn/Cf
// categories — a pragmatic set covering the diacritics and formatting controls that actually show
// up in agent output (accented Latin, variation selectors, zero-width joiners/spaces).
const COMBINING_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x200b, 0x200f], // zero-width space, ZWJ/ZWNJ, directional marks
  [0x2060, 0x2064], // word joiner, invisible math operators
  [0x20d0, 0x20ff], // Combining Diacritical Marks for Symbols
  [0x3099, 0x309a], // Combining Katakana-Hiragana Voiced/Semi-Voiced Sound Marks — sit INSIDE the
  // Hiragana/Katakana WIDE range above (U+3041-33FF) but combine onto a base kana, so they must be
  // checked (and win) before the wide-range test.
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f], // Combining Half Marks
  [0xfeff, 0xfeff], // zero-width no-break space / BOM
];

// Ranges above are sorted ascending by lower bound, so a linear scan can bail the moment `cp` is
// below the current range's floor — no code point in a later (higher) range could match either.
function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

// `Intl.Segmenter` is the newest platform API this module depends on (Firefox 125, Safari 14.1).
// Feature-detected: an engine without it must lose grapheme-cluster precision (falling back to
// iterating code points, which still handles surrogate pairs correctly via `for...of`), never
// white-screen the app at module-evaluation time.
const GRAPHEMES =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function clusters(text: string): string[] {
  if (GRAPHEMES === null) return [...text];
  return [...GRAPHEMES.segment(text)].map((s) => s.segment);
}

// A cluster's width is its BASE code point's width — a combining mark riding along in the same
// cluster (café's "é" as e + combining acute, under Intl.Segmenter) contributes nothing extra, and
// a combining mark that arrives as its own "cluster" (no Segmenter, or a stray mark with no base)
// correctly resolves to 0 via COMBINING_RANGES rather than falling through to the width-1 default.
function clusterWidth(cluster: string): number {
  const cp = cluster.codePointAt(0);
  if (cp === undefined) return 0;
  if (inRanges(cp, COMBINING_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/** East-Asian-aware display width: W/F code points count 2 columns, combining marks 0, else 1.
 *  Iterates grapheme clusters (feature-detected `Intl.Segmenter`, code points otherwise); a
 *  cluster's width is its base code point's width. Ambiguous (A) glyphs count 1. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of clusters(text)) width += clusterWidth(cluster);
  return width;
}

export { WIDE_RANGES, COMBINING_RANGES };
