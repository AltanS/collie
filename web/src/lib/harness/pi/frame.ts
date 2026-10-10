// Recognition and parsing of pi question-extension dialog frames at the tail of terminal output.
//
// A pi question dialog is structured as:
//   ──────────────────────────────────────────────────────────  <- top accent rule
//   [ ← ▢ Q1  ▢ Q2  ✓ Review → ]                               <- optional tab bar (questionnaire)
//   body (question, options, descriptions, or editor)
//   [empty line]
//   footer hint row (e.g. "↑↓ navigate • Enter to select • ... • Esc to cancel")
//   ──────────────────────────────────────────────────────────  <- bottom accent rule
//   [0..2 status/operator footer rows, e.g. "⎇ main ..."]
//
// Rules use the accent foreground color.
// The active tab chip carries a background color (theme.bg("selectedBg", ...)).
// An answered tab has ▣, an open tab has ▢, and Review ends with "✓ Review" or "✓" (compact).
// If the free-answer editor is open, the footer becomes "Enter to submit • Esc to go back".

import type { StyledLine } from "../../blocks";
import { isBlank, lineText } from "../../blocks";
import { rstrip } from "./markers";

/** One tab chip parsed from a questionnaire tab bar. */
export interface TabChip {
  /** 0-based index of this question tab. */
  index: number;
  /** Visible label of the tab (e.g. "Auth", "Features", or "1" if compact). */
  label: string;
  /** True if answered (▣), false if open (▢). */
  answered: boolean;
  /** True if this tab is active (has background style). */
  active: boolean;
  /** True if compact form ("1", "2"...). */
  compact: boolean;
}

/** Information about the questionnaire tab bar. */
export interface TabBarInfo {
  /** Line index of the tab bar in `lines`. */
  row: number;
  /** Question chips in screen order. */
  chips: TabChip[];
  /** The final Review chip. */
  reviewChip: {
    active: boolean;
    label: string;
    compact: boolean;
  };
  /** 0-based index of the active question chip, or -1 if Review is active or none. */
  activeChipIndex: number;
  /** True if the Review tab carries the active background highlight. */
  isReviewActive: boolean;
  /** True if the tab bar is in compact format. */
  compact: boolean;
}

/** A detected pi question dialog frame at the tail of the buffer. */
export interface DialogFrame {
  /** Index of top accent rule in `lines`. */
  topRule: number;
  /** Index of bottom accent rule in `lines`. */
  bottomRule: number;
  /** Start row of the footer hint (inclusive). */
  footerStart: number;
  /** End row of the footer hint (inclusive). */
  footerEnd: number;
  /** Joined footer text. */
  footerText: string;
  /** Accent color detected from the frame rules. */
  accentColor?: string;
  /** Tab bar info if this is a questionnaire dialog. */
  tabBar?: TabBarInfo;
  /** True if the inline free-answer editor is open. */
  editorOpen: boolean;
}

/** Match a horizontal rule row composed solely of '─' glyphs (at least 8). */
const HORIZONTAL_RULE = /^─{8,}$/;

/** Footer hints always contain bullets or middle dots and end with Esc / Escape cancel or go back. */
const FOOTER_ESC_SUFFIX = /(?:•\s*)?Esc(?:\s+to)?\s+(?:cancel|go back)$/i;

