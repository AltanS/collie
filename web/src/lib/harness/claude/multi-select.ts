// Multi-select AskUserQuestion detection — the grammar that recognises Claude Code's `multiSelect`
// dialog (the CHECKBOX form of AskUserQuestion) at the TAIL of a pane buffer and lifts the current
// screen into a `MultiSelectModel` the UI renders natively. Two phases mirror the wizard's structure:
//
//   - `checkbox`: numbered rows carry a `[ ]`/`[✔]` checkbox prefix (THE discriminator vs a single
//     select), a navigable `Submit` row sits below them, and a single-question stepper
//     (`←  ☐ Toppings  ✔ Submit  →` — exactly ONE question chip + the Submit chip) anchors the top.
//     A digit N TOGGLES option N on/off (pointer-independent); Enter activates the POINTED row. The
//     one exception is the `Type something` field: with the pointer on it a digit is typed into the
//     field, which the model says as `pointer: "field"`.
//   - `review`: activating Submit advances here — `Ready to submit your answers?` over
//     `❯ 1. Submit answers` / `2. Cancel`, with the same single-question stepper. Digit 1 submits,
//     2 cancels; a `⚠ …not answered all questions` line means `incomplete`.
//
// The last checkbox row above the advance row is the question's answer field (`Type something`, ADR
// 0113), modelled as `field` and never an option: its digit toggles its tick, and while `❯` is on it
// every key is typed into it (grammar/ASK_FIELD_NOTES.md § Multi-select). Prompt-select bails on the
// checkbox rows and wizard on a checkbox step, so this detector owns the shape alone. Everything here
// is PURE over `StyledLine[]`, fixture-driven (web/src/fixtures/panes/claude--select-multiselect-*.txt,
// claude--v2299-ask-field-*multi-*.txt), and never touches a pane or the network.

import type { StyledLine } from "../../blocks";
import type { AnswerFieldPointer } from "../prompt-model";
import {
  classifyFooter,
  selectFooterStart,
  isBlank,
  isRuleRow,
  lineText,
  questionRowText,
  ruleTop,
} from "./markers";
import { checkboxState, isFreeTextLabel, parseOptionRow, trailingMenuRows } from "./prompt-select";
import { parseStepperLine } from "./wizard";
import type { WizardStepChip } from "../wizard-model";
import type {
  MultiPointer,
  MultiSelectAnswerField,
  MultiSelectEscape,
  MultiSelectModel,
  MultiSelectOption,
} from "../multi-select-model";

// The MODEL this grammar produces is a harness-NEUTRAL contract (harness/multi-select-model.ts) —
// what any adapter promises when it emits a `multi-select` block. Re-exported here so this file stays
// the one import site for everything about the Claude multi-select grammar.
export type { MultiPointer, MultiSelectEscape, MultiSelectModel, MultiSelectOption };

/** Detection result for buildBlocks: the model plus the region's first line — the multi-select
 *  region is [`startLine` … tail], which the renderer replaces with the native block. */
export interface MultiSelectRegion {
  model: MultiSelectModel;
  startLine: number;
}

// Same bounded-window philosophy as the sibling grammars: options sit against the footer.
const OPTION_SCAN_WINDOW = 24;
const MAX_FOOTER_GAP = 3;
// How far above its anchor the stepper is looked for: above the "Ready…" prompt on the review screen
// (its prompt + warning sit between), and above the first option on the checkbox screen, whose
// question wraps to as many rows as it needs at a narrow width. The dialog's top rule, not this
// count, is what stops either walk.
const REVIEW_SCAN_WINDOW = 48;

const CHAT_ESCAPE = /^chat about this\b/i;
// The navigable ADVANCE row (no digit — Enter activates it), possibly carrying the pointer. Its label
// is `Submit` on the LAST question and `Next` on every earlier one, so the word is captured rather
// than assumed — hard-coding either would break half the steps of a multi-question dialog.
//
// Note this row exists ONLY on a checkbox question. A plain wizard question has none: its digits
// select AND advance in one press, whereas a checkbox digit only toggles, so the advance needs its
// own control. That is what makes the row a reliable part of this grammar rather than incidental.
const ADVANCE_ROW = /^❯?\s*(Submit|Next)$/;
const READY_PROMPT = /^ready to submit your answers\?/i;

// ---------------------------------------------------------------------------------------------
// Single-question stepper
// ---------------------------------------------------------------------------------------------

