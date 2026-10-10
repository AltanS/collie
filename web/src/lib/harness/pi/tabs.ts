// Questionnaire dialog lift for the pi question extension, on top of frame.ts.
//
// Lifts questionnaire pages into a WizardBlock / WizardModel:
// - single-select page -> wizard question (phase: "question", chips from tab bar,
//   chosen from ' ✓', option keys ['N','Enter'], nav Left/Right)
// - review page -> wizard review (phase: "review", answers from 'N. header  answer' rows,
//   incomplete flag, submitKeys ['Enter'], cancelKeys ['Escape']; an incomplete Review
//   sets submitAction "goToFirstUnanswered", which jumps to the first unanswered tab).
//
// Refusals (returns null):
// - Free-answer editor open (frame.editorOpen)
// - Unknown, corrupt, or missing tab bar
// - Two active chips (or zero active chips)
// - Multi-select question pages (checkboxes, handled by multi grammar)
// - Scrolled-up dialogs (tail-anchored check in detectDialogFrame)
// - More than 9 tabs or more than 9 options
// - Review rows not in tab order or count mismatch

import type { StyledLine } from "../../blocks";
import { isBlank, lineText } from "../../blocks";
import type {
  WizardAnswer,
  WizardModel,
  WizardOption,
  WizardStepChip,
} from "../wizard-model";
import { detectDialogFrame } from "./frame";

/** Lifted wizard region in the terminal buffer. */
export interface TabsRegion {
  model: WizardModel;
  /** First row replaced by the block (the dialog's top accent rule). */
  startLine: number;
}

/** Max options or tabs supported by single-digit key addressing. */
const MAX_DIGIT_ITEMS = 9;

/** The Review phase submit keys in pi (Enter confirms or jumps to first unanswered). */
const PI_WIZARD_SUBMIT_KEYS = ["Enter"];
/** The Review phase cancel keys in pi. */
const PI_WIZARD_CANCEL_KEYS = ["Escape"];

/**
 * Detect a questionnaire dialog (single-select page or Review) at the tail of `lines`.
 * Returns the TabsRegion or null if declined.
 */
export function detectTabsRegion(lines: StyledLine[]): TabsRegion | null {
  const frame = detectDialogFrame(lines);
  if (!frame) return null;

  if (frame.editorOpen) return null;

  // A standalone question belongs to question.ts or multi.ts.
  if (!frame.tabBar) return null;

  const { tabBar } = frame;

  if (tabBar.chips.length === 0 || tabBar.chips.length > MAX_DIGIT_ITEMS) return null;

  // Exactly one chip, question or Review, carries the active highlight.
  const activeCount =
    tabBar.chips.filter((c) => c.active).length + (tabBar.isReviewActive ? 1 : 0);
  if (activeCount !== 1) return null;

  const steps: WizardStepChip[] = tabBar.chips.map((c) => ({
    label: c.label,
    answered: c.answered,
    current: c.active,
  }));

  const region = lines.slice(frame.topRule, frame.bottomRule + 1);
  const signature = region.map(lineText).join("\n");

  if (tabBar.isReviewActive) {
    return parseReviewPhase(lines, frame, steps, signature);
  }

  return parseQuestionPhase(lines, frame, steps, signature);
}

/**
 * Parse the Review phase of a questionnaire into a WizardModel.
 */
