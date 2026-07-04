// Chrome stripping — trims the agent's own TUI chrome off the TAIL of a parsed buffer so the app's
// composer/statusline supersedes it instead of duplicating it. Today that's the Claude Code input
// box (the "❯ …" prompt line sandwiched between two rules) plus the statusline / hint lines below it
// and any trailing blank runs.
//
// Deliberately CONSERVATIVE: it strips only when the WHOLE input-box shape matches confidently at
// the tail, and never removes content above it — when unsure it returns the buffer untouched (the
// T1 raw-mirror fallback). Pure; operates on parsed line text, so a user-configured statusline is
// matched by POSITION (below the box's bottom border), never by its content strings.

import type { StyledLine } from "../blocks";
import { isBlank, isBoxBorder, lineText } from "./markers";

// Lines allowed between the input box's bottom border and the tail: the statusline plus a hint line
// or two ("← for agents", "⏵⏵ bypass permissions on …"). More than this and we don't recognise the
// shape, so we leave the buffer raw.
const MAX_STATUS_LINES = 3;

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
  const boxTop = matchInputBox(texts, end);
  if (boxTop !== null) {
    end = boxTop;
    // Drop the blank run now exposed above the box (a fresh session has an empty body above it).
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
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
 * return the index of the TOP border (the new exclusive bound). Otherwise null. Scans bottom-up.
 */
function matchInputBox(texts: string[], end: number): number | null {
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
  i--;

  // (c) the "❯" prompt line (allow blank padding on either side, defensively)
  while (i >= 0 && isBlank(texts[i]!)) i--;
  if (i < 0 || !texts[i]!.trimStart().startsWith("❯")) return null;
  i--;
  while (i >= 0 && isBlank(texts[i]!)) i--;

  // (d) top border
  if (i < 0 || !isBoxBorder(texts[i]!)) return null;
  return i;
}
