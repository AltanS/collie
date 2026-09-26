// Shared lexing helpers over the parsed `StyledLine[]` — the primitives Codex's chrome stripping
// and dialog grammars lean on. Same methodology as harness/claude/markers.ts and
// harness/omp/markers.ts and deliberately NOT the same code: an adapter that imported another
// adapter's predicates would inherit that harness's renderer archaeology. Codex's chrome is
// BOXLESS: a bare `› ` prompt row wraps onto two-space-indented continuation rows, with a
// dot-separated status row underneath — and a SUBMITTED message echoes into the transcript with
// the same `› ` prefix, so nothing here is decisive without the tail anchoring locateComposer
// does. They operate on the *parsed* line text (segment text joined), never raw ANSI bytes.
// Pure functions, no I/O, no React.

import type { AnsiSegment } from "../../ansi";
import { isBlank, lineText, type StyledLine } from "../../blocks";

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

// The status row under the composer. v0.149.0 put at least two fields before Context:
// `  <model> · <cwd> · Context N% left[ · weekly N% left]`. v0.150.1 moved Context directly
// after the model and put branch/change fields after it:
// `  <model> · Context N% left · <branch> · <changes> · weekly N% left`.
//
// Everything around the Context token is OPAQUE — model names, directories and branch names
// change per session and release. What IS the grammar: the two-space indent, the model field,
// the Context token (`left`, with `used` also accepted), plus either another field before Context
// (the old shape) or one after it (the new shape). Requiring that extra field keeps a minimal
// status-like prose row from claiming the composer; requiring the indent keeps a transcript line
// that merely mentions a context percentage from claiming it at column 0.
//
// KNOWN LIMIT — what the `Context` token can and cannot decide.
//
// The token is present only when the operator has `context-remaining` in `tui.status_line`.
// 0.149.0 shipped it in the default; 0.150.1 does NOT. Its default row is TWO fields —
// `  <model> · <cwd>` — so this regex alone leaves every plain 0.150.1 pane dark: no composer
// located, no draft, no status strip, replies refused. Hence the second acceptor below.
//
// STATUS_ROW stays as the fast path for rows that still carry `Context`, and it is the ONLY
// text-shaped acceptor. The styled acceptor keys on RENDERER PAINT — an unstyled two-space
// indent, coloured non-dim fields, and quiet ` · ` separators — and never on field names, because
// field names are exactly the part the operator configures. Current Codex may paint one final
// low-priority field together with its separator as a single quiet segment (` · Main [default]`);
// that suffix is accepted only after two ordinary coloured fields and only at the end. A text-only
// lookalike pasted or echoed into the transcript (`  model · Context 50% left` typed by hand, or
// prose that happens to contain ` · `) carries no SGR at all, so it is still refused.
//
// "Quiet" has two renderers. Up to 0.154.0 a separator was SGR 2 (dim) with no colour. 0.156.1
// drops SGR 2 and paints the separator with the theme's muted foreground instead
// (`38;2;135;140;164` on the capture host) — and its default row still has no Context field, so
// until the acceptor learned the second paint EVERY default 0.156.1 pane had no composer, and the
// unread-dialog card sat over a live input box (codex--v0156-idle.txt). The colour is never
// matched by value, because it belongs to the theme. The row test asks instead that every
// separator on the row carry one and the same paint, and that no field carry it. 0.156.1 also
// right-aligns a notice on the row when it has one (`⚠ 1 warning · f2 to view`); that is accepted
// only after a gap and a left half that is already a whole status row (`isRightNotice`).
//
// Why a dialog cannot pass: every 0.156.1 dialog footer (`enter continue · esc quit`, `enter select
// · esc back`, `Press enter to confirm or esc to cancel`) paints its key names BOLD, and its glue
// text SGR 2 in the SAME segment as the ` · `, so neither a field nor a separator can be read off
// it. The update prompt's heading row sits on a background fill. codex.test.ts pins composerReady
// false on every 0.156.1 dialog capture, and the tail shape still has to hold on top: this row
// last, a column-0 `› ` row above, and nothing at column 0 in between.
//
// Still unsupported: a DISABLED status line (`tui.status_line = null`). There is then no row
// under the prompt to anchor on, and the rows that remain are transcript. Anchoring the composer
// on the `› ` prompt alone is not available — Codex ECHOES submitted messages into the
// transcript with the same prefix, so a prompt-only anchor would bind to an echo and reply into
// the wrong place. Such a pane falls back to the raw mirror with replies refused: safe, and dark.
const STATUS_ROW =
  /^ {2}\S.* · (?:(?:.* · )+Context \d+% (?:left|used)\b|Context \d+% (?:left|used)\b · \S)/;

// Codex can render the queue hint and context metric on one raw footer row while a turn is active.
// The key is configurable; the queue wording and context metric are the stable parts.
const INLINE_QUEUE_CONTEXT_ROW =
  /^ {2}\S.*\bto queue(?: message)?\s+\d+% context (?:left|used)\b/;

