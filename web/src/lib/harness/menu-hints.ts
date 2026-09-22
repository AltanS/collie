// The SHARED menu derivation helpers — the harness-agnostic half of the generic modal contract
// (menu-model.ts). Any adapter that wants menu buttons builds its MenuModel with these; only the
// harness-SPECIFIC conventions (where the region starts, what counts as its tail, how the input box
// is detected) belong in the adapter. Claude's reference detector: harness/claude/menu.ts.
//
// The invariants these encode, which the conformance suite (conformance.ts) re-checks against every
// adapter's fixture corpus:
//
//   * ONLY KEYS THE SCREEN NAMED. A menu is claimed on the strength of the screen naming its own
//     keys in a `·`-separated "<key> to <verb>" footer. Every emitted action key comes from that
//     footer; the only keys added are the ARROWS the screen advertised. Nothing is inferred.
//   * NO DIGITS, EVER (.adr/0009). Live-probed in Claude's `/model` picker: a digit confirms AND
//     writes the choice to the user's default for new sessions. A digit is a valid Herdr key, so
//     nothing downstream would reject one — the ban has to live in `menuKeyFor`.
//   * SIGNATURE FRESHNESS. The model carries a byte-signature of its region and every send re-derives
//     and compares it (lib/menu-action.ts). An adapter that returns an empty or constant signature
//     silently disables the race guard.
//   * LAST RESORT. Menu detection runs AFTER every specific grammar the adapter has, and must not
//     claim a screen with a live input box — a normal prompt whose statusline reads like hints is not
//     a modal, and claiming it would put fake buttons under a live composer.
//
// Pure functions over strings; no React, no pane access, no harness imports.

import type { MenuAction } from "./menu-model";

// The footer's segment separator: a middle dot with space on both sides. Anchored on the spaces so a
// dot inside a value ("Haiku 4.5 · Fastest") in a BODY row can't be mistaken for a footer — only the
// footer line is ever split, and its hints are always spaced.
const SEGMENT_SPLIT = /\s+·\s+/;

// One hint segment: "<key token> to <verb phrase>". Non-greedy on the key so "Enter to set as
// default" yields "Enter" / "set as default" rather than swallowing the first "to".
const HINT = /^(.+?)\s+to\s+(.+)$/i;

/** An "<value> ←/→ to <verb>" row. Group 1 is everything left of the arrows — the value being
 *  adjusted; group 2 is the verb. Exported so an adapter scans its region rows with the same grammar. */
export const MENU_ARROW_ROW = /^(.*?)\s*←\/→\s+to\s+(.+)$/;

/** Herdr keys for the Up/Down highlight nav, when `nav.upDown` is set. */
export const MENU_UP_KEYS = ["Up"];
export const MENU_DOWN_KEYS = ["Down"];
/** Herdr keys for the `←/→` adjust nav, when `nav.leftRight` is set. */
export const MENU_LEFT_KEYS = ["Left"];
export const MENU_RIGHT_KEYS = ["Right"];

/**
 * Map a footer's key TOKEN to a Herdr `pane.send_keys` key, or null when it isn't one we can send.
 * The whitelist is deliberately small (CLAUDE.md / HERDR_API.md — the grammar is `+`-joined, and
 * PageUp/Home/End/Delete are rejected upstream, so they are never emitted):
 *
 *   enter · esc/escape · tab · shift+tab · a bare lowercase letter · ↑ ↓ ← → · ctrl+<letter>
 *
 * NOT digits: see the header and .adr/0009. A digit token would be a valid Herdr key, which is
 * exactly why the ban has to live here rather than being left to the key validator.
 */
export function menuKeyFor(token: string): string | null {
  const raw = token.trim();
  const lower = raw.toLowerCase();
  if (lower === "enter") return "Enter";
  if (lower === "esc" || lower === "escape") return "Escape";
  if (lower === "tab") return "Tab";
  if (lower === "shift+tab") return "shift+tab";
  if (raw === "↑") return "Up";
  if (raw === "↓") return "Down";
  if (raw === "←") return "Left";
  if (raw === "→") return "Right";
  // A bare lowercase letter, matched case-SENSITIVELY: "S" and "s" are different keystrokes, and
  // Claude prints the one it means. An uppercase token is prose ("A" in "A to Z"), not a key hint.
  if (/^[a-z]$/.test(raw)) return raw;
  const ctrl = /^ctrl\+([a-z])$/.exec(lower);
  if (ctrl) return `ctrl+${ctrl[1]}`;
  return null;
}

