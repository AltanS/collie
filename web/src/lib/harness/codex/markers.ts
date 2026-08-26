// Shared lexing helpers over the parsed `StyledLine[]` — the primitives Codex's chrome stripping
// and dialog grammars lean on. Same methodology as harness/claude/markers.ts and
// harness/omp/markers.ts and deliberately NOT the same code: an adapter that imported another
// adapter's predicates would inherit that harness's renderer archaeology. Codex's chrome is
// BOXLESS: a bare `› ` prompt row wraps onto two-space-indented continuation rows, with a
// dot-separated status row underneath — and a SUBMITTED message echoes into the transcript with
// the same `› ` prefix, so nothing here is decisive without the tail anchoring locateComposer
// does. They operate on the *parsed* line text (segment text joined), never raw ANSI bytes.
// Pure functions, no I/O, no React.

import { isBlank, lineText, type StyledLine } from "../../blocks";
import type { AnsiSegment } from "../../ansi";

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar, so they live in the
// neutral core (lib/blocks.ts). Re-exported here so the Codex grammars keep their single import
// site — the same arrangement the other adapters use, for the same reason.
export { isBlank, lineText };

/** Drop TRAILING whitespace only. Codex pads rows to the pane width; an anchored `…$` regex
 *  would never match without this. Leading whitespace is load-bearing (it distinguishes the
 *  selected `› 1.` option row from the unselected `  2.` one), so it stays. */
export function rstrip(text: string): string {
  return text.replace(/\s+$/, "");
}

// The status row under the composer: `  <model> · <cwd> · Context N% left[ · weekly N% left]`.
// Everything before the Context token is OPAQUE — model names and directories change per
// session and per release, and this file must never match them. What IS the grammar: the
// two-space indent, at least two ` · `-separated fields before the token, and the token itself
// (`left`, with `used` accepted — both spellings ship in the v0.149.0 binary). Requiring the
// leading fields keeps a transcript line that merely mentions a context percentage from
// claiming the row (review repro: `model · Context 50% left` at column 0 must not match).
//
// Codex's status line is operator-configurable (`tui.status_line`, including `null`). The default
// signature remains the strongest fast path. A configured row cannot be keyed on field NAMES,
// though: every field is optional and an ordinary valid row may omit `Context` entirely. Its stable
// renderer grammar is the two-space indent plus bounded, non-empty ` · `-separated fields. This is
// only one link in locateComposer's evidence chain — the row must still be the buffer tail beneath
// a bounded column-zero `›` prompt/draft run. A disabled line deliberately remains unsupported: a
// lone transcript echo and a live empty composer would otherwise be indistinguishable.
const STATUS_ROW = /^ {2}\S.* · .* · .*Context \d+% (left|used)\b/;

const CUSTOM_STATUS_MIN_FIELDS = 3;
const CUSTOM_STATUS_MAX_FIELDS = 12;
const CUSTOM_STATUS_MAX_FIELD_CHARS = 160;
const CUSTOM_STATUS_MAX_CHARS = 512;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const QUEUE_HINT = /^ {2}tab to queue(?: message)?(?: · [^·\r\n]{1,160})?(?: {2,}\d+% context left)?$/;

function codePointLength(value: string): number {
  return [...value].length;
}

function isCustomStatusRow(text: string): boolean {
  const row = rstrip(text);
  if (
    !row.startsWith("  ") ||
    row.startsWith("   ") ||
    CONTROL.test(row) ||
    codePointLength(row) > CUSTOM_STATUS_MAX_CHARS
  ) {
    return false;
  }

  const fields = row.slice(2).split(" · ");
  if (fields.length < CUSTOM_STATUS_MIN_FIELDS || fields.length > CUSTOM_STATUS_MAX_FIELDS) {
    return false;
  }
  return fields.every(
    (field) =>
      field.length > 0 &&
      field === field.trim() &&
      codePointLength(field) <= CUSTOM_STATUS_MAX_FIELD_CHARS,
  );
}

function hasNoStyle(segment: AnsiSegment, exceptDim = false): boolean {
  return (
    segment.fg === undefined &&
    segment.bg === undefined &&
    segment.bold !== true &&
    (exceptDim || segment.dim !== true) &&
    segment.italic !== true &&
    segment.underline !== true &&
    segment.strike !== true
  );
}

