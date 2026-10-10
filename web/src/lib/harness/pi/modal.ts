// Positive evidence that a pi modal is on screen, gating the unread-dialog card (ADR 0053).
//
// Recognises pi's own key-hint footer at the tail naming its way out (Esc or Escape cancel/close/go back):
// - pi question dialogs: footer segments joined by bullets (•), ending in "Esc to cancel",
//   "Esc cancel", or "Esc to go back".
// - pi core modals: footer segments joined by middle dots (·), ending in "Escape/Ctrl+C to cancel".
//
// Tail-anchored:
// The modal is bounded at the bottom by a horizontal rule (─), optionally followed by up to 2
// status line rows (operator or default footer). The Esc-naming hint row sits immediately above
// that bottom rule (or within wrapped continuation lines).
//
// Pure over StyledLine[].

import type { StyledLine } from "../../blocks";
import { isBlank, lineText } from "../../blocks";
import { rstrip } from "./markers";

/** Match a horizontal rule row composed solely of '─' glyphs (at least 8). */
const HORIZONTAL_RULE = /^─{8,}$/;

/**
 * Esc-naming segment suffix: matches Esc or Escape with optional secondary chord (e.g. Escape/Ctrl+C)
 * followed by cancel, close, or go back.
 */
const FOOTER_ESC_SUFFIX =
  /(?:[•·]|\b)\s*(?:Esc|Escape)(?:\/[A-Za-z0-9+]+)?\s+(?:to\s+)?(cancel|go back|close)\s*$/i;

/**
 * Whether a pi modal is currently on screen: positive evidence via an Esc-naming key-hint footer
 * at the tail of the buffer.
 */
export function modalOnScreen(lines: StyledLine[]): boolean {
  let end = lines.length;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  if (end === 0) return false;

  // The bottom rule sits near the tail: at most 2 non-blank status rows below it.
  let bottomRule = -1;
  for (let i = end - 1; i >= Math.max(0, end - 3); i--) {
    const text = rstrip(lineText(lines[i]!));
    if (HORIZONTAL_RULE.test(text)) {
      bottomRule = i;
      break;
    }
  }
  if (bottomRule < 0) return false;

  for (let i = bottomRule + 1; i < end; i++) {
    const t = rstrip(lineText(lines[i]!));
    if (HORIZONTAL_RULE.test(t) || /^[│╭╮╰╯┌┐└┘]/.test(t)) return false;
  }

  // The Esc-naming hint sits on the row above the bottom rule, or the one above that if wrapped.
  for (let i = bottomRule - 1; i >= Math.max(0, bottomRule - 2); i--) {
    const text = rstrip(lineText(lines[i]!));
    if (isBlank(text)) continue;
    if ((text.includes("•") || text.includes("·")) && FOOTER_ESC_SUFFIX.test(text)) {
      const segments = text.split(/[•·]/).map((s) => s.trim()).filter(Boolean);
      // One segment is prose that happens to mention Esc; a hint row lists several keys.
      if (segments.length >= 2) return true;
    }
  }

  return false;
}