// One chip: a state glyph then its label, up to the next glyph / nav arrow. The multiSelect stepper
// carries exactly ONE question chip (`☐`/`☒`/`☑`) plus the fixed `✔ Submit` chip — two chips total,
// which is why the wizard's parseStepperLine (≥3 chips) never claims it.
const CHIP = /([☐☒☑✔✅])\s*([^☐☒☑✔✅←→]*)/g;
const SUBMIT_GLYPHS = "✔✅";

/** True when `line` is the multiSelect stepper: exactly one question chip + the `✔ Submit` chip. */
function isSingleQuestionStepper(line: StyledLine): boolean {
  const text = lineText(line);
  const chips: { glyph: string; label: string }[] = [];
  CHIP.lastIndex = 0;
  for (let m = CHIP.exec(text); m !== null; m = CHIP.exec(text)) {
    chips.push({ glyph: m[1]!, label: m[2]!.trim() });
  }
  if (chips.length !== 2) return false;
  const question = chips[0]!;
  const submit = chips[1]!;
  if (SUBMIT_GLYPHS.includes(question.glyph) || question.label.length === 0) return false;
  return SUBMIT_GLYPHS.includes(submit.glyph) && /^submit$/i.test(submit.label);
}

/**
 * Scan upward for the stepper above a CHECKBOX question, in either of its two shapes: the
 * single-question stepper (`☐ Toppings  ✔ Submit`) or the multi-question wizard's own
 * (`☐ Types  ☐ Anchoring  …  ✔ Submit`), parsed by the wizard's `parseStepperLine` so the chip
 * grammar lives in exactly one place. `steps` is null for the single-question form — the same
 * distinction `preview-select` draws, and for the same reason: a wizard step gains Left/Right
 * navigation between questions, a standalone dialog has nowhere to navigate to.
 */
function findCheckboxStepper(
  lines: StyledLine[],
  texts: string[],
  start: number,
  floor: number,
): { index: number; steps: WizardStepChip[] | null } | null {
  for (let i = start; i >= 0 && i >= floor; i--) {
    if (isRuleRow(texts, i)) return null;
    if (isSingleQuestionStepper(lines[i]!)) return { index: i, steps: null };
    const wizardStepper = parseStepperLine(lines[i]!);
    if (wizardStepper) return { index: i, steps: wizardStepper.chips };
  }
  return null;
}

/** Scan upward from `start` down to `floor` for the single-question stepper, stopping at a horizontal
 *  rule (the dialog border — the stepper always sits below it). Returns its line index, or -1. */
function findSingleStepper(
  lines: StyledLine[],
  texts: string[],
  start: number,
  floor: number,
): number {
  for (let i = start; i >= 0 && i >= floor; i--) {
    if (isRuleRow(texts, i)) return -1;
    if (isSingleQuestionStepper(lines[i]!)) return i;
  }
  return -1;
}

/** The region's pointer/checkbox-independent signature: lines [`from` … `to`] with the `❯` pointer,
 *  every `[✔]`/`[ ]` option checkbox, and the stepper's answered chip glyph (`☒`/`☑`→`☐`) normalised
 *  out — so it captures the SUBJECT + labels only, stable across the whole toggle + Submit-macro
 *  choreography (the pointer moves, boxes flip). The transient state (pointer, checked) is compared
 *  SEPARATELY by multiSelectEquals via the options[]. The answer field's row and every line its value
 *  wrapped onto (`fieldLines`) collapse to one fixed token, so the signature survives typing, clearing
 *  and re-wrapping the field (its text is compared separately, through `field`). Pure of the buffer's
 *  absolute offset, so the frozen model and a fresh re-derivation of the SAME dialog produce
 *  byte-equal strings. */
function coreSignature(texts: string[], from: number, to: number, fieldLines: ReadonlySet<number>): string {
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    if (fieldLines.has(i)) {
      if (!fieldLines.has(i - 1)) out.push(FIELD_TOKEN);
      continue;
    }
    out.push(
      texts[i]!
        .replace(/❯/g, " ")
        .replace(/\[[ xX✔✓]\]/g, "[ ]")
        .replace(/[☒☑]/g, "☐"),
    );
  }
  return out.join("\n");
}

// What the answer field's lines read as in the core signature: no screen row can print it.
const FIELD_TOKEN = "\u0000answer-field\u0000";

