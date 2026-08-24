// Shared lexing helpers over the parsed `StyledLine[]` — the primitives Grok's chrome stripping
// leans on, and where a future Grok grammar would add its own. Same methodology as
// harness/omp/markers.ts and harness/claude/markers.ts and deliberately NOT the same code: an
// adapter that imported another adapter's predicates would inherit that harness's renderer
// archaeology. Grok's box is rounded like omp's but the STATUS lives in the BOTTOM border, the
// draft lives on a `│ ❯ … │` inner row, and a blank + key-hint row sit UNDER the box. They operate
// on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (Grok paints the `╰─` fill and the
// status inside it as separate styled segments — probed on `pane.read format:ansi`, 2026-08-21).
// Pure functions, no I/O, no React.

import { isBlank, lineText, type StyledLine } from "../../blocks";

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar, so they live in the
// neutral core (lib/blocks.ts). Re-exported here so the Grok grammars keep their single import site
// — the same arrangement omp/markers.ts and claude/markers.ts use, for the same reason.
export { isBlank, lineText };

/**
 * Drop TRAILING whitespace only. Every one of Grok's box rows is padded out to the terminal's full
 * column count, so the closing glyph of a border is followed by nothing on a real capture but by a
 * run of spaces in the buffer — an anchored `…$` regex would never match without this. Leading
 * whitespace is deliberately NOT dropped: Grok indents the box by two columns, and that indent is
 * not load-bearing beyond "optional spaces before the corner".
 *
 * The pad is spaces on the ANSI grid Collie actually parses. Herdr's *text* snapshot sometimes
 * draws a `█` scrollbar instead; that glyph never reaches this layer.
 */
export function rstrip(text: string): string {
  return text.replace(/\s+$/, "");
}

// `[\s\S]`, never `.`, in the row predicates that capture interior text. A dot is not "any glyph":
// JS excludes `\n`, `\r`, **U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR** from it. The
// first two can never reach here (splitLines cut on them), but the separators can: `rstrip` only
// takes them off the END of a row, so one anywhere else in a model display-name or a typed draft
// survives into `lineText` and silently declines the row. That fails in the worst direction:
// locateComposer returns null on every frame, the box stays duplicated, and `composerReady`
// refuses every reply while no dialog exists.

// Top border: rounded corners with nothing but a rule between them. Grok does NOT write the
// statusline into this row (omp does). Tight ON PURPOSE — a `╭── title ──╮` is some other widget.
// Loose on indent: the box sits two columns in. Never decisive alone; locateComposer only checks
// it after the bottom border and the inner-row walk have pinned the rest of the shape.
const COMPOSER_TOP = /^\s*╭─+╮$/;

/** True when the line could be the composer box's top border. Never decisive alone — see above. */
export function isComposerTop(text: string): boolean {
  return COMPOSER_TOP.test(rstrip(text));
}

// Bottom border: rule fill, then an opaque status run, then ` ─╯`. The status is whatever Grok
// painted — display name, optional `(effort)`, optional ` · mode` — and this file must never match
// those tokens. User bubbles close with square `└…┘` and no status run, which is why the capture
// group is the discriminator.
const COMPOSER_BOTTOM = /^\s*╰─+\s+([\s\S]+?)\s+─╯$/;

/**
 * Where the status run sits inside a bottom-border row, or null when the line is not that border.
 *
 * Indices are into `rstrip(text)` — the same string `locateComposer` classifies. extractStatusLines
 * uses the span to slice the original SGR segments rather than restyle the words as a new run.
 */
export function composerStatusSpan(text: string): { start: number; end: number; text: string } | null {
  const t = rstrip(text);
  const m = COMPOSER_BOTTOM.exec(t);
  if (m === null) return null;
  const body = m[1]!;
  if (body.trim() === "") return null;
  const prefix = /^\s*╰─+\s+/.exec(t);
  if (prefix === null) return null;
  const start = prefix[0].length;
  return { start, end: start + body.length, text: body };
}

/** Status text painted into the composer's bottom border, or null when the line is not that border. */
export function composerStatus(text: string): string | null {
  return composerStatusSpan(text)?.text ?? null;
}

// Inner box row, prompt or continuation. Grok pads every inner row to the box width.
const COMPOSER_INNER = /^\s*│ ([\s\S]*)│$/;
const COMPOSER_PROMPT = /^\s*│ ❯([\s\S]*)│$/;

