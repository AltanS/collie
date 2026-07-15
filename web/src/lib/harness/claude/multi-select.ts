// Multi-select AskUserQuestion detection — the grammar that recognises Claude Code's `multiSelect`
// dialog (the CHECKBOX form of AskUserQuestion) at the TAIL of a pane buffer and lifts the current
// screen into a `MultiSelectModel` the UI renders natively. Two phases mirror the wizard's structure:
//
//   - `checkbox`: numbered rows carry a `[ ]`/`[✔]` checkbox prefix (THE discriminator vs a single
//     select), a navigable `Submit` row sits below them, and a single-question stepper
//     (`←  ☐ Toppings  ✔ Submit  →` — exactly ONE question chip + the Submit chip) anchors the top.
//     A digit N TOGGLES option N on/off (pointer-independent); Enter activates the POINTED row.
//   - `review`: activating Submit advances here — `Ready to submit your answers?` over
//     `❯ 1. Submit answers` / `2. Cancel`, with the same single-question stepper. Digit 1 submits,
//     2 cancels; a `⚠ …not answered all questions` line means `incomplete`.
//
// This shape currently falls to the raw mirror because prompt-select bails on the multi-step glyph
// and wizard bails on its ≥3-chip stepper requirement — so this detector adds a new surface rather
// than re-arbitrating an existing one. Everything here is PURE over `StyledLine[]`, fixture-driven
// (web/src/fixtures/panes/claude--select-multiselect-*.txt), and never touches a pane or the network.

import type { StyledLine } from "../../blocks";
import { classifyFooter, isBlank, isHorizontalRule, lineText } from "./markers";
import { checkboxState, isFreeTextLabel, parseOptionRow, trailingMenuRows } from "./prompt-select";

/** One checkable option of the current checkbox question. */
export interface MultiSelectOption {
  /** The option's digit — pressing it TOGGLES this row (pointer-independent). */
  n: number;
  /** The visible label with the `[ ]`/`[✔]` prefix stripped (a React text node downstream). */
  label: string;
  /** Secondary descriptive line(s), joined with spaces. Absent when none. */
  description?: string;
  /** Lifted from the checkbox glyph: `[✔]`/`[x]`/`[✓]` = checked, `[ ]` = unchecked. The terminal is
   *  the single source of truth (a digit is an XOR — the UI never holds its own checked state). */
  checked: boolean;
}

/** The unnumbered-in-spirit "Chat about this" escape (it carries a digit, but ABORTS the tool). */
export interface MultiSelectEscape {
  n: number;
  label: string;
}

/** Which KIND of row the `❯` pointer sits on — the Submit macro drives it to `submit` before Enter.
 *  Parsed SEPARATELY from the signature (which normalises the pointer out), so the macro's own
 *  Down/Up moves don't perturb the race-guard identity. */
export type MultiPointer = "submit" | "chat" | "option" | "other" | null;

/**
 * The detected multi-select dialog, a union on `phase`:
 *  - `checkbox`: the question + its checkable options, the "Chat about this" escape, and where the
 *    pointer sits. A digit toggles; Submit advances (closed-loop macro — see multi-select-action.ts).
 *  - `review`: the confirm screen — submit = key `1`, cancel = key `2` (constants, off the model).
 *
 * `signature` is a byte-signature of the on-screen region (stepper → tail) with BOTH the `❯` pointer
 * AND each `[✔]`/`[ ]` checkbox glyph normalised out: it captures the subject + labels only, so the
 * Submit macro's pointer moves and a checkbox flip don't spuriously fail the race guard. The transient
 * state (pointer, checked) is compared separately by multiSelectEquals via the options[]. Herdr's
 * `revision` is a stub, so this content signature is the load-bearing freshness check (mirrors the
 * sibling grammars' `signature`/`coreSignature`).
 */
export type MultiSelectModel =
  | {
      phase: "checkbox";
      question: string;
      options: MultiSelectOption[];
      escape: MultiSelectEscape | null;
      pointer: MultiPointer;
      signature: string;
    }
  | {
      phase: "review";
      incomplete: boolean;
      signature: string;
    };

/** Detection result for buildBlocks: the model plus the region's first line — the multi-select
 *  region is [`startLine` … tail], which the renderer replaces with the native block. */
export interface MultiSelectRegion {
  model: MultiSelectModel;
  startLine: number;
}

// Same bounded-window philosophy as the sibling grammars: options sit against the footer; the
// single-question stepper sits a few lines above the first option.
const OPTION_SCAN_WINDOW = 24;
const MAX_FOOTER_GAP = 3;
const STEPPER_SCAN_LIMIT = 10;
// The review screen lists its prompt + warning between the stepper and the submit rows, so the
// upward window from the "Ready…" prompt to the stepper is more generous.
const REVIEW_SCAN_WINDOW = 48;

const CHAT_ESCAPE = /^chat about this\b/i;
// The navigable Submit row (no digit — Enter activates it), possibly carrying the pointer.
const SUBMIT_ROW = /^❯?\s*Submit$/;
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

/** Scan upward from `start` down to `floor` for the single-question stepper, stopping at a horizontal
 *  rule (the dialog border — the stepper always sits below it). Returns its line index, or -1. */
function findSingleStepper(
  lines: StyledLine[],
  texts: string[],
  start: number,
  floor: number,
): number {
  for (let i = start; i >= 0 && i >= floor; i--) {
    if (isHorizontalRule(texts[i]!)) return -1;
    if (isSingleQuestionStepper(lines[i]!)) return i;
  }
  return -1;
}

