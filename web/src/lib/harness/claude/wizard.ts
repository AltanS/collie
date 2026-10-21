// Multi-question AskUserQuestion wizard detection — the grammar that recognises Claude Code's
// multi-question dialog (the "←  ☒ Focus area  ☐ Scope  ✔ Submit  →" stepper) at the TAIL of a
// pane buffer and lifts the CURRENT step into a `WizardModel` the UI renders natively.
//
// The choreography behind this (verified live in a sandbox pane — see WIZARD_NOTES.md) drives the
// design: the TUI shows only the current step; a digit instantly selects AND advances one step
// (no Enter, unlike single-question selects); the final step is a Submit review where digit `1`
// (or Enter) submits and `2` cancels — and that review step has NO hint footer, so it needs its
// own tail anchor. The round-trip model is INCREMENTAL: Collie mirrors the current step, each tap
// sends exactly one keystroke, and the next poll re-derives the next step — the TUI is the single
// source of truth for selections (no client-side form state to drift).
//
// Everything here is PURE over `StyledLine[]`, fixture-driven (web/src/fixtures/panes/
// claude--wizard-*.txt), and never touches a pane or the network. Uniquely among the grammars it
// reads segment STYLING (`AnsiSegment.bg`) as well as text: the current chip in the stepper is
// marked only by a background highlight, not by a distinct glyph.

import type { StyledLine } from "../../blocks";
import { classifyFooter, selectFooterStart, isBlank, isRuleRow, lineText, questionRowText } from "./markers";
import {
  checkboxState,
  coreRegionSignature,
  freeTextRowIndex,
  isFreeTextLabel,
  parseOptionRow,
  trailingMenuRows,
} from "./prompt-select";
import type { AnswerFieldPointer } from "../prompt-model";
import {
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
  type WizardAnswer,
  type WizardAnswerField,
  type WizardModel,
  type WizardOption,
  type WizardStepChip,
} from "../wizard-model";

// The MODEL this grammar produces — and the four control-key constants its renderer sends — are a
// harness-NEUTRAL contract (harness/wizard-model.ts): what any adapter promises when it emits a
// `wizard` block. Re-exported here so this file stays the one import site for everything about the
// Claude wizard grammar.
export type { WizardAnswer, WizardAnswerField, WizardModel, WizardOption, WizardStepChip };
export { WIZARD_BACK_KEYS, WIZARD_CANCEL_KEYS, WIZARD_NEXT_KEYS, WIZARD_SUBMIT_KEYS };

/** Detection result for buildBlocks: the model plus the stepper header's line index — the wizard
 *  region is [`startLine` … tail], which the renderer replaces with the native wizard. */
export interface WizardRegion {
  model: WizardModel;
  startLine: number;
}

// ---------------------------------------------------------------------------------------------
// Stepper header parsing
// ---------------------------------------------------------------------------------------------

// One chip: a state glyph then its label, up to the next glyph / nav arrow. `☐` unanswered,
// `☒`/`☑` answered, `✔`/`✅` the fixed Submit chip.
const CHIP = /([☐☒☑✔✅])\s*([^☐☒☑✔✅←→]*)/g;
const ANSWERED_GLYPHS = "☒☑";
const SUBMIT_GLYPHS = "✔✅";

interface ParsedStepper {
  chips: WizardStepChip[];
  /** True when the background-highlight sits on the Submit chip (the review step is current). */
  submitCurrent: boolean;
}

/**
 * Parse a stepper header line into its question chips, or null when the line isn't one. Requires
 * ≥2 question chips AND the trailing `✔ Submit` chip — a single-question select's lone chip line
 * ("☐ Color Theme", no Submit, no ←/→) must never parse, so T2 keeps it.
 *
 * The CURRENT chip is found via styling: it is the only segment run on the line with a background
 * colour (black-on-highlight; see WIZARD_NOTES.md). When no such segment exists (e.g. a theme we
 * haven't seen), every chip is `current: false` — detection still works, the UI just can't mark
 * the active chip (the phase/question text still identify the step).
 */
