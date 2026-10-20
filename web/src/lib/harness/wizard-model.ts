// The WIZARD MODEL — the harness-NEUTRAL payload of a `wizard` Block.
//
// A multi-question dialog driven one keystroke at a time: the stepper chips plus the CURRENT step,
// which is either a question (one digit selects AND advances) or the Submit review. Any adapter can
// produce one; the renderer (components/wizard-block.tsx + wizard-stepper.tsx) and the race guard
// (lib/wizard-action.ts → lib/dialog-guard.ts) are written against these types alone.
//
// Claude's reference detector is harness/claude/wizard.ts; the verified choreography behind the
// incremental round-trip is grammar/WIZARD_NOTES.md. This module imports only the key-plan
// comparator from its sibling prompt model, so `lib/blocks.ts` can re-export it without a cycle. The
// identity comparator below is wired to this kind by dialog-contract.ts.

import { sameOptionalKeys, type AnswerFieldPointer } from "./prompt-model";

/** One question chip in the stepper header (the Submit chip is implicit — see `WizardModel`). */
export interface WizardStepChip {
  /** The chip's visible label, e.g. "Focus area" (a React text node downstream). */
  label: string;
  /** The harness's own mark that this question has an answer (Claude reads a glyph, `☒`/`☑`
   *  answered and `☐` not yet; another harness may read it from the chip's colour). */
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

/**
 * A question step's own answer field (Claude's `Type something.` row, ADR 0113): a text input, never
 * an option. While it has focus every digit is typed into it and `Left` moves its caret, so no option
 * and no step arrow may fire.
 */
export interface WizardAnswerField {
  /** The row's digit: focuses the field while it is empty, ANSWERS with the held text once filled. */
  key: string;
  /** `❯` is on the row: the field has the keyboard. */
  focused: boolean;
  /** What the field holds, `""` while it shows its placeholder; without the trailing ` ✔`. */
  text: string;
  /** The row carries the ` ✔` of a revisited step answered by typing. */
  chosen: boolean;
  /** Where `❯` stands relative to the field. */
  pointer: AnswerFieldPointer;
}

/** One answered pair echoed by the Submit review step. */
export interface WizardAnswer {
  question: string;
  answer: string;
}

/**
 * The detected wizard, a union on `phase`:
 *  - `question`: a question step is on screen — its text + options (answered by ONE digit each).
 *  - `review`: the Submit step — the echoed answers, plus the keys that submit and cancel. A
 *    harness whose review takes other keys declares them (`submitKeys`, `cancelKeys`, and the
 *    terminal's own `cancelLabel`); absent, they fall back to `WIZARD_SUBMIT_KEYS` /
 *    `WIZARD_CANCEL_KEYS` (constants below) and the translated "Cancel", which is Claude's review.
 * Both carry the stepper chips (per-question answered/current state) and a byte-signature of the
 * on-screen region (stepper header → tail): the full dialog state. The race guard compares it so a
 * wizard that re-rendered between render and tap can't pass as the one the user saw. Herdr's
 * `revision` is a stub, so this content signature is the load-bearing freshness check — it MUST be
 * non-empty and MUST change when the region's text changes.
 */
export type WizardModel =
  | {
      phase: "question";
      steps: WizardStepChip[];
      question: string;
      options: WizardOption[];
      /** The step's answer field, when the harness models one. Absent ⇒ the step has none. */
      field?: WizardAnswerField;
      /**
       * The region normalised against what the answer recipe changes on purpose: no `❯`, the field's
       * rows collapsed to one token, the footer's `ctrl+g to edit in …` hint dropped. Absent on a
       * harness that types into no field; `wizardsSameIdentity` then falls back to `wizardsEqual`.
       */
      coreSignature?: string;
      signature: string;
    }
  | {
      phase: "review";
      steps: WizardStepChip[];
      answers: WizardAnswer[];
      incomplete: boolean;
      /** The submit plan; absent ⇒ `WIZARD_SUBMIT_KEYS`. Compared exactly by `wizardsEqual`. */
      submitKeys?: string[];
      /** The cancel plan; absent ⇒ `WIZARD_CANCEL_KEYS`. Compared exactly by `wizardsEqual`. */
      cancelKeys?: string[];
      /** The terminal's own words for cancel (opencode's `dismiss` ends the turn); absent ⇒ the
       *  translated "Cancel". Compared by `wizardsEqual`. */
      cancelLabel?: string;
      signature: string;
    };

/** Keys for the review step's two fixed controls (digit fires instantly there too — verified). */
export const WIZARD_SUBMIT_KEYS = ["1"];
export const WIZARD_CANCEL_KEYS = ["2"];
/** Keys for step navigation (Left/Right clamp at the ends — no wraparound). Shared with the
 *  preview and multi-select steps, whose wizard nav is the same two keys. */
export const WIZARD_BACK_KEYS = ["Left"];
export const WIZARD_NEXT_KEYS = ["Right"];

/**
 * Whether two derivations are the same step of the same dialog. Field-by-field over the
 * discriminated union: the stepper chips (labels + answered + current), then the phase payload —
 * question text + option labels/chosen for a question step, answers + incompleteness for the
 * review. A question's keys/descriptions are derived from the same rows, so they can't differ
 * independently; the review's declared plans and cancel label are not on screen, so they are
 * compared explicitly (a changed plan would send a key the button did not advertise).
 *
 * Part of the CONTRACT, not of any harness: the race guard (lib/dialog-guard.ts) compares whatever
 * adapter produced the block through exactly this function.
 */
export function wizardsEqual(a: WizardModel, b: WizardModel): boolean {
  if (a.phase !== b.phase) return false;
  // The region signature is decisive (a re-rendered wizard changes it); the field checks below stay
  // as a fast-path and to keep intent explicit. `revision` is a stub, so this is the real guard.
  if (a.signature !== b.signature) return false;
  if (!sameSteps(a.steps, b.steps)) return false;
  if (a.phase === "question" && b.phase === "question") return sameQuestion(a, b);
  if (a.phase === "review" && b.phase === "review") {
    return (
      a.incomplete === b.incomplete &&
      sameOptionalKeys(a.submitKeys, b.submitKeys) &&
      sameOptionalKeys(a.cancelKeys, b.cancelKeys) &&
      a.cancelLabel === b.cancelLabel &&
      a.answers.length === b.answers.length &&
      a.answers.every(
        (qa, i) => qa.question === b.answers[i]!.question && qa.answer === b.answers[i]!.answer,
      )
    );
  }
  return false;
}

type QuestionStep = Extract<WizardModel, { phase: "question" }>;

/** The stepper chips agree: labels, answered marks and the current chip. */
function sameSteps(a: WizardStepChip[], b: WizardStepChip[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => s.label === b[i]!.label && s.answered === b[i]!.answered && s.current === b[i]!.current)
  );
}

