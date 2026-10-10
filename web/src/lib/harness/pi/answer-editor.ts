// Recognition and reading of the pi question extension's free-answer editor.
//
// When the user types a free answer or presses Tab to add a note, the dialog opens an inline
// editor bounded by inner rules and a prompt above it:
//
//     Your answer (an option number or label picks that option):   <- prompt row
//    ────────────────────────────────────────────────────────────  <- inner top rule
//    hello world                                                   <- editor content row(s)
//    ────────────────────────────────────────────────────────────  <- inner bottom rule
//
//    Enter to submit • Esc to go back                              <- footer hint row
//   ────────────────────────────────────────────────────────────   <- dialog frame bottom rule

import type { StyledLine } from "../../blocks";
import { isBlank, lineText } from "../../blocks";
import { detectDialogFrame } from "./frame";
import { rstrip } from "./markers";

/** Matches inner horizontal rules starting with at least one space and at least 8 '─' glyphs. */
const INNER_RULE = /^\s+─{8,}$/;

/** Software cursor caret. */
const SOFTWARE_CARET = /▏$/;

/** Information about an active free-answer editor in the terminal buffer. */
export interface AnswerEditor {
  /** First line index of the editor content (between the inner rules). */
  firstInputRow: number;
  /** Last line index of the editor content. */
  lastInputRow: number;
  /** Line index of the inner top rule. */
  innerTopRule: number;
  /** Line index of the inner bottom rule. */
  innerBottomRule: number;
  /** Start line index of the prompt text (e.g. "Your answer..."). */
  promptRow: number;
  /** End line index of the prompt text (inclusive). */
  promptEndRow: number;
  /** Text of the prompt. */
  promptText: string;
  /** Outer dialog top rule. */
  frameTopRule: number;
  /** Outer dialog bottom rule. */
  frameBottomRule: number;
}

/**
 * Locate the free-answer editor at the tail of `lines`, or null if not present or corrupt.
 */
export function locateAnswerEditor(lines: StyledLine[]): AnswerEditor | null {
  const frame = detectDialogFrame(lines);
  if (!frame || !frame.editorOpen) return null;

  // Below the inner bottom rule sit one blank row and the footer.
  const innerBottomRule = frame.footerStart - 2;
  if (innerBottomRule < frame.topRule + 3) return null;

  const innerBottomText = rstrip(lineText(lines[innerBottomRule]!));
  if (!INNER_RULE.test(innerBottomText)) return null;

  const innerBottomColor = lines[innerBottomRule]!.segments.find((s) => s.text.trim().length > 0)?.fg;

  let innerTopRule = -1;
  for (let i = innerBottomRule - 2; i >= frame.topRule + 2; i--) {
    const text = rstrip(lineText(lines[i]!));
    if (INNER_RULE.test(text) && text.length === innerBottomText.length) {
      const color = lines[i]!.segments.find((s) => s.text.trim().length > 0)?.fg;
      if (!innerBottomColor || color === innerBottomColor) {
        innerTopRule = i;
        break;
      }
    }
  }
  if (innerTopRule < 0) return null;

  const firstInputRow = innerTopRule + 1;
  const lastInputRow = innerBottomRule - 1;
  if (lastInputRow < firstInputRow) return null;

  const promptEndRow = innerTopRule - 1;
  if (promptEndRow <= frame.topRule) return null;

  let promptRow = promptEndRow;
  while (promptRow > frame.topRule + 1 && !isBlank(lineText(lines[promptRow - 1]!))) {
    promptRow--;
  }

  const promptText = lines
    .slice(promptRow, promptEndRow + 1)
    .map((l) => rstrip(lineText(l)).trim())
    .join(" ");

  const isPrompt =
    promptText.startsWith("Your answer") ||
    promptText.startsWith("Selected:") ||
    promptText.includes("Add note");
  if (!isPrompt) return null;

  return {
    firstInputRow,
    lastInputRow,
    innerTopRule,
    innerBottomRule,
    promptRow,
    promptEndRow,
    promptText,
    frameTopRule: frame.topRule,
    frameBottomRule: frame.bottomRule,
  };
}

/**
 * Extract the draft text currently typed into the free-answer editor, or null when empty.
 */
export function answerEditorDraft(lines: StyledLine[]): string | null {
  const editor = locateAnswerEditor(lines);
  if (!editor) return null;

  const parts: string[] = [];
  for (let i = editor.firstInputRow; i <= editor.lastInputRow; i++) {
    let row = lineText(lines[i]!);
    // pi's editor indents each row by one column.
    if (row.startsWith(" ")) row = row.slice(1);
    row = rstrip(row).replace(SOFTWARE_CARET, "").trimEnd();
    if (row.length > 0) parts.push(row);
  }

  const draft = parts.join(" ").trim();
  return draft.length === 0 ? null : draft;
}

/**
 * The binding region for a destructive sweep: the editor's last input row verbatim, or null.
 * Sits within the bridge's 6-row prompt tail window.
 */
export function answerEditorPrompt(lines: StyledLine[]): string | null {
  const editor = locateAnswerEditor(lines);
  if (!editor) return null;
  const row = rstrip(lineText(lines[editor.lastInputRow]!));
  return row.length === 0 ? null : row;
}

/**
 * The prompt region info (the prompt line above the editor), describing where the prompt sits.
 */
export function answerEditorPromptRegion(
  lines: StyledLine[],
): { startLine: number; endLine: number; promptText: string; text: string } | null {
  const editor = locateAnswerEditor(lines);
  if (!editor) return null;
  return {
    startLine: editor.promptRow,
    endLine: editor.promptEndRow,
    promptText: editor.promptText,
    text: editor.promptText,
  };
}