export function parseStepperLine(line: StyledLine): ParsedStepper | null {
  const text = lineText(line);
  const raw: { glyph: string; label: string }[] = [];
  CHIP.lastIndex = 0;
  for (let m = CHIP.exec(text); m !== null; m = CHIP.exec(text)) {
    raw.push({ glyph: m[1]!, label: m[2]!.trim() });
  }
  if (raw.length < 3) return null; // ≥2 questions + Submit
  const last = raw[raw.length - 1]!;
  if (!SUBMIT_GLYPHS.includes(last.glyph) || !/^submit$/i.test(last.label)) return null;
  const questions = raw.slice(0, -1);
  // Question chips must be checkbox-state glyphs with real labels (✔ mid-line would be malformed).
  if (questions.some((c) => SUBMIT_GLYPHS.includes(c.glyph) || c.label.length === 0)) return null;

  // The highlighted (current) chip: concatenate the text of the line's bg-styled segments (the
  // highlight run wraps exactly ONE chip — its glyph, label, and padding). Match it back to a
  // single chip. Exactly one chip is highlighted, so among chips whose label appears in the run we
  // take the LONGEST — otherwise a short label that is a substring of the real chip's label (e.g.
  // "UI" inside a highlighted "New UI") would be falsely marked current too, which would also skew
  // the wizardsEqual race-guard comparison.
  const highlighted = line.segments
    .filter((s) => s.bg !== undefined)
    .map((s) => s.text)
    .join("");
  const allChips = raw; // questions + the trailing Submit chip
  let currentChip: { glyph: string; label: string } | null = null;
  if (highlighted.length > 0) {
    for (const c of allChips) {
      if (highlighted.includes(c.label) && (currentChip === null || c.label.length > currentChip.label.length)) {
        currentChip = c;
      }
    }
  }
  const submitCurrent = currentChip === last;

  const chips: WizardStepChip[] = questions.map((c) => ({
    label: c.label,
    answered: ANSWERED_GLYPHS.includes(c.glyph),
    current: currentChip === c, // identity: exactly one question chip (or none) is current
  }));
  return { chips, submitCurrent };
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

// Same bounded windows philosophy as prompt-select: options sit against the footer.
const OPTION_SCAN_WINDOW = 24;
const MAX_FOOTER_GAP = 3;
// How far above its anchor the stepper is looked for. The review step lists every answered question
// (2–3 lines each) between the stepper and the submit rows, and a question step's question wraps to
// as many rows as it needs at a narrow width (nine at 54 columns, Claude Code 2.1.302), so both
// walks share this floor. The dialog's top rule, not this count, is what stops either walk.
const REVIEW_SCAN_WINDOW = 48;

const CHAT_ESCAPE = /^chat about this\b/i;
/** The chosen-row marker a revisited answered question shows: "2. UI ✔". */
const CHOSEN_SUFFIX = /\s*✔\s*$/;
/** A row the `❯` pointer stands on. */
const POINTER_ROW = /^\s*❯/;

/** One numbered row of the step's menu: its line, its digit and its label. */
interface OptionRow {
  index: number;
  n: number;
  label: string;
}

/**
 * Detect a multi-question wizard at the tail of `lines`: either a question step (select footer +
 * stepper header) or the Submit review step (which has NO footer — anchored on its
 * "1. Submit answers / 2. Cancel" tail rows instead). Returns null when the tail is anything else;
 * single-question dialogs never have the stepper, so they fall through to prompt-select untouched.
 * Pure; the caller owns pane access.
 */
export function detectWizardRegion(lines: StyledLine[]): WizardRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  return detectQuestionPhase(lines, texts, fi) ?? detectReviewPhase(lines, texts, fi);
}

/** Just the model (or null) — the race guard's re-derivation entry point. */
export function detectWizard(lines: StyledLine[]): WizardModel | null {
  return detectWizardRegion(lines)?.model ?? null;
}

/** A question step: select-family footer at the tail, numbered rows above it, and — the wizard
 *  discriminator — a parseable stepper header above the first row. */