/** Parse a questionnaire tab bar line into TabBarInfo, or null if invalid or not a tab bar. */
export function parseTabBar(line: StyledLine, row: number): TabBarInfo | null {
  const raw = lineText(line);
  const left = raw.indexOf("←");
  const right = raw.lastIndexOf("→");
  if (left < 0 || right <= left) return null;

  const qRegex = /([▣▢])\s+(\S+)/g;
  const questions: Array<{ glyph: string; label: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = qRegex.exec(raw)) !== null) {
    if (m.index > right) break;
    questions.push({
      glyph: m[1]!,
      label: m[2]!,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  const revRegex = /✓(?:\s+Review)?/g;
  revRegex.lastIndex = left;
  const revMatch = revRegex.exec(raw);
  if (!revMatch || revMatch.index > right) return null;

  const revStart = revMatch.index;
  const revEnd = revMatch.index + revMatch[0].length;
  const isCompactReview = !revMatch[0].includes("Review");

  // The active chip is the one painted with a background.
  const bgSpans: Array<{ start: number; end: number }> = [];
  let off = 0;
  for (const seg of line.segments) {
    const s = off;
    const e = off + seg.text.length;
    off = e;
    if (seg.bg) bgSpans.push({ start: s, end: e });
  }

  const chips: TabChip[] = questions.map((q, idx) => {
    const active = bgSpans.some((s) => s.start < q.end && s.end > q.start);
    const compact = /^\d+$/.test(q.label);
    return {
      index: idx,
      label: q.label,
      answered: q.glyph === "▣",
      active,
      compact,
    };
  });

  const revActive = bgSpans.some((s) => s.start < revEnd && s.end > revStart);

  // Two highlighted chips is a torn redraw, not a tab bar.
  const activeCount = chips.filter((c) => c.active).length + (revActive ? 1 : 0);
  if (activeCount > 1) return null;

  const activeChipIndex = chips.findIndex((c) => c.active);
  const compact = isCompactReview || (chips.length > 0 && chips.every((c) => c.compact));

  return {
    row,
    chips,
    reviewChip: {
      active: revActive,
      label: revMatch[0].trim(),
      compact: isCompactReview,
    },
    activeChipIndex,
    isReviewActive: revActive,
    compact,
  };
}

/**
 * Detect a pi question dialog frame at the tail of `lines`, or null.
 *
 * Requirements:
 * - Dialog is tail-anchored (at most 2 non-blank status rows below bottom rule).
 * - Bounded by top and bottom accent rules of equal length and equal fg color.
 * - Footer hint row immediately above bottom rule (preceded by an empty line).
 * - Validates tab bar when present (refusing two active chips or corrupted format).
 * - Identifies editor-open state when footer is "Enter to submit • Esc to go back".
 */
export function detectDialogFrame(lines: StyledLine[]): DialogFrame | null {
  let end = lines.length;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  if (end === 0) return null;

  // The bottom rule sits near the tail: at most 2 status rows below it.
  let bottomRule = -1;
  for (let i = end - 1; i >= Math.max(0, end - 3); i--) {
    const text = rstrip(lineText(lines[i]!));
    if (HORIZONTAL_RULE.test(text)) {
      bottomRule = i;
      break;
    }
  }
  if (bottomRule < 0) return null;

  // The frame's rules are accent-coloured; an unstyled rule is not a dialog.
  const bottomRuleText = rstrip(lineText(lines[bottomRule]!));
  const bottomRuleColor = lines[bottomRule]!.segments.find((s) => s.text.trim().length > 0)?.fg;
  if (!bottomRuleColor) return null;

  for (let i = bottomRule + 1; i < end; i++) {
    const t = rstrip(lineText(lines[i]!));
    if (HORIZONTAL_RULE.test(t) || /^[│╭╮╰╯┌┐└┘]/.test(t)) return null;
  }

  let footerEnd = bottomRule - 1;
  while (footerEnd >= 0 && (isBlank(lineText(lines[footerEnd]!)) || HORIZONTAL_RULE.test(rstrip(lineText(lines[footerEnd]!))))) {
    footerEnd--;
  }
  if (footerEnd < 0) return null;

  // A narrow terminal wraps the footer hint over several rows.
  let footerStart = footerEnd;
  while (footerStart > 0 && !isBlank(lineText(lines[footerStart - 1]!)) && footerEnd - footerStart < 4) {
    footerStart--;
  }

  if (footerStart === 0 || !isBlank(lineText(lines[footerStart - 1]!))) return null;

  const footerLines = lines.slice(footerStart, footerEnd + 1).map((l) => rstrip(lineText(l)).trim());
  const footerText = footerLines.join(" ");

  if (!FOOTER_ESC_SUFFIX.test(footerText)) return null;

  const editorOpen = footerText === "Enter to submit • Esc to go back";

  // The top rule matches the bottom one in colour and length; when a terminal resize intervenes,
  // the top rule in scrollback may reflect the earlier width, falling back to a matching accent rule.
  let topRule = -1;
  let fallbackTopRule = -1;
  for (let i = footerStart - 2; i >= Math.max(0, footerStart - 120); i--) {
    const text = rstrip(lineText(lines[i]!));
    if (HORIZONTAL_RULE.test(text)) {
      const color = lines[i]!.segments.find((s) => s.text.trim().length > 0)?.fg;
      if (color && color === bottomRuleColor) {
        if (text.length === bottomRuleText.length) {
          topRule = i;
          break;
        }
        if (fallbackTopRule < 0) fallbackTopRule = i;
      }
    }
  }
  if (topRule < 0) topRule = fallbackTopRule;
  if (topRule < 0) return null;

  let tabBar: TabBarInfo | undefined;
  for (let r = topRule + 1; r < Math.min(topRule + 4, footerStart); r++) {
    const candText = lineText(lines[r]!);
    if (candText.includes("←") && candText.includes("→")) {
      const parsed = parseTabBar(lines[r]!, r);
      // A row shaped like a tab bar that fails to parse declines the whole frame.
      if (!parsed) return null;
      tabBar = parsed;
      break;
    }
  }

  return {
    topRule,
    bottomRule,
    footerStart,
    footerEnd,
    footerText,
    accentColor: bottomRuleColor,
    tabBar,
    editorOpen,
  };
}
