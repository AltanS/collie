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
// indent, coloured non-dim fields, and dim ` · ` separators — and never on field names, because
// field names are exactly the part the operator configures. Current Codex may paint one final
// low-priority field together with its separator as a single dim segment (` · Main [default]`);
// that suffix is accepted only after two ordinary coloured fields and only at the end. A text-only
// lookalike pasted or echoed into the transcript (`  model · Context 50% left` typed by hand, or
// prose that happens to contain ` · `) carries no SGR at all, so it is still refused.
//
// Still unsupported: a DISABLED status line (`tui.status_line = null`). There is then no row
// under the prompt to anchor on, and the rows that remain are transcript. Anchoring the composer
// on the `› ` prompt alone is not available — Codex ECHOES submitted messages into the
// transcript with the same prefix, so a prompt-only anchor would bind to an echo and reply into
// the wrong place. Such a pane falls back to the raw mirror with replies refused: safe, and dark.
const STATUS_ROW =
  /^ {2}\S.* · (?:(?:.* · )+Context \d+% (?:left|used)\b|Context \d+% (?:left|used)\b · \S)/;

/** The exact separator paint Codex renders between status fields. */
const STATUS_SEPARATOR = " \u00b7 ";
/** Bounds. A status field is a model name, a path or a branch — never a paragraph. */
const MAX_STATUS_FIELD_CHARS = 160;
const MAX_STATUS_ROW_CHARS = 512;
const MIN_STATUS_FIELDS = 2;
const MAX_STATUS_FIELDS = 12;
const STATUS_INDENT = "  ";
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function codePointCount(text: string): number {
  return [...text].length;
}

/** A coloured, unemphasised field segment: the paint Codex gives every status field. */
function isFieldSegment(segment: AnsiSegment): boolean {
  if (segment.fg === undefined || segment.bg !== undefined) return false;
  if (segment.bold === true || segment.dim === true) return false;
  if (segment.text.length === 0 || segment.text !== segment.text.trim()) return false;
  return codePointCount(segment.text) <= MAX_STATUS_FIELD_CHARS;
}

/** A dim ` \u00b7 ` separator segment, painted exactly so and nothing else. */
function isSeparatorSegment(segment: AnsiSegment): boolean {
  if (segment.text !== STATUS_SEPARATOR) return false;
  if (segment.dim !== true) return false;
  return segment.fg === undefined && segment.bg === undefined && segment.bold !== true;
}

/** One final low-priority field that Codex paints in the same dim segment as its separator. */
function isDimSuffixFieldSegment(segment: AnsiSegment): boolean {
  if (!segment.text.startsWith(STATUS_SEPARATOR)) return false;
  const field = segment.text.slice(STATUS_SEPARATOR.length);
  if (field.length === 0 || field !== field.trim()) return false;
  if (CONTROL_CHARS.test(field) || codePointCount(field) > MAX_STATUS_FIELD_CHARS) return false;
  if (segment.dim !== true) return false;
  return segment.fg === undefined && segment.bg === undefined && segment.bold !== true;
}

/** The unstyled two-space indent Codex opens the row with. */
function isIndentSegment(segment: AnsiSegment): boolean {
  if (segment.text !== STATUS_INDENT) return false;
  if (segment.fg !== undefined || segment.bg !== undefined) return false;
  return (
    segment.bold !== true &&
    segment.dim !== true &&
    segment.italic !== true &&
    segment.underline !== true
  );
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
 * The 0.150.1 default status row, recognised by its PAINT. All of these must hold, or the row is
 * refused: the styled line must be the same row as `text`; the segments must read as an unstyled
 * two-space indent then `field (sep field)*`, optionally ending with one combined dim
 * `sep + field` segment after two ordinary fields; and the field count must stay in bounds. Prose
 * that happens to contain ` \u00b7 ` fails on the paint, which is the whole point of the guard.
 */
function isStyledStatusRow(text: string, line: StyledLine): boolean {
  const rowText = rstrip(text);
  if (rstrip(lineText(line)) !== rowText) return false;
  if (CONTROL_CHARS.test(rowText)) return false;
  if (codePointCount(rowText) > MAX_STATUS_ROW_CHARS) return false;

  const segments = foldTrailingPadding(line.segments);
  if (segments === null) return false;
  if (!isIndentSegment(segments[0]!)) return false;

  let fields = 0;
  let i = 1;
  while (i < segments.length) {
    if (!isFieldSegment(segments[i]!)) return false;
    fields++;
    i++;
    if (i === segments.length) break;

    const separator = segments[i]!;
    if (isDimSuffixFieldSegment(separator)) {
      if (fields < MIN_STATUS_FIELDS || i !== segments.length - 1) return false;
      fields++;
      i++;
      break;
    }
    if (!isSeparatorSegment(separator) || i === segments.length - 1) return false;
    i++;
  }
  return fields >= MIN_STATUS_FIELDS && fields <= MAX_STATUS_FIELDS;
}

/** True when the row could be the composer's status line. Never decisive alone — the composer
 *  is located by the prompt-row-above-status shape at the buffer tail, not by any single row.
 *  `line` is the same row, styled; without it only the `Context`-bearing shape can be accepted. */
export function isStatusRow(text: string, line?: StyledLine): boolean {
  if (STATUS_ROW.test(rstrip(text))) return true;
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
