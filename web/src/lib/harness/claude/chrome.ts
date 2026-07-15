// Chrome stripping — trims the agent's own TUI chrome off the TAIL of a parsed buffer so the app's
// composer/statusline supersedes it instead of duplicating it. Today that's the Claude Code input
// box (the "❯ …" prompt line sandwiched between two rules) plus the statusline / hint lines below it
// and any trailing blank runs.
//
// Deliberately CONSERVATIVE: it strips only when the WHOLE input-box shape matches confidently at
// the tail, and never removes content above it — when unsure it returns the buffer untouched (the
// T1 raw-mirror fallback). Pure; operates on parsed line text, so a user-configured statusline is
// matched by POSITION (below the box's bottom border), never by its content strings.

import type { StyledLine } from "../../blocks";
import { isBlank, isBoxBorder, lineText } from "./markers";

// Lines allowed between the input box's bottom border and the tail: the statusline plus a hint line
// or two ("← for agents", "⏵⏵ bypass permissions on …"). More than this and we don't recognise the
// shape, so we leave the buffer raw.
const MAX_STATUS_LINES = 3;

// Text Claude draws on the "❯" prompt line that is NOT a real user draft — it's a hint the TUI paints
// when the box is otherwise empty. Must never be surfaced as a recoverable draft. Kept as an array so
// more variants can be added without touching the extraction logic.
const INPUT_PLACEHOLDERS = ["Press up to edit queued messages"];

/**
 * Return `lines` with any confidently-matched trailing chrome removed. When nothing matches the
 * input is returned as-is (same reference), so callers can treat an unchanged result as "no chrome".
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length; // exclusive bound of the kept range

  // 1. Drop a trailing run of blank lines.
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  // 2. Peel the input box off the tail if the full shape is present. Only then; otherwise the
  //    blank-trim above is the sole (safe) change.
  const box = locateInputBox(texts, end);
  if (box !== null) {
    end = box.top;
    // Drop the blank run now exposed above the box (a fresh session has an empty body above it).
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * The statusline the agent draws just under its input box — model, ctx%, cwd, branch, tokens,
 * whatever the user configured in their Claude Code statusline. We strip the box off the mirror
 * (stripChrome), so this re-surfaces that one line as app chrome above the composer instead of
 * losing it.
 *
 * POSITIONAL only: the first non-blank line strictly below the box's bottom border. Hint lines after
 * it ("← for agents", "⏵⏵ bypass permissions") are ignored — only the first counts. Returns the
 * trimmed text, or `null` when there's no input box at the tail (a menu is up, or a non-Claude / torn
 * buffer). Never interprets the content — the caller renders it verbatim.
 */
export function extractStatusLine(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;

  const box = locateInputBox(texts, end);
  if (box === null) return null;

  for (let j = box.bottomBorder + 1; j < end; j++) {
    const t = texts[j]!.trim();
    if (t.length > 0) return t;
  }
  return null;
}

/**
 * The user's draft text stranded on the input box's "❯" prompt line. When a message is queued while
 * the agent is busy and then recalled (Up/Esc), the text lands here and persists across turns — but
 * stripChrome peels the whole box off the mirror, so it becomes invisible, and the composer (local
 * state only) never learns of it. This re-surfaces it so the app can offer to recover it.
 *
 * Reads the prompt line found by locateInputBox: drop the leading "❯" marker and its separator space
 * (Claude renders a U+00A0 there, which JS trim() strips), then trim. Returns `null` when there's no
 * input box at the tail, the box is empty (bare "❯"), or the line is a known TUI placeholder
 * (INPUT_PLACEHOLDERS) rather than a real draft.
 *
 * Known limitation: a multi-line / wrapped draft doesn't match the single-"❯"-line box shape
 * locateInputBox requires, so the box is left UNstripped in the mirror (visible raw) — acceptable, as
 * the draft is at least not hidden in that case.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;

  const box = locateInputBox(texts, end);
  if (box === null) return null;

  let draft = texts[box.prompt]!.trimStart();
  if (draft.startsWith("❯")) draft = draft.slice(1);
  draft = draft.trim();
  if (draft.length === 0 || INPUT_PLACEHOLDERS.includes(draft)) return null;
  return draft;
}

interface InputBox {
  /** Index of the TOP border — the exclusive bound of everything ABOVE the box (stripChrome uses it). */
  top: number;
  /** Index of the "❯" prompt line, between the two borders — carries the draft (extractInputDraft). */
  prompt: number;
  /** Index of the BOTTOM border — the statusline, if any, is the first non-blank line after it. */
  bottomBorder: number;
}

/**
 * If the range ending at `end` (exclusive; `end-1` is the last non-blank line) ends in the Claude
 * input-box shape —
 *
 *     <top border>
 *     ❯ <draft>            (the prompt line)
 *     <bottom border>
 *     <statusline>         (0..MAX_STATUS_LINES lines, matched by position not content)
 *     <hint line>
 *
 * return the top and bottom border indices. Otherwise null. Scans bottom-up.
 */
function locateInputBox(texts: string[], end: number): InputBox | null {
  let i = end - 1;

  // (a) Up to MAX_STATUS_LINES status/hint lines above the bottom border: non-blank, non-border
  //     text. Stop as soon as a border is reached.
  let status = 0;
  while (i >= 0 && !isBoxBorder(texts[i]!) && !isBlank(texts[i]!) && status < MAX_STATUS_LINES) {
    status++;
    i--;
  }

  // (b) bottom border
  if (i < 0 || !isBoxBorder(texts[i]!)) return null;
  const bottomBorder = i;
  i--;

  // (c) the "❯" prompt line (allow blank padding on either side, defensively)
  while (i >= 0 && isBlank(texts[i]!)) i--;
  if (i < 0 || !texts[i]!.trimStart().startsWith("❯")) return null;
  const prompt = i;
  i--;
  while (i >= 0 && isBlank(texts[i]!)) i--;

  // (d) top border
  if (i < 0 || !isBoxBorder(texts[i]!)) return null;
  return { top: i, prompt, bottomBorder };
}