function parseReviewPhase(
  lines: StyledLine[],
  frame: NonNullable<ReturnType<typeof detectDialogFrame>>,
  steps: WizardStepChip[],
  signature: string,
): TabsRegion | null {
  if (!frame.footerText.includes("Enter") || !/Esc/i.test(frame.footerText)) {
    return null;
  }

  let row = frame.tabBar!.row + 1;
  while (row < frame.footerStart && isBlank(lineText(lines[row]!))) row++;
  if (row >= frame.footerStart) return null;

  const heading = lineText(lines[row]!).trim();
  if (!heading.startsWith("Review your answers")) return null;
  row++;

  while (row < frame.footerStart && isBlank(lineText(lines[row]!))) row++;

  // Answer rows read `N. header  answer`, the two columns split by a run of two or more spaces.
  interface ParsedReviewRow {
    n: number;
    header: string;
    answer: string;
  }

  const parsedRows: ParsedReviewRow[] = [];

  while (row < frame.footerStart) {
    const raw = lineText(lines[row]!);
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      row++;
      break;
    }
    // The summary line closes the answer rows.
    if (trimmed.startsWith("✓ All answered") || trimmed.startsWith("Unanswered:")) {
      break;
    }

    const m = /^\s*(\d+)\.\s+(\S.*?)\s{2,}(.*)$/.exec(raw);
    if (m) {
      parsedRows.push({
        n: Number(m[1]),
        header: m[2]!.trim(),
        answer: m[3]!.trim(),
      });
    } else if (parsedRows.length > 0 && raw.startsWith("    ")) {
      // A long answer wraps onto rows indented by four spaces.
      parsedRows[parsedRows.length - 1]!.answer += " " + trimmed;
    } else {
      return null;
    }
    row++;
  }

  if (parsedRows.length !== steps.length) return null;

  for (let i = 0; i < parsedRows.length; i++) {
    const r = parsedRows[i]!;
    if (r.n !== i + 1) return null;
    // A compact tab bar shows digits, so only a full one can be checked against the headers.
    if (!frame.tabBar!.compact && r.header !== steps[i]!.label) {
      return null;
    }
  }

  const answers: WizardAnswer[] = parsedRows.map((r) => ({
    question: r.header,
    answer: r.answer,
  }));

  const incomplete =
    steps.some((s) => !s.answered) ||
    answers.some((a) => a.answer.includes("not answered"));

  const model: WizardModel = {
    phase: "review",
    steps,
    answers,
    incomplete,
    submitKeys: PI_WIZARD_SUBMIT_KEYS,
    submitAction: incomplete ? "goToFirstUnanswered" : "submit",
    cancelKeys: PI_WIZARD_CANCEL_KEYS,
    signature,
  };

  return {
    model,
    startLine: frame.topRule,
  };
}

/**
 * Parse a single-select question page of a questionnaire into a WizardModel.
 */
function parseQuestionPhase(
  lines: StyledLine[],
  frame: NonNullable<ReturnType<typeof detectDialogFrame>>,
  steps: WizardStepChip[],
  signature: string,
): TabsRegion | null {
  // A tick hint marks a multi-select page, which belongs to multi.ts.
  if (
    frame.footerText.includes("Space tick") ||
    frame.footerText.includes("Space to tick") ||
    (!frame.footerText.includes("Enter select") && !frame.footerText.includes("Enter to select"))
  ) {
    return null;
  }

  let qStart = frame.tabBar!.row + 1;
  while (qStart < frame.footerStart && isBlank(lineText(lines[qStart]!))) qStart++;
  if (qStart >= frame.footerStart) return null;

  let qEnd = qStart;
  while (qEnd < frame.footerStart && !isBlank(lineText(lines[qEnd]!))) qEnd++;

  const question = lines
    .slice(qStart, qEnd)
    .map((l) => lineText(l).trim())
    .join(" ");

  if (question.length === 0) return null;
  // The multi-select subtitle; such a page belongs to multi.ts.
  if (question.includes("Pick one or more options")) return null;

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
    if (trimmed.startsWith("[ ]") || trimmed.startsWith("[x]") || trimmed.startsWith("[✓]")) {
      return null;
    }

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

  for (let k = 0; k < rawOptions.length; k++) {
    if (rawOptions[k]!.n !== k + 1) return null;
  }

  const options: WizardOption[] = [];
  let hasCustomInput = false;
  let customAnswer: string | undefined;
  for (let k = 0; k < rawOptions.length; k++) {
    const o = rawOptions[k]!;
    // A trailing ` ✓` marks the answer already recorded on this tab.
    const chosen = o.rawLabel.endsWith(" ✓");
    const label = o.rawLabel.replace(/ ✓$/, "").trim();

    // The free-answer row opens the editor; it is never a choice.
    if (label.startsWith("Type something.")) {
      hasCustomInput = true;
      const m = /Type something\.(?:\s*\((.*?)\))?/.exec(label);
      if (m && m[1]) customAnswer = m[1].trim();
      continue;
    }

    const opt: WizardOption = {
      label,
      keys: [String(k + 1), "Enter"],
      chosen,
      escape: false,
    };
    if (o.desc.length > 0) {
      opt.description = o.desc.join(" ");
    }
    options.push(opt);
  }

  if (options.length === 0 || options.length > MAX_DIGIT_ITEMS) return null;

  const model: WizardModel = {
    phase: "question",
    steps,
    question,
    options,
    customInput: hasCustomInput || undefined,
    customAnswer,
    signature,
  };

  return {
    model,
    startLine: frame.topRule,
  };
}

/**
 * Detect a questionnaire dialog (single-select page or Review) at the tail of `lines`,
 * returning just the model.
 */
export function detectTabs(lines: StyledLine[]): WizardModel | null {
  return detectTabsRegion(lines)?.model ?? null;
}