/** The question text and every option's label and chosen mark agree. */
function sameQuestion(a: QuestionStep, b: QuestionStep): boolean {
  return (
    a.question === b.question &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o.label === b.options[i]!.label && o.chosen === b.options[i]!.chosen)
  );
}

/**
 * Whether two derivations are the same question step of the same dialog, whatever the answer recipe
 * (lib/answer-field.ts) has done to its field: the pointer, the field's text, its focus and its ` ✔`
 * all change under the recipe on purpose, so they are not compared. Everything else is: the chips,
 * the question, the options, the field's digit and `coreSignature`, the region with those changes
 * normalised away. A different question in the same shape still breaks it.
 *
 * Only when BOTH models are question steps carrying a `coreSignature`. Anything else (the review
 * step, a harness that models no field) compares exactly as `wizardsEqual` does.
 */
export function wizardsSameIdentity(a: WizardModel, b: WizardModel): boolean {
  if (a.phase !== "question" || b.phase !== "question") return wizardsEqual(a, b);
  if (a.coreSignature === undefined || b.coreSignature === undefined) return wizardsEqual(a, b);
  return (
    a.coreSignature === b.coreSignature &&
    sameSteps(a.steps, b.steps) &&
    sameQuestion(a, b) &&
    a.field?.key === b.field?.key
  );
}