/** The exact separator paint Codex renders between status fields. */
const STATUS_SEPARATOR = " \u00b7 ";
/** Bounds. A status field is a model name, a path or a branch — never a paragraph. */
const MAX_STATUS_FIELD_CHARS = 160;
const MAX_STATUS_ROW_CHARS = 512;
const MIN_STATUS_FIELDS = 2;
const MAX_STATUS_FIELDS = 12;
const STATUS_INDENT = "  ";

function codePointCount(text: string): number {
  return [...text].length;
}

/**
 * A C0/DEL byte anywhere in the row. Scanned by code unit rather than matched by a pattern, the way
 * links.ts cuts the same bytes out of an href. Tab is not one of them: Codex indents with it, and a
 * row that carries one is still an ordinary row.
 */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A coloured, unemphasised field segment: the paint Codex gives every status field. */
function isFieldSegment(segment: AnsiSegment): boolean {
  if (segment.fg === undefined || segment.bg !== undefined) return false;
  if (segment.bold === true || segment.dim === true) return false;
  if (segment.text.length === 0 || segment.text !== segment.text.trim()) return false;
  return codePointCount(segment.text) <= MAX_STATUS_FIELD_CHARS;
}

/**
 * The QUIET paint Codex gives a status separator, as a comparable key, or null when the segment is
 * not painted that way. Two renderers are known:
 *
 *   - `"dim"` — SGR 2 with no colour of its own (0.150.1 to 0.154.0).
 *   - `"fg:<colour>"` — no SGR 2, an explicit foreground instead (0.156.1 paints ` · ` as
 *     `38;2;135;140;164`). The colour is the THEME's muted tone, so it is never matched by value:
 *     a theme change would silently darken every pane. What the row test asks of it instead is
 *     that every separator on the row carries the SAME paint, and that no field shares it
 *     (`isStyledStatusRow`), i.e. the separators are painted apart from the fields they divide.
 *
 * Bold, underline, italic and a background are never separator paint: a dialog footer's key names
 * are bold, and the 0.156.1 dialogs that sit on a fill (the update prompt) carry a background.
 */
function separatorPaint(segment: AnsiSegment): string | null {
  if (segment.bg !== undefined || segment.bold === true) return null;
  if (segment.italic === true || segment.underline === true) return null;
  if (segment.dim === true) return segment.fg === undefined ? "dim" : null;
  return segment.fg === undefined ? null : `fg:${segment.fg}`;
}

/** A ` \u00b7 ` separator segment, painted quietly and nothing else. Its paint key, or null. */
function separatorSegmentPaint(segment: AnsiSegment): string | null {
  return segment.text === STATUS_SEPARATOR ? separatorPaint(segment) : null;
}

/** One final low-priority field that Codex paints in the same quiet segment as its separator.
 *  Its paint key, or null. */
function quietSuffixFieldPaint(segment: AnsiSegment): string | null {
  if (!segment.text.startsWith(STATUS_SEPARATOR)) return null;
  const field = segment.text.slice(STATUS_SEPARATOR.length);
  if (field.length === 0 || field !== field.trim()) return null;
  if (hasControlChar(field) || codePointCount(field) > MAX_STATUS_FIELD_CHARS) return null;
  return separatorPaint(segment);
}

/** The unstyled two-space indent Codex opens the row with. */
function isIndentSegment(segment: AnsiSegment): boolean {
  if (segment.text !== STATUS_INDENT) return false;
  return isUnstyled(segment);
}

function isUnstyled(segment: AnsiSegment): boolean {
  if (segment.fg !== undefined || segment.bg !== undefined) return false;
  return (
    segment.bold !== true &&
    segment.dim !== true &&
    segment.italic !== true &&
    segment.underline !== true
  );
}

/** The unstyled run of spaces that pushes a right-aligned notice to the row's far edge. */
function isGapSegment(segment: AnsiSegment): boolean {
  return /^ {2,}$/.test(segment.text) && isUnstyled(segment);
}

// 0.156.1 right-aligns a notice on the status row when it has one — seen as `⚠ 1 warning · f2 to
// view` (codex--v0156-draft-multiline.txt). Its paint is mixed (a bold key, quiet glue text), so
// its segments are not read as fields. It is bounded instead: short, every segment painted (a
// foreground or SGR 2, never plain text, which is what an echo or prose looks like), and no
// background. It is only ever accepted after a gap AND a left half that is already a complete
// status row on its own, so it adds no way in for a row that was refused without it.
const MAX_NOTICE_SEGMENTS = 12;

function isRightNotice(segments: AnsiSegment[]): boolean {
  if (segments.length === 0 || segments.length > MAX_NOTICE_SEGMENTS) return false;
  if (segments[0]!.text.trimStart() !== segments[0]!.text) return false;
  let chars = 0;
  for (const segment of segments) {
    if (segment.bg !== undefined) return false;
    if (segment.fg === undefined && segment.dim !== true) return false;
    if (isGapSegment(segment)) return false;
    chars += codePointCount(segment.text);
  }
  return chars <= MAX_STATUS_FIELD_CHARS;
}