/** Inner-row body (UNTRIMMED), or null when the line is not a `│ … │` box row. */
export function composerInnerText(text: string): string | null {
  const m = COMPOSER_INNER.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

/**
 * Draft fragment on the `│ ❯ … │` prompt row (UNTRIMMED, including the space Grok paints after
 * `❯` when the box is empty). Null when the line is not that row.
 */
export function composerPromptText(text: string): string | null {
  const m = COMPOSER_PROMPT.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

// A row that opens a box after optional indent. Used to refuse a composer that has another widget
// UNDER it. The whole Box Drawing block: this predicate's job is to REJECT, so being generous is
// fail-closed (a null composer, never a keystroke).
const BOX_ROW = /^\s*[─-╿]/;

/** True when this row is a box being drawn (rounded or square) after optional indent. */
export function opensBox(text: string): boolean {
  return BOX_ROW.test(rstrip(text));
}

// Grok's shortcut bar: `Shift+Tab:mode  │  Ctrl+.:shortcuts` idle, and the working/plan
// variants (`Ctrl+e:expand thinking`, `Space:prompt`, `a:approve`, `Tab:plan`, …).
// locateComposer may only treat those as hints. Arbitrary `word:word` transcript under the
// box is a torn/stale frame, not a hint run — treating it as a hint kept the composer
// writable after the dialog had replaced the bar. A bare `[stable]` chip was originally
// refused on the same reasoning, but a live capture proved it real chrome, not a torn frame
// — see isStatusChipRow below.
//
// Longer tokens first so `Tab/Space` is not read as `Tab` and `Enter` is not read as `E`.
const HINT_SEGMENT =
  /^(?:(?:Shift|Ctrl)\+(?:Tab|Space|Esc|Enter|Up|Down|[A-Za-z.])|Tab\/Space|Tab|Space|Esc|Enter|Up|Down|[A-Za-z]):\S/;

/**
 * True when the row is Grok's key-hint bar. Used to refuse a composer whose "hint run" is
 * actually later output — the fail-closed half of locating.
 */
export function isComposerHint(text: string): boolean {
  const t = rstrip(text);
  if (t === "") return false;
  const parts = t.split(/\s+│\s+/);
  return parts.length > 0 && parts.every((p) => HINT_SEGMENT.test(p.trim()));
}

// On the STARTUP screen the row under the composer holds only Grok's channel chip (`[stable]`)
// where an active session paints the key-hint bar; captured live 2026-08-22 (grok--startup.txt).
// Refusing that row — the original fail-closed call — kept composerReady false on every fresh
// pane, so the FIRST phone message of a session was refused. Only the LITERAL captured token
// qualifies: a looser bracket-run pattern would bless torn transcript ending in a bracket tag
// (`[waiting]`, `[ERROR]`, …) — reproduced in review — and reopen exactly the hazard the
// refusal guards. A new channel chip fails closed until a capture blesses it.
const CHIP_ROW = /^\[stable\]$/;

/** True when the row is exactly the startup screen's `[stable]` channel chip. */
export function isStatusChipRow(text: string): boolean {
  return CHIP_ROW.test(rstrip(text).trimStart());
}

/** Index of the last non-blank row in `texts`, or -1 when the buffer is all blank. */
export function lastNonBlankIndex(texts: string[]): number {
  let i = texts.length - 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  return i;
}

// The `┃` gutter card shared by the permission and ask dialogs. Both paint the same option row
// (`┃ <digit> (●|○) <body>`) and the same geometry: a contiguous run of `┃` rows, blank row(s),
// then the key-hint footer as the last non-blank row. The grammars stay separate — different
// widgets, different refusals — but the option row and the card locator are one shape, kept here
// so the two detectors cannot drift apart.
export const GUTTER_OPTION = /^\s*┃\s+([1-9])\s+\(([●○])\)\s+(.+?)\s*$/;

// Rows allowed between the card's bottom `┃` row and its footer: blanks only, and few. Every
// 2026-08-21 capture shows exactly one; the slack covers a torn repaint. Anything non-blank in
// the gap means the footer belongs to something else — refuse rather than pair the footer with
// a card an unbounded distance above it.
const MAX_FOOTER_GAP = 3;

/**
 * The contiguous `┃` run whose bottom sits just above the footer row at `footer`, or null when
 * the gap holds anything but a few blank rows. `start`..`end` are inclusive indices into
 * `texts`; every row in the range contains the `┃` gutter.
 */
export function gutterCardRange(
  texts: string[],
  footer: number,
): { start: number; end: number } | null {
  let end = footer - 1;
  let gap = 0;
  while (end >= 0 && isBlank(texts[end]!)) {
    end--;
    if (++gap > MAX_FOOTER_GAP) return null;
  }
  if (end < 0 || !texts[end]!.includes("┃")) return null;
  let start = end;
  while (start > 0 && texts[start - 1]!.includes("┃")) start--;
  return { start, end };
}

/** Join rstripped line text over `[from, to)` — the dialog signature the race guard compares. */
export function regionSignature(lines: StyledLine[], from: number, to: number): string {
  return lines
    .slice(from, to)
    .map((l) => rstrip(lineText(l)))
    .join("\n");
}
