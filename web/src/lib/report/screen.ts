// The screen hash of a "Cannot read a dialog" trouble signal (1.27.4): which dialog it was, as 8 hex
// characters, so two dialogs of one agent count apart in the daily ping.
//
// THE INPUT IS THE KEY-HINT ROW ONLY. Of the last {@link SCREEN_TAIL_ROWS} non-blank rows the card
// was drawn from, the lowest one that names a way out (esc, escape, ⎋ or the Nerd Font escape glyph)
// is the way-out row. It is hashed only when it is a short list of key hints, the shape an agent
// draws under a dialog (`enter select · esc back`), and a sentence is not. All of these must hold:
//   - the row is at most {@link SCREEN_ROW_MAX} characters;
//   - it splits into at least two segments on a hint separator (` · `, ` • `, ` | `, `│`);
//   - every segment is at most {@link SEGMENT_WORDS_MAX} words and {@link SEGMENT_CHARS_MAX} characters;
//   - at least two segments hold a key token;
//   - at least one key token is a key and nothing else (esc, ⎋, ⏎, ↑, ctrl+x, ...). The plain words
//     enter, tab, space, home and end count toward the segments, never toward this one.
// A row that fails the gate gives no hash at all. The lists name keys, never an agent: this file is
// shared code and stays harness-agnostic.
//
// NOTHING ELSE LEAVES THE PHONE. The rows stay here; only the hash goes to the bridge, and only on a
// `dialog` signal. FNV-1a 32 is pure and synchronous on purpose: `crypto.subtle` is missing on a phone
// that reaches the bridge over plain http. Pure.

import type { UnreadDialogModel } from "../harness/unread-dialog-model";

/** How many non-blank rows at the bottom of the screen the way-out row is looked for in. */
export const SCREEN_TAIL_ROWS = 6;

/** The longest normalized row that is still hashed, in characters. */
export const SCREEN_ROW_MAX = 160;

/** The most words one segment of a key-hint row may hold. */
export const SEGMENT_WORDS_MAX = 6;

/** The most characters one segment of a key-hint row may hold. */
export const SEGMENT_CHARS_MAX = 40;

/** What a screen hash looks like: 8 lower-case hex characters. */
export const SCREEN_HASH = /^[0-9a-f]{8}$/;

/** A row that names a way out of the dialog. */
const WAY_OUT = /\besc(?:ape)?\b|⎋|\u{F12B7}/iu;

/** Box glyphs (box drawing and block elements) and white space at either end of a row. */
const ROW_EDGES = /^[\s\u2500-\u259F]+|[\s\u2500-\u259F]+$/gu;

/** The separators between the hints of one row. */
const HINT_SEPARATOR = / · | • | \| |│/u;

/** Keys that are keys and nothing else: named keys, key glyphs, a modifier with its key (`ctrl+g`, `alt+←`, `^c`). */
const KEY_ONLY = [
  "(?:ctrl|alt|shift)\\+(?:[\\p{L}\\p{N}]+|[^\\s+])",
  "\\^[a-z]",
  "escape",
  "esc",
  "pgup",
  "pgdn",
  "⎋",
  "\\u{F12B7}",
  "⏎",
  "⇥",
  "␣",
  "↑",
  "↓",
  "←",
  "→",
  "⌥",
];

/** Keys whose names are also plain English words: they count toward the segments only. */
const KEY_WORDS = ["enter", "tab", "space", "home", "end"];

/** A whole token: no letter, digit or underscore right before or after it. */
const wholeTokens = (alternatives: readonly string[]): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`, "giu");

const KEY_ONLY_TOKEN = wholeTokens(KEY_ONLY);
const KEY_TOKEN = wholeTokens([...KEY_ONLY, ...KEY_WORDS]);

/** The lowest of the last {@link SCREEN_TAIL_ROWS} non-blank rows that names a way out, or null. */
export function wayOutRow(rows: readonly string[]): string | null {
  const tail = rows.filter((row) => row.trim() !== "").slice(-SCREEN_TAIL_ROWS);
  return tail.findLast((row) => WAY_OUT.test(row)) ?? null;
}

/** A row without the box glyphs and spaces at its ends, every run of white space one space. */
export function normalizeRow(row: string): string {
  return row.replace(ROW_EDGES, "").replace(/\s+/gu, " ");
}

/** The different key tokens a text holds, lower case, plain key words included. */
export function keyTokens(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(KEY_TOKEN), (match) => match[0].toLowerCase()));
}

/** The different tokens a text holds that are keys and nothing else, lower case. */
export function keyOnlyTokens(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(KEY_ONLY_TOKEN), (match) => match[0].toLowerCase()));
}

/** A normalized row cut at its hint separators, each segment trimmed, empty ones dropped. */
export function hintSegments(normalized: string): string[] {
  return normalized
    .split(HINT_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** Whether one segment is short enough to be one hint. */
const shortSegment = (segment: string): boolean =>
  segment.split(" ").length <= SEGMENT_WORDS_MAX && Array.from(segment).length <= SEGMENT_CHARS_MAX;

/** The privacy gate: a normalized row that is a short list of key hints (the rules at the top of this file). */
export function looksLikeKeyHints(normalized: string): boolean {
  if (normalized === "" || Array.from(normalized).length > SCREEN_ROW_MAX) return false;
  const segments = hintSegments(normalized);
  if (segments.length < 2 || !segments.every(shortSegment)) return false;
  if (segments.filter((segment) => keyTokens(segment).size > 0).length < 2) return false;
  return keyOnlyTokens(normalized).size > 0;
}

/** FNV-1a 32-bit over the UTF-8 bytes of a text, as 8 lower-case hex characters. */
export function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The screen hash of the rows a dialog card was drawn from: the way-out row, normalized, hashed when it
 * looks like key hints. Null when no row names a way out or the row fails the gate.
 */
export function dialogScreenHash(rows: readonly string[]): string | null {
  const row = wayOutRow(rows);
  if (row === null) return null;
  const normalized = normalizeRow(row);
  return looksLikeKeyHints(normalized) ? fnv1a32(normalized) : null;
}

/**
 * The screen hash of an unread-dialog card. Its signature is the card's last non-blank rows joined by
 * newlines (lib/harness/unread-dialog-model.ts `unreadDialogSignature`), more rows than the tail
 * this reads, so the hash is taken over the rows the card was drawn from and nothing else.
 */
export function unreadDialogScreen(cancel: Pick<UnreadDialogModel, "signature">): string | null {
  return dialogScreenHash(cancel.signature.split("\n"));
}
