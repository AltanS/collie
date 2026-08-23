// Chrome stripping for Grok Build. Trims Grok's own TUI composer off the TAIL of a parsed buffer so
// Collie's composer/statusline supersede it, and re-surfaces the two things the strip would otherwise
// destroy (the status painted into the bottom border, and a stranded draft).
//
// Grok vs omp vs Claude (do not reuse their scanners):
//
//   Claude                         omp                              Grok
//   ──────────────────────────     ────────────────────────────     ──────────────────────────────
//   ┌ top rule                     ╭── <statusline> ──╮             ╭────────────╮
//   │ ❯ <draft>                    │  <earlier draft> │             │ ❯ <draft>  │
//   └ bottom rule                  ╰─ <draft tail> ───╯             ╰── <status> ─╯
//     <statusline below>           ❯ palette below                  <blank>
//                                                                   Shift+Tab:mode │ Ctrl+.:shortcuts
//
// Conservative: the whole shape has to match at the tail or the buffer is returned untouched (same
// reference). Pure; no pane access, no network.

import type { AnsiSegment } from "../../ansi";
import type { StyledLine } from "../../blocks";
import {
  composerInnerText,
  composerPromptText,
  composerStatus,
  composerStatusSpan,
  isBlank,
  isComposerHint,
  isComposerTop,
  isStatusChipRow,
  lastNonBlankIndex,
  lineText,
  opensBox,
  rstrip,
} from "./markers";
import { detectAskRegion } from "./ask";
import { detectPermissionRegion } from "./permission";
import { detectPlanMenuRegion } from "./plan-menu";

/** True when Grok's plan-approval status is in the composer border, even if the footer changed. */
function planApprovalComposer(lines: StyledLine[]): boolean {
  const box = locateComposer(lines);
  if (box === null) return false;
  const status = composerStatus(rstrip(lineText(lines[box.bottom]!)));
  return status !== null && /plan approval/i.test(status);
}

// Rows Grok may paint BELOW the composer: a blank separator and the key-hint row. Bounded so a torn
// frame cannot claim an arbitrarily distant `╰─ status ─╯` and eat transcript. Being too LOW is the
// unsafe direction here (locateComposer returns null on an ordinary idle screen → duplicated box AND
// composerReady false). 8 is unreachable by the observed hint row (1–2 lines plus blanks).
const MAX_HINT_ROWS = 8;

// A long draft wraps onto continuation rows ABOVE the bottom border. Cap is defense-in-depth so a
// stray `│ … │` cannot pair with an unrelated `╭─╮` hundreds of lines up. Same number as omp/Claude.
const MAX_DRAFT_ROWS = 100;

/** The composer box located at the buffer's tail. Every index is into the ORIGINAL `lines` array. */
export interface ComposerBox {
  /** The TOP border row (`╭─…─╮`). */
  top: number;
  /** First inner row (`│ ❯ … │`). Equals `bottom` only if the box were empty of inners (it isn't). */
  firstDraftRow: number;
  /** The `╰─ … status ─╯` row. */
  bottom: number;
  /** EXCLUSIVE end of the hint run painted BELOW the box (`bottom + 1` when there is none). */
  hintEnd: number;
}

/**
 * Locate Grok's composer at the tail, or null. Bottom-up; every step can only REJECT.
 *
 *     ╭──────────────╮          (c) top border, directly above the inner run
 *     │ ❯ <draft…>   │          (b) 1..MAX_DRAFT_ROWS inner rows, first is the ❯ prompt
 *     ╰── <status> ─╯          (a) the bottom border — the anchor
 *                               (a) optional blank + hint rows, none of them a box
 */
/**
 * Grok paints background colour across every cell — full-width even on EMPTY rows — where the
 * other harnesses leave the terminal default. On the mirror (its own #0a0a0a ground, ADR 0002)
 * those painted empty rows render as just-visible bands: gray stripes. The fix is deliberately
 * inference-free: a row whose text is entirely blank loses its paint; a row with any glyph
 * keeps every background it painted. No colour is ever guessed — live frames paint MORE THAN
 * ONE base-coat colour on blank rows (rgb(20,20,20) and rgb(17,17,17) under groknight), so a
 * per-colour vote either misses a band or, worse, strips a semantic surface it mistook for
 * canvas (review repro). A glyph-bearing row can carry meaning in its background (the dialog
 * card's elevated surface, diff-line tints, selections) — those are untouchable; an empty
 * row's paint carries none the phone needs.
 */