/** Sentence-capitalise a footer verb phrase for a button label ("cancel" → "Cancel"). */
export function capitaliseMenuLabel(phrase: string): string {
  const t = phrase.trim();
  return t.length === 0 ? t : t[0]!.toUpperCase() + t.slice(1);
}

/**
 * Parse a KEY-HINT FOOTER into its actions. Returns `[]` when the line isn't one: fewer than two
 * `·`-separated segments, or no segment whose key token maps to a sendable key. A segment that
 * parses as a hint but names a key we can't send is SKIPPED (no button) rather than failing the
 * whole footer — the remaining hints are still honest, and the raw region stays visible below them.
 */
export function parseKeyHintFooter(text: string): MenuAction[] {
  const segments = text.trim().split(SEGMENT_SPLIT);
  if (segments.length < 2) return [];
  const actions: MenuAction[] = [];
  for (const segment of segments) {
    const m = HINT.exec(segment.trim());
    if (!m) continue;
    const key = menuKeyFor(m[1]!);
    if (key === null) continue;
    const action: MenuAction = { label: capitaliseMenuLabel(m[2]!), keys: [key] };
    if (key === "Escape") action.cancel = true;
    actions.push(action);
  }
  return actions;
}

/**
 * Whether ANY `·`-separated segment of `text` is a "<key> to <verb>" hint naming a sendable key — a
 * single "Esc to cancel" included, which `parseKeyHintFooter` deliberately refuses (it needs two
 * segments to claim a footer). This is the loose test, for the opposite job: not claiming a menu,
 * but REFUSING to call a screen safe to type into when one of its rows names a key the way a modal's
 * footer does.
 */
export function namesAMenuKey(text: string): boolean {
  return text
    .trim()
    .split(SEGMENT_SPLIT)
    .some((segment) => {
      const m = HINT.exec(segment.trim());
      return m !== null && menuKeyFor(m[1]!) !== null;
    });
}

// How many rows a wrapped key-hint footer may span. Three is what a real capture needs: Claude Code
// 2.1.278 runs the `/effort` footer onto three rows at 40 columns and two at 60. A bound rather than
// "keep going while it parses", because every extra row is one more chance for a body row to read
// like a hint.
const MAX_FOOTER_ROWS = 3;

// The SHAPE of one hint segment, looser than `HINT` above on purpose: it accepts "<key> for
// <phrase>" as well as "<key> to <verb>", because a screen that writes "s for this session only"
// still wrote a hint there. This is not used to BUILD an action — `parseKeyHintFooter` does that, and
// it keeps its narrower grammar — only to answer "is every part of this joined text hint text?",
// which is how a group of rows proves that all of it is footer and none of it is an option, a label
// or a rule.
const HINT_FORM = /^(.+?)\s+(?:to|for)\s+(.+)$/i;

/** A key-hint footer, read as the one or more rows the terminal wrapped it onto. */
export interface KeyHintFooter {
  /** The group's rows, trimmed and joined with one space — the text that was parsed. */
  text: string;
  /** The group's FIRST row, and its last. Both indices into the `texts` that were read. */
  startLine: number;
  endLine: number;
  /** What `parseKeyHintFooter` made of `text`. Never empty. */
  actions: MenuAction[];
}