/** Classify which row the `❯` pointer sits on across [`from` … `to`] (raw line text — the pointer is
 *  a leading glyph). `null` when no row carries it. */
function pointerAt(texts: string[], from: number, to: number, rows: { advanceIdx: number; fieldIdx: number }): MultiPointer {
  for (let i = from; i <= to; i++) {
    if (!/^\s*❯/.test(texts[i]!)) continue;
    const trimmed = texts[i]!.trim();
    // By index: a line that merely READS "Submit"/"Next" is not the advance row (see its location above),
    // and the answer field is a place too, whatever it holds (it reads "[✔] teal" once typed into).
    if (i === rows.advanceIdx) return "advance";
    if (i === rows.fieldIdx) return "field";
    const parsed = parseOptionRow(trimmed);
    if (!parsed) return "other";
    if (CHAT_ESCAPE.test(parsed.label)) return "chat";
    const cb = checkboxState(parsed.label);
    if (cb && !isFreeTextLabel(cb.rest)) return "option";
    return "other"; // an unrecognised pointed row
  }
  return null;
}

/**
 * The answer field at menu row `row` (by position: the last menu row above the advance row), recording
 * its row and the lines its value wrapped onto in `lines`. The value is the row's checkbox text plus
 * every non-blank line down to the advance row, rejoined with one space; the placeholder reads `""`.
 * Null when the row carries no checkbox (not a multiSelect field).
 */
function readField(
  texts: string[],
  menu: readonly { index: number; n: number; label: string }[],
  row: { index: number; n: number; label: string },
  advanceIdx: number,
  lines: Set<number>,
): MultiSelectAnswerField | null {
  const cb = checkboxState(row.label);
  if (!cb) return null;
  const parts = [cb.rest];
  lines.add(row.index);
  for (let i = row.index + 1; i < advanceIdx; i++) {
    if (isBlank(texts[i]!)) continue;
    parts.push(texts[i]!.trim());
    lines.add(i);
  }
  const value = parts.join(" ").trim();
  const pointer = fieldPointer(texts, menu, row.index, advanceIdx);
  return {
    n: row.n,
    focused: pointer === "on",
    text: isFreeTextLabel(value) ? "" : value,
    checked: cb.checked,
    pointer,
    lines: lines.size,
  };
}

/** Where `❯` stands relative to the field at line `fieldIdx`: on an option row above it, on it, on the
 *  advance row or the chat escape below it, or nowhere on those rows. */
function fieldPointer(
  texts: string[],
  menu: readonly { index: number; label: string }[],
  fieldIdx: number,
  advanceIdx: number,
): AnswerFieldPointer {
  const pointed = (i: number) => /^\s*❯/.test(texts[i]!);
  if (pointed(fieldIdx)) return "on";
  if (pointed(advanceIdx)) return "below";
  const row = menu.find((r) => r.index !== fieldIdx && pointed(r.index));
  if (row === undefined) return "none";
  if (row.index > fieldIdx) return CHAT_ESCAPE.test(row.label) ? "below" : "none";
  return "above";
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

/**
 * Detect a multi-select dialog at the tail of `lines`: either the checkbox screen (select footer +
 * checkbox rows + single-question stepper) or the review screen (its `1. Submit answers / 2. Cancel`
 * tail). Returns the model + its start line, or null when the tail is anything else. Pure; the caller
 * owns pane access.
 */
export function detectMultiSelectRegion(lines: StyledLine[]): MultiSelectRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  return detectCheckboxPhase(lines, texts, fi) ?? detectReviewPhase(lines, texts, fi);
}

/** Just the model (or null) — the race guard's re-derivation entry point. */
export function detectMultiSelect(lines: StyledLine[]): MultiSelectModel | null {
  return detectMultiSelectRegion(lines)?.model ?? null;
}

/** The checkbox screen: a select-family footer at the tail, numbered checkbox rows above it, and the
 *  single-question stepper — the multiSelect discriminator — above the first row. */
