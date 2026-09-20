// Codex's chrome is boxless: a `› ` prompt row (wrapping onto two-space-indented continuation
// rows) with the dot-separated status row beneath, sitting at the buffer tail. The dialogs
// (trust / approval / ask) REPLACE that pair entirely — their own footer becomes the tail — so
// locating the composer is also the composer-vs-modal discriminator. Pure; no pane access.
//
// THE COMPOSER IS FOUND BY ITS OWN MARKS, NOT BY COUNTING THE ROWS BETWEEN THEM (the rule ADR 0048
// set for Claude's box, applied here). The two marks are the status row as the last non-blank row,
// and the LOWEST column-0 `› ` row above it. A status row at the tail already proves a live
// composer, because every dialog replaces it. A submitted message echoes into the transcript with
// the same `› ` prefix, but an echo always sits ABOVE the live prompt, so the lowest one is the
// prompt. The walk used to refuse on the first blank or non-continuation row between the marks, and
// Astra's starfield (issue #245) paints exactly such rows: a refused composer refuses every send
// from the phone. Now a blank row, an indented row and a sparkle row all pass. One row refuses: a
// row with text at column 0 (or a second status row). Codex's own output (`• Ran …`, a rule) starts
// at column 0 and a draft or sparkle row never does, so this is what keeps the walk from reaching
// an echo if the live prompt row is ever missing. MAX_DRAFT_ROWS is a defence bound on how far the
// walk reaches, not the thing that decides whether the composer exists.

import { trimTrailingBlank, type StyledLine } from "../../blocks";
import {
  isBlank,
  isStatusRow,
  lastNonBlankIndex,
  lineText,
  isSparkle,
  PLACEHOLDER,
  promptText,
  rstrip,
  withoutSparkles,
} from "./markers";

export interface ComposerBox {
  /** First row of the composer band: the prompt row, or the starfield rows directly above it. */
  top: number;
  /** The `› ` prompt row. */
  promptRow: number;
  /** The status row under it (last non-blank row of the frame). */
  statusRow: number;
}

// A draft wraps onto indented continuation rows between the prompt row and the status row.
// Captured drafts show one; the bound is slack for longer phone-typed messages. 8 stranded a
// wrap (locateComposer returned null and the app reported a dialog). Same 100 as omp/Grok/
// Claude. A defence bound (see the header): a prompt row further up than this is not searched for,
// and locateComposer fails closed.
const MAX_DRAFT_ROWS = 100;

// A continuation row is the composer's TWO-SPACE GUTTER followed by the draft's own text — and
// that text may ITSELF begin with spaces. Type two spaces mid-sentence, or let a soft wrap land
// inside a run of them, and Codex paints a four-space-indented row that is a perfectly healthy
// continuation. The old `/^ {2}\S/` demanded a non-space at column 2, read that row as foreign,
// and made `locateComposer` return null — which refused EVERY send in the pane with "the input
// box isn't on screen — a menu or dialog is probably up" for as long as the draft sat there. That
// is a DEADLOCK, not a transient: the refusal is itself what keeps the draft from being sent, so
// the pane never recovers on its own. Only the gutter is asserted here, because only the gutter is
// the renderer's; what the walk actually bounds the run with is the blank row above it (`isBlank`,
// checked first in the same test), and Codex separates every section of a screen with one. A `› `
// or `• ` row still starts at column 0, so neither can pass as a continuation.
const CONTINUATION = /^ {2}\s*\S/;
const PROMPT_PREFIX = "› ";

/** The exact placeholder text is still a valid thing an operator might deliberately type. Codex
 * distinguishes its empty hint by painting the whole body dim, so extraction should use that
 * renderer evidence too instead of discarding an ordinary non-dim draft with those words. */
function isEmptyPlaceholder(line: StyledLine): boolean {
  const text = rstrip(lineText(line));
  if (promptText(text) !== PLACEHOLDER) return false;

  const bodyStart = PROMPT_PREFIX.length;
  const bodyEnd = bodyStart + PLACEHOLDER.length;
  let offset = 0;
  let sawBody = false;
  for (const segment of line.segments) {
    const next = offset + segment.text.length;
    if (Math.max(offset, bodyStart) < Math.min(next, bodyEnd)) {
      sawBody = true;
      if (segment.dim !== true) return false;
    }
    offset = next;
    if (offset >= bodyEnd) break;
  }
  return sawBody;
}

