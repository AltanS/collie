// Parse and print a binding in Herdr's key grammar (M108).
//
//   binding  = [ "prefix+" ] chord
//   chord    = { modifier "+" } key
//
// Modifiers, case-insensitive: `ctrl|control`, `shift`, `alt|option|meta`, `cmd|command|super`, and
// `mod`, which is `cmd` on a Mac and `ctrl` elsewhere. Herdr reads `meta` as Alt, so this does too:
// in the file, Cmd is spelled `cmd`. Keys: one character, or `space enter|return esc|escape tab
// backspace|bs left right up down f1..f12 minus comma period slash backslash quote
// double_quote semicolon colon percent ampersand backtick plus`. A literal `+` is `plus` or `++`.
// An upper-case letter adds Shift. `1..9` stands for the nine digits and is valid for an indexed
// action only. Source of the grammar: herdr src/config/keybinds.rs (`parse_key_combo`).

import { canonicalChord, isFunctionKey, isLetter, isSingleChar } from "./chord";
import type { Binding, Chord, DiagnosticCode } from "./types";

export interface ParseOptions {
  /** `mod` means Cmd when true, Ctrl when false. */
  readonly mac?: boolean;
  /** The action takes a number: `1..9` expands, and a single binding must be one digit. */
  readonly indexed?: boolean;
}

export interface ParseError {
  readonly code: Extract<DiagnosticCode, "invalid-binding" | "range-not-indexed" | "indexed-needs-digit">;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly bindings: readonly Binding[] }
  | { readonly ok: false; readonly error: ParseError };

type Modifier = "ctrl" | "shift" | "alt" | "meta" | "mod";

interface Flags {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

const MODIFIERS: ReadonlyMap<string, Modifier> = new Map<string, Modifier>([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["shift", "shift"],
  ["alt", "alt"],
  ["option", "alt"],
  ["meta", "alt"],
  ["cmd", "meta"],
  ["command", "meta"],
  ["super", "meta"],
  ["mod", "mod"],
]);

const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["space", "space"],
  ["enter", "enter"],
  ["return", "enter"],
  ["esc", "esc"],
  ["escape", "esc"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["bs", "backspace"],
  ["left", "left"],
  ["right", "right"],
  ["up", "up"],
  ["down", "down"],
  ["minus", "-"],
  ["comma", ","],
  ["period", "."],
  ["slash", "/"],
  ["backslash", "\\"],
  ["quote", "'"],
  ["double_quote", '"'],
  ["double-quote", '"'],
  ["semicolon", ";"],
  ["colon", ":"],
  ["percent", "%"],
  ["ampersand", "&"],
  ["backtick", "`"],
  ["plus", "+"],
]);