function detectCheckboxPhase(
  lines: StyledLine[],
  texts: string[],
  fi: number,
): MultiSelectRegion | null {
  if (classifyFooter(texts[fi]!, texts) !== "select") return null;
  // The footer's first row: a footer a narrow pane wrapped onto two rows starts above `fi`, and the
  // option rows are measured to that row (`fi` stays on the last row for the pointer read).
  const footerAt = selectFooterStart(texts, fi);

  // Numbered rows near the footer — the trailing 1,2,…,m run (the checkbox options + the numbered
  // "Chat about this" escape); a numbered body above it drops out (same hazard as prompt-select).
  const from = Math.max(0, fi - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i < footerAt; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed) rows.push({ index: i, ...parsed });
  }
  if (rows.length < 2) return null;
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null;
  if (menu.length > 9) return null; // a row ≥10 needs the unsendable digit "10"
  const firstOpt = menu[0]!.index;
  if (footerAt - menu[menu.length - 1]!.index > MAX_FOOTER_GAP) return null;

  // The screen MUST carry the navigable advance row, and we locate it by POSITION, not by scanning
  // for the first line that reads "Submit"/"Next". Claude Code draws it in exactly one place: last
  // non-blank line above the rule that separates the menu from the "Chat about this" escape.
  //
  // Position matters because the text is model-authored and untrusted. Matching on text alone, an
  // option DESCRIPTION reading "Next" would (a) rename the button, so it advertises an action it
  // doesn't perform, (b) satisfy the "row is absent → fail closed" check on a pane that has no
  // advance row at all, leaving the macro to spray Down keys into a live pane hunting for it, and
  // (c) via pointerAt, be reported as the pointer — making the macro press Enter on whatever row the
  // terminal's ❯ is really on, which on "Chat about this" aborts the whole tool call.
  //
  // No rule below the options means a layout we don't know: bail rather than guess. A rule that
  // wrapped beside a theme's gutter (`isRuleRow` in markers.ts) is met at its stub first; the rule
  // itself starts at the top of the run of rule rows the stub ends (`ruleTop`).
  let ruleIdx = -1;
  for (let i = footerAt - 1; i > firstOpt; i--) {
    if (isRuleRow(texts, i)) {
      ruleIdx = ruleTop(texts, i, firstOpt + 1);
      break;
    }
  }
  if (ruleIdx < 0) return null;
  let advanceIdx = -1;
  for (let i = ruleIdx - 1; i > firstOpt; i--) {
    if (isBlank(texts[i]!)) continue;
    advanceIdx = i;
    break;
  }
  if (advanceIdx < 0) return null;
  const advanceMatch = ADVANCE_ROW.exec(texts[advanceIdx]!.trim());
  if (!advanceMatch) return null;
  const advanceLabel = advanceMatch[1]!;

  const stepper = findCheckboxStepper(lines, texts, firstOpt - 1, firstOpt - REVIEW_SCAN_WINDOW);
  if (!stepper) return null;
  const stepperIdx = stepper.index;

  // The "Type something" answer field is the last menu row above the advance row, by POSITION: once
  // someone types, the row reads "[✔] teal". It is modelled as `field`, never an option. While `❯` is
  // on it every digit is typed INTO it (measured on Claude Code 2.1.283), which the pointer reads as
  // `field` and `field.focused` carries: the macros move the pointer off with an arrow and read it
  // back before any digit, and the commit comparison tells a focused field from an unfocused one. Off
  // the field, its digit toggles its tick (measured). Until 1.22.5 the screen was not claimed at all
  // while the pointer stood there, and fell to the unread-dialog card (Claude Code 2.1.302, the field
  // capture of 2026-10-17).
  const fieldRow = menu.findLast((row) => row.index < advanceIdx);
  const fieldLines = new Set<number>();
  const field = fieldRow === undefined ? null : readField(texts, menu, fieldRow, advanceIdx, fieldLines);
  if (fieldRow !== undefined && field === null) return null; // the checkbox-prefix discriminator

  // The question: every non-blank line between the stepper and the first option, joined, without the
  // `│` gutter Claude paints down a question of more than one row.
  const questionLines: string[] = [];
  for (let i = stepperIdx + 1; i < firstOpt; i++) {
    if (!isBlank(texts[i]!)) questionLines.push(questionRowText(texts[i]!));
  }
  if (questionLines.length === 0) return null;
  const question = questionLines.join(" ");

  // Options: strip the checkbox prefix, lift `checked`, attach description sub-lines. "Chat about
  // this" is captured as the escape; the answer field row is the field above, never an option. EVERY
  // non-escape row must carry the checkbox prefix — a row without one means this is a single select.
  const options: MultiSelectOption[] = [];
  let escape: MultiSelectEscape | null = null;
  for (let r = 0; r < menu.length; r++) {
    const row = menu[r]!;
    if (CHAT_ESCAPE.test(row.label)) {
      escape = { n: row.n, label: row.label };
      continue;
    }
    if (row === fieldRow) continue;
    const cb = checkboxState(row.label);
    if (!cb) return null; // the checkbox-prefix discriminator: bail to the single-select grammar
    if (isFreeTextLabel(cb.rest)) continue;
    const nextIdx = r + 1 < menu.length ? menu[r + 1]!.index : footerAt;
    const desc: string[] = [];
    for (let i = row.index + 1; i < nextIdx; i++) {
      const t = texts[i]!;
      if (isBlank(t) || isRuleRow(texts, i) || parseOptionRow(t) || i === advanceIdx) continue;
      desc.push(t.trim());
    }
    options.push({
      n: row.n,
      label: cb.rest,
      description: desc.length ? desc.join(" ") : undefined,
      checked: cb.checked,
    });
  }
  if (options.length === 0) return null;

  const model: Extract<MultiSelectModel, { phase: "checkbox" }> = {
    phase: "checkbox",
    question,
    options,
    escape,
    steps: stepper.steps,
    advanceLabel,
    pointer: pointerAt(texts, firstOpt, fi, { advanceIdx, fieldIdx: fieldRow?.index ?? -1 }),
    pointerRow: null, // digit mode never reads it — the digit toggles pointer-independently
    toggle: "digit",
    // Signature ends at the LAST menu row, NOT the footer: Claude's footer gains/loses a
    // "· ctrl+g to edit in nano" hint depending on which row the ❯ sits on (present on the
    // free-text/Submit/chat rows, absent on the checkbox rows). Since the Submit macro walks the
    // pointer down the dialog, a footer-inclusive signature would mutate mid-macro and read as
    // drift, aborting the submit. The footer is chrome anyway — classifyFooter gates detection.
    signature: coreSignature(texts, stepperIdx, menu[menu.length - 1]!.index, fieldLines),
    regionSignature: texts.slice(stepperIdx, menu[menu.length - 1]!.index + 1).join("\n"),
  };
  if (field !== null) model.field = field;
  return { model, startLine: stepperIdx };
}