function detectQuestionPhase(
  lines: StyledLine[],
  texts: string[],
  fi: number,
): WizardRegion | null {
  if (classifyFooter(texts[fi]!, texts) !== "select") return null;
  // The footer's first row: a footer a narrow pane wrapped onto two rows starts above `fi`, and the
  // option rows are measured to that row. `fi` stays on the last row, so the signature covers it all.
  const footerAt = selectFooterStart(texts, fi);

  // Numbered rows near the footer (same shape as the single-question menu). The menu is the trailing
  // 1,2,…,m run of them (see trailingMenuRows) — a numbered body above the current question's options
  // sits above it and drops out, the same body-list hazard prompt-select guards against.
  const from = Math.max(0, fi - OPTION_SCAN_WINDOW);
  const rows: OptionRow[] = [];
  for (let i = from; i < footerAt; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed) rows.push({ index: i, ...parsed });
  }
  if (rows.length < 2) return null;
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null;
  // Past 9 numbered rows, an option would need a two-key digit ("10") — the wizard sends the digit
  // ALONE to select+advance, and Herdr rejects "10", so this would mis-answer. Real wizard steps are
  // ≤6 options; bail to the raw mirror. (menu is 1..m consecutive by construction, so length > 9 == a row ≥10.)
  if (menu.length > 9) return null;
  // A multiSelect step inside a multi-question wizard (its option rows carry the `[ ]`/`[✔]` checkbox
  // prefix) is unsupported in v1: a wizard digit selects-AND-advances, but a checkbox digit TOGGLES,
  // so rendering these as select-and-advance answers would mis-drive the dialog. Bail to the raw
  // mirror + keys pad. (The multi-select grammar only claims the single-question checkbox form.)
  if (menu.some((row) => checkboxState(row.label) !== null)) return null;
  const firstOpt = menu[0]!.index;
  if (footerAt - menu[menu.length - 1]!.index > MAX_FOOTER_GAP) return null;

  // The stepper header above the first option — THE wizard discriminator. The stop at a horizontal
  // rule (the dialog's top border) is what keeps the scan out of scrollback; the floor only bounds
  // the walk, and sits far enough up for a question that wrapped onto many rows.
  const found = findStepper(lines, texts, firstOpt - 1, firstOpt - REVIEW_SCAN_WINDOW);
  if (!found) return null;
  const { stepper, index: stepperIdx } = found;

  // The question: every non-blank line between the stepper and the first option, joined (long
  // questions wrap), without the `│` gutter Claude paints down a question of more than one row.
  // There is always at least one.
  const questionLines: string[] = [];
  for (let i = stepperIdx + 1; i < firstOpt; i++) {
    if (!isBlank(texts[i]!)) questionLines.push(questionRowText(texts[i]!));
  }

  if (questionLines.length === 0) return null;
  const question = questionLines.join(" ");

  const { options, field, fieldLines } = readRows(texts, menu, footerAt);
  if (options.length === 0) return null;

  const model: Extract<WizardModel, { phase: "question" }> = {
    phase: "question",
    steps: stepper.chips,
    question,
    options,
    coreSignature: coreRegionSignature(texts, stepperIdx, fi, fieldLines),
    signature: texts.slice(stepperIdx, fi + 1).join("\n"),
  };
  if (field !== undefined) model.field = field;
  return { model, startLine: stepperIdx };
}

/** A question step's rows: its options, and its answer field with the lines that field covers. */
interface StepRows {
  options: WizardOption[];
  field?: WizardAnswerField;
  /** The field's row and every line its value wrapped onto, collapsed as one in `coreSignature`. */
  fieldLines: Set<number>;
}

/**
 * Options and the answer field. The "Type something." field is found by POSITION (freeTextRowIndex),
 * because typing replaces its placeholder, and it is modelled, never an option: while `❯` is on it
 * every digit is typed into it (ASK_FIELD_NOTES.md), which `field.focused` carries so the card and
 * `submitWizardKeys` can refuse an option. Option description sub-lines attach like prompt-select's;
 * any other placeholder row is dropped; "Chat about this" is kept but flagged — it aborts the wizard.
 */
function readRows(texts: string[], menu: readonly OptionRow[], footerAt: number): StepRows {
  const fieldAt = freeTextRowIndex(texts, menu);
  const options: WizardOption[] = [];
  const rows: StepRows = { options, fieldLines: new Set() };
  for (let r = 0; r < menu.length; r++) {
    const row = menu[r]!;
    const nextIdx = r + 1 < menu.length ? menu[r + 1]!.index : footerAt;
    if (r === fieldAt) {
      rows.field = readField(texts, menu, fieldAt, nextIdx, rows.fieldLines);
      continue;
    }
    if (isFreeTextLabel(row.label)) continue;
    const desc: string[] = [];
    for (let i = row.index + 1; i < nextIdx; i++) {
      const t = texts[i]!;
      if (isBlank(t) || isRuleRow(texts, i) || parseOptionRow(t)) continue;
      desc.push(t.trim());
    }
    const label = row.label.replace(CHOSEN_SUFFIX, "");
    options.push({
      label,
      description: desc.length ? desc.join(" ") : undefined,
      keys: [String(row.n)],
      chosen: CHOSEN_SUFFIX.test(row.label),
      escape: CHAT_ESCAPE.test(label),
    });
  }
  return rows;
}

/**
 * The answer field at `menu[fieldAt]`, recording its row and its wrapped lines in `lines`. The value is
 * the label plus every line it wrapped onto (up to a rule or the next row), rejoined with one space,
 * without the trailing ` ✔` of a revisited step (two spaces before it while the caret cell shows);
 * the placeholder reads as `""`.
 */