function isStyledStatusField(segment: AnsiSegment, allowTrailingPadding = false): boolean {
  const value = allowTrailingPadding ? rstrip(segment.text) : segment.text;
  return (
    segment.fg !== undefined &&
    segment.bg === undefined &&
    segment.bold !== true &&
    segment.dim !== true &&
    segment.italic !== true &&
    segment.underline !== true &&
    segment.strike !== true &&
    value.length > 0 &&
    value === value.trim() &&
    codePointLength(value) <= CUSTOM_STATUS_MAX_FIELD_CHARS
  );
}

/**
 * The compact two-field renderer observed on older/custom Codex builds. Text alone is insufficient:
 * `  model · Context 50% left` is an existing transcript-lookalike repro. The real widget paints
 * four exact SGR segments: unstyled two-space indent, coloured field, dim separator, coloured field.
 */
function isStyledTwoFieldStatusRow(text: string, line: StyledLine | undefined): boolean {
  const row = rstrip(text);
  if (
    line === undefined ||
    line.segments.length !== 4 ||
    CONTROL.test(row) ||
    codePointLength(row) > CUSTOM_STATUS_MAX_CHARS
  ) {
    return false;
  }
  const [indent, first, separator, second] = line.segments;
  return (
    indent!.text === "  " &&
    hasNoStyle(indent!) &&
    isStyledStatusField(first!) &&
    separator!.text === " · " &&
    separator!.dim === true &&
    hasNoStyle(separator!, true) &&
    isStyledStatusField(second!, true) &&
    rstrip(lineText(line)) === row
  );
}

/** Codex replaces its normal status summary with this fixed running-composer footer while a draft
 *  can be queued. The prefix is official TUI chrome, not a user status field; ask/question footers
 *  use different wording (`tab to add notes`, `enter to submit…`) and remain dialogs. */
export function isQueueHintRow(text: string): boolean {
  const row = rstrip(text);
  return !CONTROL.test(row) && codePointLength(row) <= CUSTOM_STATUS_MAX_CHARS && QUEUE_HINT.test(row);
}

/** True when the row could be the composer's status line. Never decisive alone — the composer
 *  is located by the prompt-row-above-status shape at the buffer tail, not by any single row. */
export function isStatusRow(text: string, line?: StyledLine): boolean {
  const row = rstrip(text);
  return (
    STATUS_ROW.test(row) ||
    isCustomStatusRow(row) ||
    isStyledTwoFieldStatusRow(row, line) ||
    isQueueHintRow(row)
  );
}

// The `› ` prompt row. Column 0 — but transcript ECHOES of submitted messages paint the same
// prefix, so callers must only trust this at the located composer position.
const PROMPT = /^› (.*)$/;

/** Body of a `› ` prompt-shaped row (rstripped), or null when the line is not one. */
export function promptText(text: string): string | null {
  const m = PROMPT.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

/** The empty composer's placeholder, captured verbatim; chrome also requires its dim renderer style. */
export const PLACEHOLDER = "Ask Codex to do anything";

/** Index of the last non-blank row in `texts`, or -1 when the buffer is all blank. */
export function lastNonBlankIndex(texts: string[]): number {
  let i = texts.length - 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  return i;
}

// Codex separates every section of a screen — prompt/status, options/footer, question/options —
// with exactly one blank row (every 2026-08-22 capture). The gap helpers accept up to two so a
// repaint wobble doesn't refuse a healthy frame; more means the rows aren't one widget.
const MAX_SECTION_GAP = 2;

/** The nearest non-blank row at or above `i`, or -1 when the blank gap exceeds the bound. */
export function skipBlanksUp(texts: string[], i: number, maxGap = MAX_SECTION_GAP): number {
  let gap = 0;
  while (i >= 0 && isBlank(texts[i]!)) {
    i--;
    if (++gap > maxGap) return -1;
  }
  return i;
}

/** Join rstripped line text over `[from, to)` — the dialog signature the race guard compares. */
export function regionSignature(lines: StyledLine[], from: number, to: number): string {
  return lines
    .slice(from, to)
    .map((l) => rstrip(lineText(l)))
    .join("\n");
}