/** The review screen. NO footer exists here (like the wizard's Submit step): the buffer tail is the
 *  "❯ 1. Submit answers / 2. Cancel" pair, with "Ready to submit your answers?" just above and the
 *  single-question stepper at the top of the region. */
function detectReviewPhase(
  lines: StyledLine[],
  texts: string[],
  fi: number,
): MultiSelectRegion | null {
  // Tail anchor: the last non-blank line is exactly the Cancel row, the row above it Submit answers.
  // Literal labels — Claude Code generates them (not user content).
  const cancel = parseOptionRow(texts[fi]!);
  if (!cancel || cancel.n !== 2 || cancel.label !== "Cancel") return null;
  let si = fi - 1;
  while (si >= 0 && isBlank(texts[si]!)) si--;
  if (si < 0) return null;
  const submit = parseOptionRow(texts[si]!);
  if (!submit || submit.n !== 1 || submit.label !== "Submit answers") return null;

  // "Ready to submit your answers?" — the nearest non-blank line above the Submit row.
  let ri = -1;
  for (let i = si - 1, seen = 0; i >= 0 && seen < 4; i--, seen++) {
    if (isBlank(texts[i]!)) continue;
    if (READY_PROMPT.test(texts[i]!.trim())) ri = i;
    break; // only the nearest non-blank line may be the prompt
  }
  if (ri < 0) return null;

  // The single-question stepper above the prompt — mutually exclusive with the wizard review (whose
  // ≥3-chip stepper never matches isSingleQuestionStepper).
  const stepperIdx = findSingleStepper(lines, texts, ri - 1, ri - REVIEW_SCAN_WINDOW);
  if (stepperIdx < 0) return null;

  // `incomplete` = a ⚠ "not answered all questions" line sits between the stepper and the prompt.
  let incomplete = false;
  for (let i = stepperIdx + 1; i < ri; i++) {
    if (texts[i]!.trim().startsWith("⚠")) {
      incomplete = true;
      break;
    }
  }

  return {
    model: {
      phase: "review",
      incomplete,
      pointer: null, // digit mode never reads it — review confirms on constant 1/2
      submit: "digit",
      signature: coreSignature(texts, stepperIdx, fi, new Set()),
      regionSignature: texts.slice(stepperIdx, fi + 1).join("\n"),
    },
    startLine: stepperIdx,
  };
}