function readField(
  texts: string[],
  menu: readonly OptionRow[],
  fieldAt: number,
  end: number,
  lines: Set<number>,
): WizardAnswerField {
  const row = menu[fieldAt]!;
  const parts = [row.label];
  lines.add(row.index);
  for (let i = row.index + 1; i < end; i++) {
    const t = texts[i]!;
    if (isRuleRow(texts, i) || parseOptionRow(t) !== null) break;
    if (isBlank(t)) continue;
    parts.push(t.trim());
    lines.add(i);
  }
  const joined = parts.join(" ");
  const value = joined.replace(CHOSEN_SUFFIX, "").trim();
  const pointer = fieldPointer(texts, menu, fieldAt);
  return {
    key: String(row.n),
    focused: pointer === "on",
    text: isFreeTextLabel(value) ? "" : value,
    chosen: CHOSEN_SUFFIX.test(joined),
    pointer,
  };
}

/** Where `❯` stands relative to the field at `menu[fieldAt]`: above it, on it, below it, or nowhere. */
function fieldPointer(texts: string[], menu: readonly OptionRow[], fieldAt: number): AnswerFieldPointer {
  const pointed = menu.findIndex((row) => POINTER_ROW.test(texts[row.index]!));
  if (pointed < 0) return "none";
  if (pointed === fieldAt) return "on";
  return pointed < fieldAt ? "above" : "below";
}

/** The Submit review step. NO footer exists here (verified): the buffer tail is the
 *  "❯ 1. Submit answers / 2. Cancel" pair, with "Ready to submit your answers?" just above and
 *  the stepper (Submit chip highlighted) at the top of the region. */
function detectReviewPhase(lines: StyledLine[], texts: string[], fi: number): WizardRegion | null {
  // Tail anchor: the last non-blank line is exactly the Cancel row, the row above it the Submit
  // row. Literal labels — Claude Code generates them (not user content).
  const cancel = parseOptionRow(texts[fi]!);
  if (!cancel || cancel.n !== 2 || cancel.label !== "Cancel") return null;
  let si = fi - 1;
  while (si >= 0 && isBlank(texts[si]!)) si--;
  if (si < 0) return null;
  const submit = parseOptionRow(texts[si]!);
  if (!submit || submit.n !== 1 || submit.label !== "Submit answers") return null;

  // "Ready to submit your answers?" within a couple of lines above the Submit row.
  let ri = -1;
  for (let i = si - 1, seen = 0; i >= 0 && seen < 4; i--, seen++) {
    if (isBlank(texts[i]!)) continue;
    if (/^ready to submit your answers\?/i.test(texts[i]!.trim())) ri = i;
    break; // only the nearest non-blank line may be the prompt
  }
  if (ri < 0) return null;

  const found = findStepper(lines, texts, ri - 1, ri - REVIEW_SCAN_WINDOW);
  if (!found) return null;
  const { stepper, index: stepperIdx } = found;

  // The echoed answers between the stepper and the prompt: "● <question>" rows each followed by a
  // "→ <answer>" row; other non-blank lines continue whichever field is open (wrapped text). Each row
  // is read without the `│` bar Claude Code 2.1.302 can draw down an echoed question ("│ ● …",
  // "│   …"), as on the question step. The "Review your answers" heading and the ⚠ warning are
  // recognised and skipped.
  const answers: WizardAnswer[] = [];
  let incomplete = false;
  let open: { question: string; answer: string | null } | null = null;
  const flush = () => {
    if (open && open.answer !== null) answers.push({ question: open.question, answer: open.answer });
    open = null;
  };
  for (let i = stepperIdx + 1; i < ri; i++) {
    const t = questionRowText(texts[i]!);
    if (t.length === 0 || /^review your answers$/i.test(t)) continue;
    if (t.startsWith("⚠")) {
      incomplete = true;
      continue;
    }
    if (t.startsWith("●")) {
      flush();
      open = { question: t.replace(/^●\s*/, ""), answer: null };
    } else if (t.startsWith("→")) {
      if (open) open.answer = t.replace(/^→\s*/, "");
    } else if (open) {
      // Wrapped continuation of the question or the answer, whichever is being built.
      if (open.answer !== null) open.answer += ` ${t}`;
      else open.question += ` ${t}`;
    }
  }
  flush();

  return {
    model: {
      phase: "review",
      steps: stepper.chips,
      answers,
      incomplete,
      signature: texts.slice(stepperIdx, fi + 1).join("\n"),
    },
    startLine: stepperIdx,
  };
}

/** Scan upward from `start` down to `floor` for a parseable stepper header, stopping at a
 *  horizontal rule (the dialog border — the stepper always sits below it). */
function findStepper(
  lines: StyledLine[],
  texts: string[],
  start: number,
  floor: number,
): { stepper: ParsedStepper; index: number } | null {
  for (let i = start; i >= 0 && i >= floor; i--) {
    if (isRuleRow(texts, i)) return null;
    const stepper = parseStepperLine(lines[i]!);
    if (stepper) return { stepper, index: i };
  }
  return null;
}