export function stripCanvasBackground(lines: StyledLine[]): StyledLine[] {
  return lines.map((line) => {
    if (!isBlank(lineText(line))) return line;
    if (!line.segments.some((s) => s.style.backgroundColor !== undefined)) return line;
    return {
      ...line,
      segments: line.segments.map((s) => {
        if (s.style.backgroundColor === undefined) return s;
        const style = { ...s.style };
        delete style.backgroundColor;
        return { ...s, bg: undefined, style };
      }),
    };
  });
}

export function locateComposer(lines: StyledLine[]): ComposerBox | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const end = lastNonBlankIndex(texts);
  if (end < 0) return null;

  // (a) Bottom border, then the hint run under it. Grok puts a BLANK between the box and the hint,
  //     unlike omp, so blanks in this run are allowed. A box row in the run means something else
  //     owns the keyboard — decline rather than treat it as a hint.
  let bottom = -1;
  if (composerStatus(texts[end]!) !== null) {
    bottom = end;
  } else {
    for (let k = end - 1; k >= 0 && end - k < MAX_HINT_ROWS; k--) {
      if (composerStatus(texts[k]!) !== null) {
        bottom = k;
        break;
      }
    }
    if (bottom < 0) return null;
    for (let row = bottom + 1; row <= end; row++) {
      if (isBlank(texts[row]!)) continue;
      if (opensBox(texts[row]!)) return null;
      // Unknown nonblank rows under the box are later output, not hints. Treating them as a
      // hint run would keep a stale composer writable after the dialog has scrolled up. The
      // one non-hint row allowed is the startup screen's bare telemetry chip (`[stable]`).
      if (!isComposerHint(texts[row]!) && !isStatusChipRow(texts[row]!)) return null;
    }
  }
  const hintEnd = end + 1;

  // (b) Inner rows, walking up from the bottom border.
  let i = bottom - 1;
  while (i >= 0 && bottom - i <= MAX_DRAFT_ROWS && composerInnerText(texts[i]!) !== null) {
    i--;
  }

  // (c) Top border directly above that run.
  if (i < 0 || !isComposerTop(texts[i]!)) return null;

  const firstDraftRow = i + 1;
  if (firstDraftRow >= bottom) return null;
  // The first inner row must be the ❯ prompt. Continuations (no ❯) may follow it, never precede it.
  if (composerPromptText(texts[firstDraftRow]!) === null) return null;

  return { top: i, firstDraftRow, bottom, hintEnd };
}

/**
 * Return `lines` with the composer box and its hint row removed from the tail. Unchanged input is
 * the SAME REFERENCE, so callers can treat `result === lines` as "no chrome".
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = lines.length;

  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.length === 0 ? lines : lines.slice(0, 0);

  const box = locateComposer(lines);
  if (box !== null) {
    end = box.top;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * Slice `line.segments` to the `[start, end)` range of the JOINED (rstripped) line text, keeping
 * each surviving piece's original SGR. Indices come from `composerStatusSpan`, which classifies the
 * same rstripped string locateComposer already walked.
 */
function sliceStyledLine(line: StyledLine, start: number, end: number): StyledLine {
  const out: AnsiSegment[] = [];
  let i = 0;
  for (const seg of line.segments) {
    const segStart = i;
    const segEnd = i + seg.text.length;
    i = segEnd;
    if (segEnd <= start || segStart >= end) continue;
    const from = Math.max(0, start - segStart);
    const to = Math.min(seg.text.length, end - segStart);
    const text = seg.text.slice(from, to);
    if (text.length === 0) continue;
    out.push({ ...seg, text });
  }
  return { segments: out };
}

/**
 * Grok's statusline — display name, optional effort, optional permission mode — painted INTO the
 * bottom border. stripChrome peels that border off the mirror, so this re-surfaces it as app chrome.
 *
 * Live `format:ansi` splits that row into three SGR runs (rule, status, rule). omp's
 * drop-whole-leading-segments trim cannot isolate the words: the status is in the MIDDLE run, and a
 * single-segment synthetic fixture hid that. The span is taken from the JOINED line (what the
 * predicates already see), then sliced back onto the original segments so the status keeps the
 * colour Grok painted — the adapter contract says status rows stay styled.
 */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return [];
  lines = stripCanvasBackground(lines);
  const row = lines[box.bottom]!;
  const span = composerStatusSpan(lineText(row));
  if (span === null) return [];
  const sliced = sliceStyledLine(row, span.start, span.end);
  return sliced.segments.length === 0 ? [] : [sliced];
}