/** The region's pointer/checkbox-independent signature: lines [`from` … `to`] with the `❯` pointer,
 *  every `[✔]`/`[ ]` option checkbox, and the stepper's answered chip glyph (`☒`/`☑`→`☐`) normalised
 *  out — so it captures the SUBJECT + labels only, stable across the whole toggle + Submit-macro
 *  choreography (the pointer moves, boxes flip). The transient state (pointer, checked) is compared
 *  SEPARATELY by multiSelectEquals via the options[]. Pure of the buffer's absolute offset, so the
 *  frozen model and a fresh re-derivation of the SAME dialog produce byte-equal strings. */
function coreSignature(texts: string[], from: number, to: number): string {
  return texts
    .slice(from, to + 1)
    .map((t) =>
      t
        .replace(/❯/g, " ")
        .replace(/\[[ xX✔✓]\]/g, "[ ]")
        .replace(/[☒☑]/g, "☐"),
    )
    .join("\n");
}

/** Classify which row the `❯` pointer sits on across [`from` … `to`] (raw line text — the pointer is
 *  a leading glyph). `null` when no row carries it. */
function pointerAt(texts: string[], from: number, to: number): MultiPointer {
  for (let i = from; i <= to; i++) {
    if (!/^\s*❯/.test(texts[i]!)) continue;
    const trimmed = texts[i]!.trim();
    if (SUBMIT_ROW.test(trimmed)) return "submit";
    const parsed = parseOptionRow(trimmed);
    if (!parsed) return "other";
    if (CHAT_ESCAPE.test(parsed.label)) return "chat";
    const cb = checkboxState(parsed.label);
    if (cb && !isFreeTextLabel(cb.rest)) return "option";
    return "other"; // the free-text "Type something" row, or an unrecognised pointed row
  }
  return null;
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
  if (classifyFooter(texts[fi]!) !== "select") return null;

  // Numbered rows near the footer — the trailing 1,2,…,m run (the checkbox options + the numbered
  // "Chat about this" escape); a numbered body above it drops out (same hazard as prompt-select).
  const from = Math.max(0, fi - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i < fi; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed) rows.push({ index: i, ...parsed });
  }
  if (rows.length < 2) return null;
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null;
  if (menu.length > 9) return null; // a row ≥10 needs the unsendable digit "10"
  const firstOpt = menu[0]!.index;
  if (fi - menu[menu.length - 1]!.index > MAX_FOOTER_GAP) return null;

  // The screen MUST carry a navigable "Submit" row (Enter on it advances to review). The Submit macro
  // walks the pointer ONTO that row before it ever Enters; if the row is absent (a partial / garbled
  // render), fail closed to the raw mirror rather than lift a dialog whose Submit the macro would hunt
  // for by typing nav keys into the live pane. (The `✔ Submit` stepper CHIP is not this row —
  // SUBMIT_ROW anchors the whole line, so the chip never satisfies it.)
  if (!texts.slice(firstOpt, fi).some((t) => SUBMIT_ROW.test(t.trim()))) return null;

  const stepperIdx = findSingleStepper(lines, texts, firstOpt - 1, firstOpt - STEPPER_SCAN_LIMIT);
  if (stepperIdx < 0) return null;

  // The question: every non-blank line between the stepper and the first option, joined.
  const questionLines: string[] = [];
  for (let i = stepperIdx + 1; i < firstOpt; i++) {
    if (!isBlank(texts[i]!)) questionLines.push(texts[i]!.trim());
  }
  if (questionLines.length === 0) return null;
  const question = questionLines.join(" ");

  // Options: strip the checkbox prefix, lift `checked`, attach description sub-lines. "Chat about
  // this" is captured as the escape; "Type something" stays with the composer. EVERY non-escape row
  // must carry the checkbox prefix — a row without one means this is a single select, not multiSelect.
  const options: MultiSelectOption[] = [];
  let escape: MultiSelectEscape | null = null;
  for (let r = 0; r < menu.length; r++) {
    const row = menu[r]!;
    if (CHAT_ESCAPE.test(row.label)) {
      escape = { n: row.n, label: row.label };
      continue;
    }
    const cb = checkboxState(row.label);
    if (!cb) return null; // the checkbox-prefix discriminator: bail to the single-select grammar
    if (isFreeTextLabel(cb.rest)) continue;
    const nextIdx = r + 1 < menu.length ? menu[r + 1]!.index : fi;
    const desc: string[] = [];
    for (let i = row.index + 1; i < nextIdx; i++) {
      const t = texts[i]!;
      if (isBlank(t) || isHorizontalRule(t) || parseOptionRow(t) || SUBMIT_ROW.test(t.trim())) continue;
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

  return {
    model: {
      phase: "checkbox",
      question,
      options,
      escape,
      pointer: pointerAt(texts, firstOpt, fi),
      // Signature ends at the LAST menu row, NOT the footer: Claude's footer gains/loses a
      // "· ctrl+g to edit in nano" hint depending on which row the ❯ sits on (present on the
      // free-text/Submit/chat rows, absent on the checkbox rows). Since the Submit macro walks the
      // pointer down the dialog, a footer-inclusive signature would mutate mid-macro and read as
      // drift, aborting the submit. The footer is chrome anyway — classifyFooter gates detection.
      signature: coreSignature(texts, stepperIdx, menu[menu.length - 1]!.index),
    },
    startLine: stepperIdx,
  };
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
    model: { phase: "review", incomplete, signature: coreSignature(texts, stepperIdx, fi) },
    startLine: stepperIdx,
  };
}
