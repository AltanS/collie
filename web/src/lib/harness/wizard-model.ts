// The WIZARD MODEL — the harness-NEUTRAL payload of a `wizard` Block.
//
// A multi-question dialog driven one keystroke at a time: the stepper chips plus the CURRENT step,
// which is either a question (one digit selects AND advances) or the Submit review. Any adapter can
// produce one; the renderer (components/wizard-block.tsx + wizard-stepper.tsx) and the race guard
// (lib/wizard-action.ts → lib/dialog-guard.ts) are written against these types alone.
//
// Claude's reference detector is harness/claude/wizard.ts; the verified choreography behind the
// incremental round-trip is grammar/WIZARD_NOTES.md. This module imports nothing, so `lib/blocks.ts`
// can re-export it without a cycle. The identity comparator lives in dialog-contract.ts.

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
 *  - `review`: the Submit step — the echoed answers; submit = `WIZARD_SUBMIT_KEYS`, cancel =
 *    `WIZARD_CANCEL_KEYS` (constants below, so the model doesn't carry them).
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
      signature: string;
    }
  | {
      phase: "review";
      steps: WizardStepChip[];
      answers: WizardAnswer[];
      incomplete: boolean;
      signature: string;
    };

/** Keys for the review step's two fixed controls (digit fires instantly there too — verified). */
export const WIZARD_SUBMIT_KEYS = ["1"];
export const WIZARD_CANCEL_KEYS = ["2"];
/** Keys for step navigation (Left/Right clamp at the ends — no wraparound). Shared with the
 *  preview and multi-select steps, whose wizard nav is the same two keys. */
export const WIZARD_BACK_KEYS = ["Left"];
export const WIZARD_NEXT_KEYS = ["Right"];
