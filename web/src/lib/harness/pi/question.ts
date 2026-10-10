// Single-choice question dialog lift for the pi question extension.
//
// Lifts a standalone single-choice question dialog into a PromptSelectBlock / PromptModel (family "select").
// Key plans are typed digits: ["1", "Enter"], ["2", "Enter"]... (supported by pi's matchOption,
// pointer-independent, single guarded write).
//
// Refusals (returns null):
// - Free-answer editor open (digits type into editor instead of selecting)
// - Questionnaires with tab bars (handled by tabs grammar)
// - Multi-select dialogs (handled by multi grammar)
// - Free-answer row ("Type something.") is never an option
// - Scrolled-up dialogs (must be tail-anchored)
// - More than 9 options (single-digit send keys constraint)

import type { StyledLine } from "../../blocks";
import { lineText } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { detectDialogFrame } from "./frame";
import { rstrip } from "./markers";

/** Lifted prompt-select region in the terminal buffer. */
export interface QuestionRegion {
  model: PromptModel;
  /** First row replaced by the block (the dialog's top accent rule). */
  startLine: number;
}

/**
 * Detect a standalone single-select question dialog at the tail of `lines`.
 * Returns the QuestionRegion or null if declined.
 */
export function detectSingleQuestionRegion(lines: StyledLine[]): QuestionRegion | null {
  const frame = detectDialogFrame(lines);
  if (!frame) return null;

  if (frame.tabBar !== undefined || frame.editorOpen) return null;

  if (!frame.footerText.includes("Enter to select")) return null;

  let qEnd = frame.topRule + 1;
  while (qEnd < frame.footerStart && lineText(lines[qEnd]!).trim() !== "") {
    qEnd++;
  }
  if (qEnd === frame.topRule + 1) return null;

  const question = lines
    .slice(frame.topRule + 1, qEnd)
    .map((l) => rstrip(lineText(l)).trim())
    .join(" ");

  if (question.length === 0) return null;

  interface RawOption {
    n: number;
    rawLabel: string;
    desc: string[];
  }

  const rawOptions: RawOption[] = [];
  let currentOpt: RawOption | null = null;

  for (let i = qEnd + 1; i < frame.footerStart; i++) {
    const raw = lineText(lines[i]!);
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    // A checkbox row belongs to multi.ts.
    if (trimmed.startsWith("[ ]") || trimmed.startsWith("[x]")) return null;

    const m = /^\s*(?:>\s+|\s{2})(\d+)\.\s+(.*)$/.exec(raw);
    if (m) {
      if (currentOpt) rawOptions.push(currentOpt);
      currentOpt = {
        n: Number(m[1]),
        rawLabel: m[2]!,
        desc: [],
      };
    } else if (currentOpt && raw.startsWith("    ")) {
      // A description wraps under its option, indented by at least four spaces.
      currentOpt.desc.push(trimmed);
    } else {
      return null;
    }
  }
  if (currentOpt) rawOptions.push(currentOpt);

  if (rawOptions.length === 0) return null;

  const options: PromptOption[] = [];
  let hasCustomInput = false;
  let customAnswer: string | undefined;
  for (let k = 0; k < rawOptions.length; k++) {
    const o = rawOptions[k]!;
    if (o.n !== k + 1) return null;

    // A trailing ` ✓` marks the answer already recorded, not part of the label.
    const label = o.rawLabel.replace(/ ✓$/, "").trim();

    // The free-answer row opens the editor; it is never a choice.
    if (label.startsWith("Type something.")) {
      hasCustomInput = true;
      const m = /Type something\.(?:\s*\((.*?)\))?/.exec(label);
      if (m && m[1]) customAnswer = m[1].trim();
      continue;
    }

    const opt: PromptOption = {
      label,
      keys: [String(k + 1), "Enter"],
    };
    if (o.desc.length > 0) {
      opt.description = o.desc.join(" ");
    }
    options.push(opt);
  }

  // Digit plans address at most nine options.
  if (options.length === 0 || options.length > 9) return null;

  const region = lines.slice(frame.topRule, frame.bottomRule + 1);
  const signature = region.map(lineText).join("\n");

  // The core signature blanks the pointer, so a pointer move stays the same dialog.
  const coreSignature = region
    .map((l) => lineText(l).replace(/^(\s*)>\s/, "$1  "))
    .join("\n");

  const model: PromptModel = {
    question,
    options,
    family: "select",
    signature,
    coreSignature,
    customInput: hasCustomInput || undefined,
    customAnswer,
  };

  return {
    model,
    startLine: frame.topRule,
  };
}

/**
 * Detect a standalone single-select question dialog at the tail of `lines`, returning just the model.
 */
export function detectSingleQuestion(lines: StyledLine[]): PromptModel | null {
  return detectSingleQuestionRegion(lines)?.model ?? null;
}