const PREFIX_FORM = /^prefix\s*\+/i;
const RANGE = "1..9";
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function fail(code: ParseError["code"], message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

/** `a+b+c` as tokens, with a literal plus kept as its own token: `ctrl++` and a lone `+`. */
function splitTokens(body: string): string[] {
  if (body === "+") return ["+"];
  if (!body.endsWith("++")) return body.split("+");
  const modifiers = body.slice(0, -2);
  return modifiers === "" ? ["+"] : [...modifiers.split("+"), "+"];
}

function applyModifier(flags: Flags, modifier: Modifier, mac: boolean): Flags {
  if (modifier === "mod") return mac ? { ...flags, meta: true } : { ...flags, ctrl: true };
  return { ...flags, [modifier]: true };
}

/** The chord key a key token names, and whether its case already asked for Shift. Null if unknown. */
function readKey(token: string): { key: string; shift: boolean } | null {
  const lower = token.toLowerCase();
  const named = NAMED_KEYS.get(lower);
  if (named !== undefined) return { key: named, shift: false };
  if (isSingleChar(token)) {
    const isUpper = isLetter(token) && token !== lower;
    return { key: isSingleChar(lower) ? lower : token, shift: isUpper };
  }
  return isFunctionKey(lower) ? { key: lower, shift: false } : null;
}

/**
 * Parse one binding text. A range expands to nine bindings, a single binding gives one. A bad
 * binding is a typed error and never throws: the caller drops it and goes on with the rest.
 */
export function parseBinding(text: string, options: ParseOptions = {}): ParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return fail("invalid-binding", "the binding is empty");
  const prefixMatch = PREFIX_FORM.exec(trimmed);
  const isPrefix = prefixMatch !== null;
  const body = prefixMatch === null ? trimmed : trimmed.slice(prefixMatch[0].length);

  let flags: Flags = { ctrl: false, shift: false, alt: false, meta: false };
  let keyToken: string | null = null;
  let hasRange = false;
  for (const raw of splitTokens(body)) {
    const token = raw.trim();
    if (token === "") return fail("invalid-binding", "an empty part between two plus signs");
    if (token === RANGE) {
      if (hasRange || keyToken !== null) return fail("invalid-binding", "a range must be the only key");
      hasRange = true;
      continue;
    }
    const modifier = MODIFIERS.get(token.toLowerCase());
    if (modifier !== undefined) {
      flags = applyModifier(flags, modifier, options.mac ?? false);
      continue;
    }
    if (keyToken !== null || hasRange) return fail("invalid-binding", "more than one key");
    keyToken = token;
  }

  if (hasRange) return expandRange({ flags, isPrefix, indexed: options.indexed ?? false });
  if (keyToken === null) return fail("invalid-binding", "no key, only modifiers");
  const read = readKey(keyToken);
  if (read === null) return fail("invalid-binding", `unknown key "${keyToken}"`);

  const index = digitIndex(read.key);
  if (options.indexed && index === null) return fail("indexed-needs-digit", "an indexed action takes the keys 1 to 9");
  const chord = canonicalChord({ ...flags, key: read.key, shift: flags.shift || read.shift });
  const binding: Binding = options.indexed && index !== null ? { prefix: isPrefix, chord, index } : { prefix: isPrefix, chord };
  return { ok: true, bindings: [binding] };
}

function digitIndex(key: string): number | null {
  const found = DIGITS.findIndex((digit) => digit === key);
  return found === -1 ? null : found + 1;
}

function expandRange(input: { flags: Flags; isPrefix: boolean; indexed: boolean }): ParseResult {
  if (!input.indexed) return fail("range-not-indexed", "1..9 is only valid for an action that takes a number");
  const bindings = DIGITS.map((digit, position): Binding => ({
    prefix: input.isPrefix,
    chord: canonicalChord({ ...input.flags, key: digit }),
    index: position + 1,
  }));
  return { ok: true, bindings };
}

export interface FormatOptions {
  /** Prints Cmd and Option instead of Meta and Alt. */
  readonly mac: boolean;
  /** The configured prefix chord, printed in place of the word `prefix`. */
  readonly prefix: Chord;
}

const KEY_CAPS: ReadonlyMap<string, string> = new Map([
  ["space", "Space"],
  ["enter", "Enter"],
  ["esc", "Esc"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["left", "Left"],
  ["right", "Right"],
  ["up", "Up"],
  ["down", "Down"],
]);

/** A chord as key caps: `["Ctrl", "B"]`. With a modifier the letter is a cap (`B`), bare it is as typed. */
export function chordKeycaps(input: { chord: Chord; mac: boolean }): string[] {
  const { chord, mac } = input;
  const caps: string[] = [];
  if (chord.ctrl) caps.push("Ctrl");
  if (chord.alt) caps.push(mac ? "Option" : "Alt");
  if (chord.shift) caps.push("Shift");
  if (chord.meta) caps.push(mac ? "Cmd" : "Meta");
  const named = KEY_CAPS.get(chord.key);
  if (named !== undefined) return [...caps, named];
  if (isFunctionKey(chord.key)) return [...caps, chord.key.toUpperCase()];
  return [...caps, caps.length > 0 ? chord.key.toUpperCase() : chord.key];
}

/** A binding as key caps. A prefix binding opens with the prefix chord: `["Ctrl", "B", "c"]`. */
export function bindingKeycaps(binding: Binding, options: FormatOptions): string[] {
  const own = chordKeycaps({ chord: binding.chord, mac: options.mac });
  if (!binding.prefix) return own;
  return [...chordKeycaps({ chord: options.prefix, mac: options.mac }), ...own];
}

/** A binding as text, the key caps joined by a space: `Ctrl B c`. */
export function formatBinding(binding: Binding, options: FormatOptions): string {
  return bindingKeycaps(binding, options).join(" ");
}
