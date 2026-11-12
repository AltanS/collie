// THE FOLD: one way to read a text as a person reads it, for comparison only. Agent views fold a line
// with it to find a view head and Collie's own phrases (agent-view/wire.ts), and the tricks schema folds a
// menu row's label with it to find a label that reads as Collie's own (tricks/schema.ts
// `menuLabelProblem`). A leaf: it imports the shared hidden-character predicate and nothing else, so the
// bridge, the CLI and the web load it by relative path.

import { isHiddenChar } from "./hidden-chars";

/** Combining marks, removed after NFD so `v̲iew` reads `view`. */
const MARK = /\p{M}/gu;
/**
 * Look-alikes NFKC leaves alone, for the characters of `[view:`, `[morph`, `] from operator:` (review 9
 * M2): Cyrillic and Greek letters, small capitals, and brackets and colons of other scripts.
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
  "\u27e6": "[", "\u27e8": "[", "\u3014": "[", "\u3010": "[", "\u3016": "[", "\u3018": "[", "\u301a": "[",
  "\u2768": "[", "\u276a": "[", "\u2772": "[", "\u2045": "[", "\u298b": "[", "\u298d": "[", "\u298f": "[",
  "\u27e7": "]", "\u27e9": "]", "\u3015": "]", "\u3011": "]", "\u3017": "]", "\u3019": "]", "\u301b": "]",
  "\u2769": "]", "\u276b": "]", "\u2773": "]", "\u2046": "]", "\u298c": "]", "\u298e": "]", "\u2990": "]",
  "\ua789": ":", "\u2236": ":", "\u02f8": ":", "\u0589": ":", "\u05c3": ":", "\u16ec": ":", "\ufe55": ":",
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
