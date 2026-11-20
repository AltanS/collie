// The key vocabulary shared by the parser, the keymap and the resolver: what a chord is, the one
// text id every map is keyed on, and how a browser key name becomes a chord's key.
//
// A chord's `key` is lower case for a letter, the character itself for a symbol or digit, and a
// named id (`space`, `enter`, `esc`, `tab`, `backspace`, `left`, `right`, `up`, `down`, `f1`..`f12`)
// for the rest. A shifted symbol is canonical: `shift+/` and `?` are one chord, `?` with no shift,
// because the character already says the shift was held. A letter keeps its shift (`shift+n`).

import type { Chord } from "./types";

/** Printable symbols that need Shift on a US keyboard, by the key beside them. Parsing folds
 *  `shift+/` into `?`; matching folds an event the same way. */
const SHIFTED_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["1", "!"],
  ["2", "@"],
  ["3", "#"],
  ["4", "$"],
  ["5", "%"],
  ["6", "^"],
  ["7", "&"],
  ["8", "*"],
  ["9", "("],
  ["0", ")"],
  ["-", "_"],
  ["=", "+"],
  ["[", "{"],
  ["]", "}"],
  ["\\", "|"],
  [";", ":"],
  ["'", '"'],
  [",", "<"],
  [".", ">"],
  ["/", "?"],
  ["`", "~"],
]);

const TYPED_WITH_SHIFT: ReadonlySet<string> = new Set(SHIFTED_SYMBOLS.values());

const EVENT_KEY_NAMES: ReadonlyMap<string, string> = new Map([
  [" ", "space"],
  ["Spacebar", "space"],
  ["Enter", "enter"],
  ["Escape", "esc"],
  ["Tab", "tab"],
  ["Backspace", "backspace"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
]);

const FUNCTION_KEY = /^f(?:[1-9]|1[0-2])$/;

/** `ctrl`, `alt`, `shift`, `meta` in that order, then the key: the id every map is keyed on. */
export function chordId(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  if (chord.meta) parts.push("meta");
  parts.push(chord.key);
  return parts.join("+");
}

/** Whether the text is one character (one code point), as a typed key is. */
export function isSingleChar(text: string): boolean {
  return Array.from(text).length === 1;
}

/** A character that has a case. Digits and punctuation do not. */
export function isLetter(char: string): boolean {
  return char.toLowerCase() !== char.toUpperCase();
}

export function isFunctionKey(key: string): boolean {
  return FUNCTION_KEY.test(key);
}

/** The symbol a US keyboard types for Shift plus this key (`/` gives `?`), or null. */
export function shiftedSymbol(key: string): string | null {
  return SHIFTED_SYMBOLS.get(key) ?? null;
}

/** Fold `shift+<symbol key>` into the symbol it types, so one chord has one spelling: `shift+/`,
 *  `shift+?` and `?` are one chord. */
export function canonicalChord(chord: Chord): Chord {
  if (!chord.shift) return chord;
  const symbol = shiftedSymbol(chord.key);
  if (symbol !== null) return { ...chord, key: symbol, shift: false };
  return TYPED_WITH_SHIFT.has(chord.key) ? { ...chord, shift: false } : chord;
}

/** A browser `KeyboardEvent.key` as a chord key: `Escape` is `esc`, `N` is `n`, `F5` is `f5`. */
export function eventKeyId(key: string): string {
  const named = EVENT_KEY_NAMES.get(key);
  if (named !== undefined) return named;
  const lower = key.toLowerCase();
  if (!isSingleChar(key)) return lower;
  return isSingleChar(lower) ? lower : key;
}