/** The composer at the buffer tail, or null (a dialog owns the screen, or the frame is torn). */
export function locateComposer(lines: StyledLine[]): ComposerBox | null {
  const clean = lines.map(withoutSparkles);
  const texts = clean.map((l) => rstrip(lineText(l)));
  const statusRow = lastNonBlankIndex(texts);
  if (statusRow < 0 || !isStatusRow(texts[statusRow]!, clean[statusRow])) return null;

  for (let i = statusRow - 1; i >= 0 && statusRow - 1 - i <= MAX_DRAFT_ROWS; i--) {
    const t = texts[i]!;
    if (promptText(t) !== null) return { top: bandTop(lines, texts, i), promptRow: i, statusRow };
    // Transcript at column 0, or a second status row: the walk has left this frame.
    if (/^\S/.test(t) || isStatusRow(t, clean[i])) return null;
  }
  return null;
}

/** The starfield rows directly above the prompt belong to the composer band, and leave the mirror
 *  with it. Only a row that holds sparkles and nothing else: such a row is never transcript. */
function bandTop(lines: StyledLine[], texts: string[], promptRow: number): number {
  let top = promptRow;
  while (
    top > 0 &&
    promptRow - top < MAX_DRAFT_ROWS &&
    isBlank(texts[top - 1]!) &&
    lines[top - 1]!.segments.some(isSparkle)
  ) {
    top--;
  }
  return top;
}

/**
 * Return `lines` with the composer (its band through the status row) removed from the tail.
 * Unchanged input is the SAME REFERENCE, so callers can treat `result === lines` as "no chrome".
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return lines;
  // Shared mirror padding owns the gap above the status strip, as in Claude.
  return trimTrailingBlank(lines.slice(0, box.top));
}

/** The status row, styled, for the strip above the phone composer. Empty when no composer. */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return [];
  return [withoutSparkles(lines[box.statusRow]!)];
}

/**
 * The user's draft stranded in the composer: the `› ` row's text plus wrapped continuation
 * rows, joined with single spaces (Codex word-wraps — verified against the typed original on
 * the draft-wrapped capture). The placeholder is not a draft. Null = no composer / empty.
 * Sparkles are painted over first, and a blank row between the prompt and the status row is skipped.
 *
 * Load-bearing: registering this adapter switches Codex panes from one-shot send to
 * type-then-verify, and THIS is the verify half.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  const clean = lines.map(withoutSparkles);
  const texts = clean.map((l) => rstrip(lineText(l)));
  const first = promptText(texts[box.promptRow]!) ?? "";
  const parts = [first.trim()];
  for (let i = box.promptRow + 1; i < box.statusRow; i++) {
    if (CONTINUATION.test(texts[i]!)) parts.push(texts[i]!.trim());
  }
  const draft = parts.filter((p) => p !== "").join(" ");
  if (draft === "" || (draft === PLACEHOLDER && isEmptyPlaceholder(clean[box.promptRow]!))) {
    return null;
  }
  return draft;
}

/** Typing reaches the composer only when the composer is on screen — every dialog replaces it. */
export function composerReady(lines: StyledLine[]): boolean {
  return locateComposer(lines) !== null;
}

/** The literal on-screen prompt/draft run a destructive write is bound to. Ending at the last draft
 * continuation keeps a wrapped message inside the bridge's bounded tail window; naming only the
 * first `›` row would permanently 409 once six or more non-blank wrap rows sat beneath it.
 * Null while the starfield is on those rows: the bridge compares the rows literally, and a
 * starfield repaints between the phone's read and the bridge's, so a bound sweep could never pass.
 * Null leaves the sweep unbound, which is the documented fallback (HarnessAdapter.composerPrompt). */
export function composerPrompt(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  for (let i = box.promptRow; i < box.statusRow; i++) {
    if (lines[i]!.segments.some(isSparkle)) return null;
  }
  let end = box.statusRow;
  while (end > box.promptRow + 1 && isBlank(lineText(lines[end - 1]!))) end--;
  return lines
    .slice(box.promptRow, end)
    .map((line) => rstrip(lineText(line)))
    .join("\n");
}
