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
// KNOWN LIMIT: Codex's status line is operator-configurable (`tui.status_line`, including
// `null` to disable it). A custom or disabled status line never matches, so the composer is
// never located and the pane falls back to the raw mirror with replies refused — safe, but
// this adapter's lift only engages on the DEFAULT status line.
const STATUS_ROW =
  /^ {2}\S.* · (?:(?:.* · )+Context \d+% (?:left|used)\b|Context \d+% (?:left|used)\b · \S)/;

/** True when the row could be the composer's status line. Never decisive alone — the composer
 *  is located by the prompt-row-above-status shape at the buffer tail, not by any single row. */
export function isStatusRow(text: string): boolean {
  return STATUS_ROW.test(rstrip(text));
}

// The `› ` prompt row. Column 0 — but transcript ECHOES of submitted messages paint the same
// prefix, so callers must only trust this at the located composer position.
const PROMPT = /^› (.*)$/;

/** Body of a `› ` prompt-shaped row (rstripped), or null when the line is not one. */
export function promptText(text: string): string | null {
  const m = PROMPT.exec(rstrip(text));
  return m === null ? null : m[1]!;
}

/** The empty composer's placeholder, captured verbatim; a draft equal to it is no draft. */
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