/** Trailing renderer padding is FOLDED, not matched: whitespace-only tail segments are dropped
 *  and the last surviving segment is rstripped, the same normalisation `rstrip` does to text.
 *  Returns null when nothing survives. */
function foldTrailingPadding(segments: AnsiSegment[]): AnsiSegment[] | null {
  let end = segments.length;
  while (end > 0 && segments[end - 1]!.text.trim() === "") end--;
  if (end === 0) return null;
  const last = segments[end - 1]!;
  const folded = segments.slice(0, end);
  folded[end - 1] = { ...last, text: rstrip(last.text) };
  return folded;
}

/**
 * The default status row, recognised by its PAINT. All of these must hold, or the row is refused:
 * the styled line must be the same row as `text`; the segments must read as an unstyled two-space
 * indent then `field (sep field)*`, optionally ending with one combined quiet `sep + field` segment
 * after two ordinary fields, or with a gap and a right-aligned notice after two ordinary fields;
 * every separator must carry ONE quiet paint, which no field may share; and the field count must
 * stay in bounds. Prose that happens to contain ` \u00b7 ` fails on the paint, which is the whole
 * point of the guard.
 */
function isStyledStatusRow(text: string, line: StyledLine): boolean {
  const rowText = rstrip(text);
  if (rstrip(lineText(line)) !== rowText) return false;
  if (hasControlChar(rowText)) return false;
  if (codePointCount(rowText) > MAX_STATUS_ROW_CHARS) return false;

  const segments = foldTrailingPadding(line.segments);
  if (segments === null) return false;
  if (!isIndentSegment(segments[0]!)) return false;

  let fields = 0;
  // The one quiet paint every separator on this row carries; set by the first separator.
  let paint: string | null = null;
  const fieldColours = new Set<string>();

  let i = 1;
  while (i < segments.length) {
    const field = segments[i]!;
    if (!isFieldSegment(field)) return false;
    fieldColours.add(field.fg!);
    fields++;
    i++;
    if (i === segments.length) break;

    const next = segments[i]!;
    if (isGapSegment(next)) {
      if (fields < MIN_STATUS_FIELDS || !isRightNotice(segments.slice(i + 1))) return false;
      break;
    }
    const suffix = quietSuffixFieldPaint(next);
    const nextPaint = suffix ?? separatorSegmentPaint(next);
    if (nextPaint === null || (paint !== null && nextPaint !== paint)) return false;
    paint = nextPaint;
    if (suffix !== null) {
      if (fields < MIN_STATUS_FIELDS || i !== segments.length - 1) return false;
      fields++;
      break;
    }
    if (i === segments.length - 1) return false;
    i++;
  }
  if (fields < MIN_STATUS_FIELDS || fields > MAX_STATUS_FIELDS) return false;
  // A separator painted in a field's own colour is not a separator set apart from its fields.
  return paint === null || !paint.startsWith("fg:") || !fieldColours.has(paint.slice(3));
}

/** True when the row could be the composer's status line. Never decisive alone — the composer
 *  is located by the prompt-row-above-status shape at the buffer tail, not by any single row.
 *  `line` is the same row, styled; without it only the `Context`-bearing shape can be accepted. */
export function isStatusRow(text: string, line?: StyledLine): boolean {
  const row = rstrip(text);
  if (STATUS_ROW.test(row) || INLINE_QUEUE_CONTEXT_ROW.test(row)) return true;
  return line !== undefined && isStyledStatusRow(text, line);
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
export function skipBlanksUp(texts: string[], i: number): number {
  let gap = 0;
  while (i >= 0 && isBlank(texts[i]!)) {
    i--;
    if (++gap > MAX_SECTION_GAP) return -1;
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

// Codex's Astra models paint a starfield over the composer band: braille glyphs (U+2800 to U+28FF)
// scattered across the row above the prompt, the prompt row after the draft, and the rows under it,
// repainted every frame (issue #245, and codex--v0154-submitted-fill.txt, captured on gpt-6-astra).
// Each sparkle is ONE glyph in its own segment with its own grey foreground. A typed draft is painted
// in the default foreground, so the colour is what tells a sparkle from a braille character someone
// typed, the same renderer-evidence rule isEmptyPlaceholder uses in chrome.ts.
const BRAILLE = /^[⠀-⣿]$/u;

/** One starfield sparkle: a single braille glyph carrying its own foreground colour. */
export function isSparkle(segment: AnsiSegment): boolean {
  return segment.fg !== undefined && BRAILLE.test(segment.text);
}

/** The line with every sparkle painted over by a space. Columns are kept, so the prompt prefix and
 *  the continuation gutter still sit where the grammar looks for them. The SAME reference when the
 *  line has no sparkle. */
export function withoutSparkles(line: StyledLine): StyledLine {
  if (!line.segments.some(isSparkle)) return line;
  return {
    ...line,
    segments: line.segments.map((s) => (isSparkle(s) ? { ...s, text: " ", fg: undefined } : s)),
  };
}
