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

import type { StyledLine } from "../blocks";
import { classifyFooter, isBlank, isHorizontalRule, lineText } from "./markers";
import { isFreeTextLabel, parseOptionRow } from "./prompt-select";

/** One question chip in the stepper header (the Submit chip is implicit — see `WizardModel`). */
export interface WizardStepChip {
  /** The chip's visible label, e.g. "Focus area" (a React text node downstream). */
  label: string;
  /** From the glyph: `☒`/`☑` answered, `☐` not yet. */
  answered: boolean;
  /** This chip carries the background-highlight (the step currently on screen). At most one chip
   *  is current; on the review step NONE is (the highlight sits on the Submit chip). */
  current: boolean;
}

/** One selectable option of the CURRENT question. */
export interface WizardOption {
  label: string;
  /** Secondary descriptive line(s), joined with spaces. Absent when none. */
  description?: string;
  /** Keys to send: the option's digit ALONE — a wizard digit instant-selects and advances
   *  (verified; unlike the single-question select's digit-THEN-Enter). */
  keys: string[];
  /** The TUI's trailing ` ✔` on a revisited, already-answered question's chosen row. */
  chosen: boolean;
  /** "Chat about this" — ABORTS the whole wizard (the tool call resolves "declined"). Rendered as
   *  a de-emphasised escape row, never as a normal answer. */
  escape: boolean;
}

/** One answered pair echoed by the Submit review step. */
export interface WizardAnswer {
  question: string;
  answer: string;
}

/**
 * The detected wizard, a union on `phase`:
 *  - `question`: a question step is on screen — its text + options (answered by ONE digit each).
 *  - `review`: the Submit step — the echoed answers; submit = key `1`, cancel = key `2`
 *    (constants, so the model doesn't carry them).
 * Both carry the stepper chips (per-question answered/current state).
 */
export type WizardModel =
  | { phase: "question"; steps: WizardStepChip[]; question: string; options: WizardOption[] }
  | { phase: "review"; steps: WizardStepChip[]; answers: WizardAnswer[]; incomplete: boolean };

/** Detection result for buildBlocks: the model plus the stepper header's line index — the wizard
 *  region is [`startLine` … tail], which the renderer replaces with the native wizard. */
export interface WizardRegion {
  model: WizardModel;
  startLine: number;
}

/** Keys for the review step's two fixed controls (digit fires instantly there too — verified). */
export const WIZARD_SUBMIT_KEYS = ["1"];
export const WIZARD_CANCEL_KEYS = ["2"];
/** Keys for step navigation (Left/Right clamp at the ends — no wraparound). */
export const WIZARD_BACK_KEYS = ["Left"];
export const WIZARD_NEXT_KEYS = ["Right"];

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

// Same bounded windows philosophy as prompt-select: options sit against the footer; the stepper
// sits a few lines above the first option (blank + question lines between).
const OPTION_SCAN_WINDOW = 24;
const MAX_FOOTER_GAP = 3;
const STEPPER_SCAN_LIMIT = 10;
// The review step lists every answered question (2–3 lines each) between the stepper and the
// submit rows, so its upward window is more generous.
const REVIEW_SCAN_WINDOW = 48;

const CHAT_ESCAPE = /^chat about this\b/i;
/** The chosen-row marker a revisited answered question shows: "2. UI ✔". */
const CHOSEN_SUFFIX = /\s*✔\s*$/;

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
  if (classifyFooter(texts[fi]!) !== "select") return null;

  // Numbered rows 1..k in order, near the footer (same shape as the single-question menu).
  const from = Math.max(0, fi - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i < fi; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed) rows.push({ index: i, ...parsed });
  }
  if (rows.length < 2) return null;
  if (rows.some((r, k) => r.n !== k + 1)) return null;
  const firstOpt = rows[0]!.index;
  if (fi - rows[rows.length - 1]!.index > MAX_FOOTER_GAP) return null;

  // The stepper header above the first option — THE wizard discriminator. Stop at a horizontal
  // rule (the dialog's top border) so the scan can't wander into scrollback.
  const found = findStepper(lines, texts, firstOpt - 1, firstOpt - STEPPER_SCAN_LIMIT);
  if (!found) return null;
  const { stepper, index: stepperIdx } = found;

  // The question: every non-blank line between the stepper and the first option, joined (long
  // questions wrap). There is always at least one.
  const questionLines: string[] = [];
  for (let i = stepperIdx + 1; i < firstOpt; i++) {
    if (!isBlank(texts[i]!)) questionLines.push(texts[i]!.trim());
  }
  if (questionLines.length === 0) return null;
  const question = questionLines.join(" ");

  // Options: description sub-lines attach like prompt-select's; free-text rows ("Type something.")
  // stay with the composer; "Chat about this" is kept but flagged — it aborts the whole wizard.
  const options: WizardOption[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (isFreeTextLabel(row.label)) continue;
    const nextIdx = r + 1 < rows.length ? rows[r + 1]!.index : fi;
    const desc: string[] = [];
    for (let i = row.index + 1; i < nextIdx; i++) {
      const t = texts[i]!;
      if (isBlank(t) || isHorizontalRule(t) || parseOptionRow(t)) continue;
      desc.push(t.trim());
    }
    const chosen = CHOSEN_SUFFIX.test(row.label);
    const label = row.label.replace(CHOSEN_SUFFIX, "");
    options.push({
      label,
      description: desc.length ? desc.join(" ") : undefined,
      keys: [String(row.n)],
      chosen,
      escape: CHAT_ESCAPE.test(label),
    });
  }
  if (options.length === 0) return null;

  return {
    model: { phase: "question", steps: stepper.chips, question, options },
    startLine: stepperIdx,
  };
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
  // "→ <answer>" row; other non-blank lines continue whichever field is open (wrapped text). The
  // "Review your answers" heading and the ⚠ warning are recognised and skipped.
  const answers: WizardAnswer[] = [];
  let incomplete = false;
  let open: { question: string; answer: string | null } | null = null;
  const flush = () => {
    if (open && open.answer !== null) answers.push({ question: open.question, answer: open.answer });
    open = null;
  };
  for (let i = stepperIdx + 1; i < ri; i++) {
    const t = texts[i]!.trim();
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
    model: { phase: "review", steps: stepper.chips, answers, incomplete },
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
    if (isHorizontalRule(texts[i]!)) return null;
    const stepper = parseStepperLine(lines[i]!);
    if (stepper) return { stepper, index: i };
  }
  return null;
}
