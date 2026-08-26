// Codex's chrome is boxless: a `› ` prompt row (wrapping onto two-space-indented continuation
// rows) with the dot-separated status row directly beneath, sitting at the buffer tail. The
// dialogs (trust / approval / ask) REPLACE that pair entirely — their own footer becomes the
// tail — so locating the composer is also the composer-vs-modal discriminator. A submitted
// message echoes into the transcript with the same `› ` prefix, which is why the walk anchors
// on the STATUS row at the tail and only then looks up for the prompt row: an echo higher in
// the transcript never has the status row directly beneath it. Pure; no pane access.

import type { StyledLine } from "../../blocks";
import {
  isBlank,
  isStatusRow,
  lastNonBlankIndex,
  lineText,
  PLACEHOLDER,
  promptText,
  rstrip,
  isQueueHintRow,
  skipBlanksUp,
} from "./markers";

export interface ComposerBox {
  /** The `› ` prompt row. */
  promptRow: number;
  /** The status row under it (last non-blank row of the frame). */
  statusRow: number;
}

// A draft wraps onto indented continuation rows between the prompt row and the status row.
// Captured drafts show one; the bound is slack for longer phone-typed messages. 8 stranded a
// wrap (locateComposer returned null and the app reported a dialog). Same 100 as omp/Grok/
// Claude. A run deeper than this is not a composer (fail closed — locateComposer returns null).
const MAX_DRAFT_ROWS = 100;

// While a task runs, Codex lets the composer occupy several blank visual rows and replaces the
// normal status summary with `tab to queue message …` at the bottom. Official TUI snapshots use six
// blank rows for the ordinary height. Keep a little repaint/viewport slack, still far below the
// draft-row bound and only on the exact fixed queue-footer path.
const MAX_QUEUE_HINT_GAP = 12;

// Continuation rows are exactly two-space-indented text. Deeper indents belong to dialogs and
// transcript blocks; a `› ` or `• ` row is never a continuation.
const CONTINUATION = /^ {2}\S/;
const PROMPT_PREFIX = "› ";

/** The exact placeholder text is still a valid thing an operator might deliberately type. Codex
 * distinguishes its empty hint by painting the whole body dim, so presentation/extraction should
 * use that renderer evidence too instead of discarding an ordinary non-dim draft with those words. */
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

/** Codex's native composer is three rows tall in the captured renderer: one background-painted
 * blank above the prompt, the prompt itself, and one or more layout rows below it. The parser is
 * intentionally anchored at the prompt, so presentation separately claims that one upper row only
 * when it is blank and carries the exact same background as the prompt. A plain transcript separator
 * stays outside the composer. */
function presentationStart(lines: StyledLine[], box: ComposerBox): number {
  if (box.promptRow === 0) return box.promptRow;
  const above = lines[box.promptRow - 1]!;
  if (!isBlank(lineText(above))) return box.promptRow;
  const background = above.segments.find(
    (segment) => segment.style.backgroundColor !== undefined,
  )?.style.backgroundColor;
  if (background === undefined) return box.promptRow;
  return lines[box.promptRow]!.segments.some(
    (segment) => segment.style.backgroundColor === background,
  )
    ? box.promptRow - 1
    : box.promptRow;
}

/** The composer at the buffer tail, or null (a dialog owns the screen, or the frame is torn). */
export function locateComposer(lines: StyledLine[]): ComposerBox | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const statusRow = lastNonBlankIndex(texts);
  if (statusRow < 0 || !isStatusRow(texts[statusRow]!, lines[statusRow])) return null;

  // One blank row separates the prompt/draft run from the status row (every capture); above the
  // gap the run is CONTIGUOUS non-blank rows — wrapped-draft continuations under the `› ` prompt.
  const top = skipBlanksUp(
    texts,
    statusRow - 1,
    isQueueHintRow(texts[statusRow]!) ? MAX_QUEUE_HINT_GAP : undefined,
  );
  if (top < 0) return null;
  for (let i = top; i >= 0 && top - i < MAX_DRAFT_ROWS; i--) {
    const t = texts[i]!;
    if (promptText(t) !== null) return { promptRow: i, statusRow };
    // A blank or foreign-shaped row inside the run means this status row is not under a composer.
    if (isBlank(t) || !CONTINUATION.test(t) || isStatusRow(t, lines[i])) return null;
  }
  return null;
}

/**
 * Return `lines` with the composer (prompt row through status row) removed from the tail.
 * Unchanged input is the SAME REFERENCE, so callers can treat `result === lines` as "no chrome".
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return lines;
  return lines.slice(0, box.promptRow);
}

/**
 * Presentation policy, deliberately separate from composer detection and reply authorization:
 * hide an empty native composer (Collie's own input replaces it), but keep a non-empty prompt/draft
 * visible for diagnosis. Dialogs have no located composer and remain byte-for-byte raw.
 */
export function presentChrome(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return lines;
  return extractInputDraft(lines) === null
    ? lines.slice(0, presentationStart(lines, box))
    : lines.slice(0, box.statusRow);
}

/** The status row, styled, for the strip above the phone composer. Empty when no composer. */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const box = locateComposer(lines);
  if (box === null) return [];
  return [lines[box.statusRow]!];
}

/**
 * The user's draft stranded in the composer: the `› ` row's text plus wrapped continuation
 * rows, joined with single spaces (Codex word-wraps — verified against the typed original on
 * the draft-wrapped capture). The placeholder is not a draft. Null = no composer / empty.
 *
 * Load-bearing: registering this adapter switches Codex panes from one-shot send to
 * type-then-verify, and THIS is the verify half.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));
  const first = promptText(texts[box.promptRow]!) ?? "";
  const parts = [first.trim()];
  for (let i = box.promptRow + 1; i < box.statusRow; i++) {
    parts.push(texts[i]!.trim());
  }
  const draft = parts.filter((p) => p !== "").join(" ");
  if (draft === "" || (draft === PLACEHOLDER && isEmptyPlaceholder(lines[box.promptRow]!))) {
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
 * first `›` row would permanently 409 once six or more non-blank wrap rows sat beneath it. */
export function composerPrompt(lines: StyledLine[]): string | null {
  const box = locateComposer(lines);
  if (box === null) return null;
  let end = box.statusRow;
  while (end > box.promptRow + 1 && isBlank(lineText(lines[end - 1]!))) end--;
  return lines
    .slice(box.promptRow, end)
    .map((line) => rstrip(lineText(line)))
    .join("\n");
}