/**
 * The user's draft stranded in the composer. Grok writes it on the `│ ❯ … │` row and wraps onto
 * indented continuation rows below. Fragments join with a single space (soft wrap). Empty box → null.
 *
 * Load-bearing: registering this adapter switches Grok panes from one-shot send to type-then-verify,
 * and THIS is the verify half. Plan-approval's `Build anything` placeholder is not listed here —
 * that screen is excluded by detectPlanMenuRegion, so a real message of the same words can still
 * verify.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  if (detectPlanMenuRegion(lines) !== null || planApprovalComposer(lines)) return null;
  if (detectAskRegion(lines) !== null) return null;
  if (detectPermissionRegion(lines) !== null) return null;
  const box = locateComposer(lines);
  if (box === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));

  const parts: string[] = [];
  const prompt = composerPromptText(texts[box.firstDraftRow]!);
  if (prompt === null) return null;
  parts.push(prompt.trim());
  for (let i = box.firstDraftRow + 1; i < box.bottom; i++) {
    parts.push(composerInnerText(texts[i]!)!.trim());
  }

  const draft = parts.filter((p) => p.length > 0).join(" ");
  return draft.length === 0 ? null : draft;
}

/** Whether Grok's free-text composer is on screen at the tail. */
export function hasComposer(lines: StyledLine[]): boolean {
  return locateComposer(lines) !== null;
}

// Square user-message bubbles (`┌ … └`) sit above the composer on ordinary done screens. They are
// transcript, not a widget that owns the keyboard. Permission cards replace the composer (no box);
// plan approval leaves a box under a named-key footer — those are claimed by the detectors below.
// A rounded widget immediately above the composer is the residual fail-closed for anything we have
// not captured yet.
const USER_BUBBLE_EDGE = /^\s*[┌└]/;

/**
 * Whether a phone reply would reach Grok's composer rather than a widget sitting on top of it.
 *
 * hasComposer is the weaker claim (the box is at the tail). This is the reply-path pre-flight:
 * a definite `true` authorises the destructive pre-clear sweep, so a card that still leaves the
 * box visible has to fail closed. Without a live card capture we cannot parse the card; we CAN
 * refuse when the first non-blank row above the box is some other rounded widget. A hint-only
 * footer between card and composer is the residual this will miss until a capture exists.
 */
export function composerReady(lines: StyledLine[]): boolean {
  if (detectPermissionRegion(lines) !== null) return false;
  if (detectAskRegion(lines) !== null) return false;
  if (detectPlanMenuRegion(lines) !== null || planApprovalComposer(lines)) return false;
  const box = locateComposer(lines);
  if (box === null) return false;
  const texts = lines.map((l) => rstrip(lineText(l)));
  for (let i = box.top - 1; i >= 0; i--) {
    const t = texts[i]!;
    if (isBlank(t)) continue;
    if (USER_BUBBLE_EDGE.test(t)) return true;
    if (opensBox(t)) return false;
    return true;
  }
  return true;
}

const BRIDGE_PROMPT_TAIL_LINES = 6;

/**
 * The composer's prompt row, verbatim (trailing pad dropped), bound as
 * `expected_prompt` for the pre-clear sweep. Null when there is no composer, or when too much sits
 * below the box for the bridge's tail window to see it.
 */
export function composerPrompt(lines: StyledLine[]): string | null {
  // Same screens composerReady answers false about: a named region here would bind a destructive
  // sweep to a composer that does not own the keyboard (plan approval paints one under the preview).
  if (!composerReady(lines)) return null;
  const box = locateComposer(lines);
  if (box === null) return null;

  const texts = lines.map((l) => rstrip(lineText(l)));
  let nonBlankBelow = 0;
  for (let row = box.firstDraftRow + 1; row < box.hintEnd; row++) {
    if (!isBlank(texts[row]!)) nonBlankBelow++;
  }
  if (nonBlankBelow > BRIDGE_PROMPT_TAIL_LINES - 1) return null;

  const row = rstrip(lineText(lines[box.firstDraftRow]!));
  return row.length === 0 ? null : row;
}
