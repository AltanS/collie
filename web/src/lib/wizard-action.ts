// The wizard race guard — prompt-action's philosophy applied to the multi-question wizard. Every
// wizard tap (an option digit, Left/Right navigation, the review step's submit/cancel) types into
// a REAL terminal, and under the INCREMENTAL round-trip model (WIZARD_NOTES.md) each tap is one
// keystroke against the step currently on screen — so before sending we re-fetch the pane and
// confirm the wizard the user tapped is still the wizard that's there:
//
//   1. A FRESH pane read for the same window.
//   2. The fresh `revision` must equal the one the wizard was detected against — unconditionally
//      (the 304 path's cache advances with polls while a frozen mirror stands still; see
//      prompt-action.ts for the full rationale).
//   3. The fresh buffer must re-derive to an EQUAL wizard (phase, chips, question/options or
//      answers). Herdr 0.7.x's revision is empirically a stub (always 0), so this re-derivation is
//      the load-bearing check — and it is exactly what makes single-keystroke taps safe: a wizard
//      that advanced, re-rendered, or vanished between render and tap can never match.
//
// A failed guard discards the tap and reports "changed" so the caller can refresh the mirror.

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type WizardModel } from "./blocks";
import { detectWizard } from "./grammar/wizard";
import type { PromptActionResult } from "./prompt-action";

/**
 * Whether two detected wizards are the same step of the same dialog. Field-by-field over the
 * discriminated union: the stepper chips (labels + answered + current), then the phase payload —
 * question text + option labels/chosen for a question step, answers + incompleteness for the
 * review. Keys/descriptions are derived from the same rows, so they can't differ independently.
 */
export function wizardsEqual(a: WizardModel, b: WizardModel): boolean {
  if (a.phase !== b.phase) return false;
  // The region signature is decisive (a re-rendered wizard changes it); the field checks below stay
  // as a fast-path and to keep intent explicit. `revision` is a stub, so this is the real guard.
  if (a.signature !== b.signature) return false;
  if (
    a.steps.length !== b.steps.length ||
    !a.steps.every(
      (s, i) =>
        s.label === b.steps[i]!.label &&
        s.answered === b.steps[i]!.answered &&
        s.current === b.steps[i]!.current,
    )
  ) {
    return false;
  }
  if (a.phase === "question" && b.phase === "question") {
    return (
      a.question === b.question &&
      a.options.length === b.options.length &&
      a.options.every(
        (o, i) => o.label === b.options[i]!.label && o.chosen === b.options[i]!.chosen,
      )
    );
  }
  if (a.phase === "review" && b.phase === "review") {
    return (
      a.incomplete === b.incomplete &&
      a.answers.length === b.answers.length &&
      a.answers.every(
        (qa, i) => qa.question === b.answers[i]!.question && qa.answer === b.answers[i]!.answer,
      )
    );
  }
  return false;
}

/**
 * Run the race guard and, if it passes, send `keys` (one wizard keystroke: an option digit,
 * Left/Right, or the review step's 1/2). Pure of any UI — the caller maps the result to a status
 * message and a revalidation. Result shape shared with prompt-action so AgentChat handles both
 * through one code path.
 */
export async function submitWizardKeys(args: {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered wizard was detected against. */
  detectedRevision: number;
  wizard: WizardModel;
  keys: string[];
}): Promise<PromptActionResult> {
  const { paneId, requestedLines, detectedRevision, wizard, keys } = args;

  let fresh;
  try {
    fresh = await fetchPane(paneId, requestedLines);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  if (fresh.revision !== detectedRevision) return { status: "changed" };
  const freshModel = detectWizard(splitLines(parseAnsi(fresh.text)));
  if (!freshModel || !wizardsEqual(freshModel, wizard)) return { status: "changed" };

  try {
    const res = await sendKeys(paneId, keys);
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