/**
 * Read the key-hint footer at the tail of `texts`, joining the rows a narrow pane wrapped it onto.
 *
 * The group is the last `k` NON-BLANK rows, contiguous (a blank row ends it), with `k` at most
 * MAX_FOOTER_ROWS. A `k` is accepted when all three hold:
 *
 *   * every row carries the SAME left indent, because a wrapped footer is one block the renderer
 *     drew at one indent. This is what keeps ordinary agent output that scrolled in below a dialog
 *     out of the group: it is written at the transcript's indent, not the dialog's. ONE exception,
 *     for the wrap the TERMINAL did rather than the renderer: a row at indent 0 is still part of the
 *     block when the row above it could not have held that row's first word —
 *     `prev.trimEnd().length + 1 + firstWord(cont).length > width`, with `width` the longest row on
 *     the screen (a dialog's own `▔▔▔` and `───` rules run the full width, so that IS the column
 *     count). Claude's own flex wrap keeps the indent; the terminal's hard break puts the
 *     continuation at column 0. The evidence is
 *     `fixtures/panes/claude--menu-effort-slider--w60-ultracode.txt`: the footer's first row ends at
 *     column 57 of a 60-column pane, the next word is `only`, and it could not fit, so the terminal
 *     broke the line and the rest of the footer starts at column 0. A row at any OTHER indent than
 *     the block's, and a row at indent 0 whose predecessor had room for the next word, are still
 *     refused — the latter is ordinary output that happens to sit flush left;
 *   * every `·`-separated segment of the joined text is hint text (HINT_FORM), so a group holding an
 *     option row, a label row or a rule is refused whole rather than parsed in part;
 *   * `parseKeyHintFooter` gets at least one action out of the joined text.
 *
 * The LARGEST accepted `k` wins. Smallest-first would stop too early and read a true footer's tail as
 * the whole of it: at 40 columns `/effort`'s last two rows are "s for this session only · Esc to
 * cancel", which parses on its own and silently loses the two hints above it.
 *
 * Returns null when no group qualifies — the same answer `parseKeyHintFooter` gives for a line that
 * is not a footer, so a caller gains the wrapped case and loses no bail.
 */
export function readKeyHintFooter(texts: string[], maxRows: number = MAX_FOOTER_ROWS): KeyHintFooter | null {
  let end = texts.length - 1;
  while (end >= 0 && texts[end]!.trim() === "") end--;
  if (end < 0) return null;

  // The pane's column count, read off the screen rather than passed in: a dialog draws its own rules
  // edge to edge, so the longest row IS the width. Only the soft-wrap exception below uses it.
  const width = texts.reduce((w, t) => Math.max(w, t.length), 0);

  let best: KeyHintFooter | null = null;
  for (let k = 1; k <= maxRows; k++) {
    const start = end - k + 1;
    if (start < 0) break;
    if (texts[start]!.trim() === "") break; // a blank row ends the group; no larger k is contiguous
    const rows = texts.slice(start, end + 1);
    if (!rowsAreOneBlock(rows, width)) continue;
    const text = rows.map((t) => t.trim()).join(" ");
    const segments = text.split(SEGMENT_SPLIT);
    if (!segments.every((segment) => HINT_FORM.test(segment.trim()))) continue;
    const actions = parseKeyHintFooter(text);
    if (actions.length === 0) continue;
    best = { text, startLine: start, endLine: end, actions };
  }
  return best;
}

/**
 * Whether `rows` read as ONE block the renderer drew: every row at the first row's indent, save a
 * row at indent 0 the TERMINAL wrapped there (`softWrappedAt0`). See `readKeyHintFooter`'s comment.
 */
function rowsAreOneBlock(rows: string[], width: number): boolean {
  const indent = indentOf(rows[0]!);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (indentOf(row) === indent) continue;
    if (indentOf(row) !== 0) return false;
    if (!softWrappedAt0(rows[i - 1]!, row, width)) return false;
  }
  return true;
}

/**
 * Whether `cont` sits at column 0 because `prev` had no room for its first word. Trailing spaces on
 * `prev` are the grid's padding, not text the cursor passed, so they are trimmed first; the `+ 1` is
 * the space that would have separated the two words.
 */
function softWrappedAt0(prev: string, cont: string, width: number): boolean {
  const first = /\S+/.exec(cont);
  if (first === null) return false;
  return prev.trimEnd().length + 1 + first[0].length > width;
}

/** A row's left indent, in characters. Compared only between rows of one candidate footer group. */
function indentOf(text: string): number {
  return /^\s*/.exec(text)![0].length;
}
