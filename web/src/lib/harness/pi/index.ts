// The pi harness adapter (`agent: "pi"`) for pi 1.1.0 with the pi question extension.
//
// Lifts the extension's dialogs:
// - Standalone single question -> `prompt-select` block (typed digit plans `["N", "Enter"]`)
// - Questionnaire single pages and Review -> `wizard` block (`["N", "Enter"]` on question pages;
//   `submitKeys: ["Enter"]`, `cancelKeys: ["Escape"]` on Review)
// - Multi-select question (standalone and questionnaire tabs) -> `multi-select` block (`walkSpace`
//   toggles, `advanceKeys: ["Enter"]`, `advanceNeedsChecked: true`)
//
// Composer & reply path:
// - Strips composer chrome (editor, slash palette, statusline footer) off raw mirror
// - Re-surfaces stranded draft and statuslines
// - `composerReady`: true on composer, answer editor, and dialog pages (false on Review and core modals)
// - `dialogAcceptsTyping`: true on single-choice question pages (standalone and questionnaire tabs);
//   false on multi-select (where checkboxes own the keyboard and Space ticks), on Review, and on modals
// - `newlineSubmits`: true for the free-answer editor and active question dialog pages (Enter submits/confirms)
// - `composerPrompt`: literal bottom rule or editor input row for prompt-bound sweeps
// - `cancelKey: "Escape"` + `modalOnScreen` for unread core modals and unhandled dialogs

import { isBlank, lineText, type Block, type StyledLine } from "../../blocks";
import type { HarnessAdapter } from "../types";
import {
  composerPrompt as locateComposerPrompt,
  draft as composerDraft,
  locate as locateComposer,
  statusLines as extractStatusLines,
  stripChrome,
} from "./composer";
import {
  answerEditorDraft,
  answerEditorPrompt,
  locateAnswerEditor,
} from "./answer-editor";
import { detectSingleQuestionRegion } from "./question";
import { detectTabsRegion } from "./tabs";
import { detectMultiSelectRegion } from "./multi";
import { modalOnScreen } from "./modal";

/** The mirror rows above a dialog that starts at `startLine`. Trims trailing blank spacer rows. */
function mirrorAbove(lines: StyledLine[], startLine: number): StyledLine[] {
  let end = startLine;
  while (end > 0 && isBlank(lineText(lines[end - 1]!))) end--;
  return lines.slice(0, end);
}

function dialogArm(
  lines: StyledLine[],
  startLine: number,
  block: Block,
): Block[] {
  const rawLines = mirrorAbove(lines, startLine);
  const blocks: Block[] = [];
  if (rawLines.length > 0) blocks.push({ kind: "raw", lines: rawLines });
  blocks.push(block);
  return blocks;
}

/**
 * pi's block pipeline: dialog arms first (single select, questionnaire tabs/review, multi select),
 * raw block with composer chrome stripped otherwise.
 */
export function piBuildBlocks(lines: StyledLine[]): Block[] {
  const single = detectSingleQuestionRegion(lines);
  if (single !== null) {
    return dialogArm(lines, single.startLine, {
      kind: "prompt-select",
      prompt: single.model,
      lines: lines.slice(single.startLine),
    });
  }
  const tabs = detectTabsRegion(lines);
  if (tabs !== null) {
    return dialogArm(lines, tabs.startLine, {
      kind: "wizard",
      wizard: tabs.model,
      lines: lines.slice(tabs.startLine),
    });
  }
  const multi = detectMultiSelectRegion(lines);
  if (multi !== null) {
    return dialogArm(lines, multi.startLine, {
      kind: "multi-select",
      multi: multi.model,
      lines: lines.slice(multi.startLine),
    });
  }
  return [{ kind: "raw", lines: stripChrome(lines) }];
}

/** Re-surface user draft from pi's composer, or from the free-answer editor if open. */
export function extractInputDraft(lines: StyledLine[]): string | null {
  return locateComposer(lines) !== null ? composerDraft(lines) : answerEditorDraft(lines);
}

/**
 * Pre-flight keyboard readiness: true on composer, answer editor, or a pi question dialog page.
 * False on Review and on every other modal (e.g. pi core selector).
 */
export function composerReady(lines: StyledLine[]): boolean {
  if (locateComposer(lines) !== null) return true;
  if (locateAnswerEditor(lines) !== null) return true;
  if (detectSingleQuestionRegion(lines) !== null) return true;
  if (detectMultiSelectRegion(lines) !== null) return true;
  const tabs = detectTabsRegion(lines);
  if (tabs !== null && tabs.model.phase === "question") return true;
  return false;
}

/**
 * Whether a lifted dialog currently on screen accepts typed answers through the composer.
 *
 * True on single-choice question pages (standalone and questionnaire tabs).
 * False on multi-select question pages (where checkboxes own the keyboard and Space is bound
 * to tick/untick; free-text answers open the inline editor instead), on Review, and on any other screen/modal.
 */
export function dialogAcceptsTyping(lines: StyledLine[]): boolean {
  if (detectMultiSelectRegion(lines) !== null) return false;
  if (detectSingleQuestionRegion(lines) !== null) return true;
  const tabs = detectTabsRegion(lines);
  return tabs !== null && tabs.model.phase === "question";
}

/**
 * Literal on-screen prompt row bound as `expected_prompt` for destructive pre-clear sweeps.
 * Uses the bottom rule of the composer if within the tail window, or the answer editor's last row.
 */
export function composerPrompt(lines: StyledLine[]): string | null {
  if (locateComposer(lines) !== null) return locateComposerPrompt(lines);
  if (locateAnswerEditor(lines) !== null) return answerEditorPrompt(lines);
  return null;
}

/**
 * The composer inserts raw newlines. The free-answer editor and all active question dialog pages
 * SUBMIT/CONFIRM on Enter, so newlineSubmits answers true on them to ensure multiline messages are
 * refused in preflight before sending raw newlines that would select an option underfoot.
 */
export function newlineSubmits(lines: StyledLine[]): boolean {
  if (locateAnswerEditor(lines) !== null) return true;
  if (detectSingleQuestionRegion(lines) !== null) return true;
  if (detectMultiSelectRegion(lines) !== null) return true;
  const tabs = detectTabsRegion(lines);
  return tabs !== null && tabs.model.phase === "question";
}

export const piAdapter: HarnessAdapter = {
  agent: "pi",
  buildBlocks: piBuildBlocks,
  extractStatusLines,
  extractInputDraft,
  composerReady,
  dialogAcceptsTyping,
  composerPrompt,
  newlineSubmits,
  // The unread-dialog card's cancel key (ADR 0053). Positive evidence from pi 1.1.0 captures:
  // pi core modal footers (e.g. `pi--v110-core-selector.txt`) print `Escape/Ctrl+C to cancel`;
  // pi question dialog footers print `Esc to cancel` or `Esc to go back`
  // (`pi--v110-single.txt`, `pi--v110-review-complete.txt`, `pi--v110-single-editor-open.txt`).
  cancelKey: "Escape",
  modalOnScreen,
};

export { modalOnScreen, extractStatusLines };
