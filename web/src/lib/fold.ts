// THE FOLD: one way to read a text as a person reads it, for comparison only. Agent views fold a line
// with it to find a view head and Collie's own phrases (agent-view/wire.ts), and the tricks schema folds a
// menu row's label with it to find a label that reads as Collie's own (tricks/schema.ts
// `menuLabelProblem`). A leaf: it imports the shared hidden-character predicate and nothing else, so the
// bridge, the CLI and the web load it by relative path.

import { isHiddenChar } from "./hidden-chars";

/**
 * Cherokee letters that pass for Latin ones (Unicode's confusables), by capital code point. Both cases go
 * in the map: the capital (U+13A0 on) and its small letter (U+AB70 on, U+13F8 on for the last six).
 */
const CHEROKEE_CAPITALS = {
  0x13a0: "d", 0x13a1: "r", 0x13a2: "t", 0x13a5: "i", 0x13a9: "y", 0x13aa: "a", 0x13ab: "j", 0x13ac: "e",
  0x13b3: "w", 0x13b7: "m", 0x13bb: "h", 0x13c0: "g", 0x13c2: "h", 0x13c3: "z", 0x13cf: "b", 0x13d2: "r",
  0x13da: "s", 0x13d9: "v", 0x13de: "l", 0x13df: "c", 0x13e2: "p", 0x13e6: "k", 0x13f4: "b",
} satisfies Record<number, string>;
const CHEROKEE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CHEROKEE_CAPITALS).flatMap(([code, latin]) => {
    const capital = Number(code);
    const small = capital >= 0x13f0 ? capital + 8 : capital + 0x97d0;
    return [
      [String.fromCodePoint(capital), latin],
      [String.fromCodePoint(small), latin],
    ];
  }),
);

/** Combining marks, removed after NFD so `v̲iew` reads `view`. */
const MARK = /\p{M}/gu;
/**
 * THE ONE LOOK-ALIKE MAP: letters of other scripts that NFKC leaves alone, each to the Latin letter it
 * passes for, and brackets and colons of other scripts. First for the characters of `[view:`, `[morph`,
 * `] from operator:` (review 9 M2), then the letters of Collie's own words (review 10), then Armenian,
 * Latin, more Greek and Cyrillic, and Cherokee in both cases (review 12 M3; lower case first, so a
 * Cherokee capital arrives as its small letter, U+AB70 on). The agent view's head rule and the trick
 * label rule fold with it alike.
 */
const CONFUSABLE = new Map(Object.entries({
  "\u0430": "a", "\u0435": "e", "\u0456": "i", "\u043c": "m", "\u043e": "o", "\u0440": "p", "\u0442": "t",
  "\u04bb": "h", "\u0475": "v", "\u051d": "w", "\u0491": "r",
  "\u03b1": "a", "\u03b5": "e", "\u03b7": "n", "\u03b9": "i", "\u03bc": "m", "\u03bd": "v", "\u03bf": "o",
  "\u03c1": "p", "\u03c4": "t", "\u03c9": "w",
  "\u1d00": "a", "\u1d07": "e", "\u026a": "i", "\u1d0d": "m", "\u0274": "n", "\u1d0f": "o", "\u1d18": "p",
  "\u0280": "r", "\u1d1b": "t", "\u1d20": "v", "\u1d21": "w", "\u029c": "h", "\ua730": "f",
  // The letters of Collie's own words (review 10): Cyrillic c, s, d, y, x, k, the palochka, and small capitals.
  "\u0441": "c", "\u0455": "s", "\u0501": "d", "\u0443": "y", "\u0445": "x", "\u043a": "k", "\u04cf": "l",
  "\u1d04": "c", "\u029f": "l",
  // Review 12 M3: Armenian, Latin alpha and friends, more Greek and Cyrillic.
  "\u0585": "o", "\u0578": "n", "\u057d": "u", "\u0570": "h", "\u0581": "g", "\u056c": "l", "\u0566": "q",
  "\u0251": "a", "\u0261": "g", "\u0269": "i", "\u0131": "i", "\u0237": "j", "\u01c0": "l",
  "\u03ba": "k", "\u03c5": "u", "\u03c7": "x", "\u03f2": "c", "\u03f3": "j",
  "\u0458": "j", "\u051b": "q",
  "\u27e6": "[", "\u27e8": "[", "\u3014": "[", "\u3010": "[", "\u3016": "[", "\u3018": "[", "\u301a": "[",
  "\u2768": "[", "\u276a": "[", "\u2772": "[", "\u2045": "[", "\u298b": "[", "\u298d": "[", "\u298f": "[",
  "\u27e7": "]", "\u27e9": "]", "\u3015": "]", "\u3011": "]", "\u3017": "]", "\u3019": "]", "\u301b": "]",
  "\u2769": "]", "\u276b": "]", "\u2773": "]", "\u2046": "]", "\u298c": "]", "\u298e": "]", "\u2990": "]",
  "\ua789": ":", "\u2236": ":", "\u02f8": ":", "\u0589": ":", "\u05c3": ":", "\u16ec": ":", "\ufe55": ":",
  ...CHEROKEE,
} satisfies Record<string, string>));

/**
 * One line as an agent would read it once typed, folded for comparison: every hidden character (the
 * shared {@link isHiddenChar}, which holds Cc, so ESC and DEL too) removed as the typing path removes
 * them, a tab made a space, then NFKC, lower case, combining marks removed and look-alikes folded.
 */
export function foldViewLine(line: string): string {
  let kept = "";
  for (const ch of line) {
    if (ch === "\t") kept += " ";
    else if (!isHiddenChar(ch)) kept += ch;
  }
  const folded = kept.normalize("NFKC").toLowerCase().normalize("NFD").replace(MARK, "");
  let out = "";
  for (const ch of folded) out += CONFUSABLE.get(ch) ?? ch;
  return out;
}

/** A text's words, folded as the head rule folds ({@link foldViewLine}), every run of other characters one space, padded. */
export function foldedWords(text: string): string {
  return ` ${foldViewLine(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * The look-alike CLASSES of Latin itself (review 12 M3), after the fold: capital I and lower case l, the
 * digit 1, a bar, read alike, and the digit 0 and o; then `rn` reads `m` and `vv` reads `w`, as Unicode's
 * skeleton (UTS 39) reads them. For a comparison only, applied to both sides alike: no text is ever shown
 * or stored as its skeleton.
 */
const LATIN_CLASS = new Map(Object.entries({ i: "l", "1": "l", "|": "l", "!": "l", "0": "o" } satisfies Record<string, string>));

/** A text's words as {@link foldedWords}, reduced to their skeleton, for comparing a label with Collie's own words. */
export function skeletonWords(text: string): string {
  let classed = "";
  for (const ch of foldViewLine(text)) classed += LATIN_CLASS.get(ch) ?? ch;
  const skeleton = classed.replaceAll("rn", "m").replaceAll("vv", "w");
  return ` ${skeleton.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}
