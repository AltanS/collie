// The wizard tap: one guarded keystroke against the step currently on screen, or an answer typed into
// the step's own field.
//
// A thin wrapper over the generic race guard (lib/dialog-guard.ts). Under the INCREMENTAL round-trip
// model (grammar/WIZARD_NOTES.md) every tap — an option digit, Left/Right navigation, the review
// step's submit/cancel — is ONE keystroke against the step that is there right now, which is exactly
// what makes the guard's re-derivation load-bearing: a wizard that advanced, re-rendered, or vanished
// between render and tap can never match `wizardsEqual` (harness/wizard-model.ts), so the keystroke
// is discarded and the caller refreshes.
//
// The typed answer (ADR 0113) is the shared recipe (lib/answer-field.ts) plus one bound `Enter`,
// which answers the step and advances it; the next poll renders the next step.

import { fillAnswerField, type FieldAccess } from "./answer-field";
import { type WizardModel } from "./blocks";
import { sendBoundKeys, sendGuardedKeys } from "./dialog-guard";
import { DIALOG_CONTRACT } from "./harness/dialog-contract";
import type { Sleep } from "./harness/guard";
import { wizardsSameIdentity } from "./harness/wizard-model";
import type { PromptActionResult } from "./prompt-action";
import type { Scope } from "./scope";

/** The wizard identity comparator, part of the neutral contract (harness/wizard-model.ts).
 *  Re-exported under its original name so existing call sites and tests keep one import site. */
export { wizardsEqual } from "./harness/wizard-model";

interface WizardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered wizard was detected against. */
  detectedRevision: number;
  wizard: WizardModel;
  /** Which machine + which named session the pane lives in — scopes the read + keystroke. */
  scope?: Scope;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
}

/**
 * Run the race guard and, if it passes, send `keys` (one wizard keystroke: an option digit,
 * Left/Right, or the review step's submit/cancel plan, 1/2 unless the model declares its own). Pure of
 * any UI — the caller maps the result to a status message and a revalidation. Result shape shared with
 * prompt-action so AgentChat handles both through one code path.
 *
 * Refuses outright while the step's answer field has FOCUS: the terminal then types every digit into
 * the field and moves its caret on `Left`/`Right`, so the keystroke would edit someone's answer
 * instead of choosing or stepping. This is NOT a duplicate of the card's lock: the race guard verifies
 * SAMENESS, and a model captured while focused compares equal to a fresh screen that is still focused,
 * so the key would go out. The card's lock is UX; this is the invariant. Don't remove it as redundant.
 */
export async function submitWizardKeys(args: WizardArgs & { keys: string[] }): Promise<PromptActionResult> {
  if (args.wizard.phase === "question" && args.wizard.field?.focused) return { status: "changed" };
  return sendGuardedKeys({ ...args, kind: "wizard", model: args.wizard }, args.keys);
}

/** How the answer recipe reads a wizard step: its `field`, against the step the person tapped. */
function wizardFieldAccess(tapped: WizardModel): FieldAccess<"wizard"> {
  return {
    fieldOf: (m) => {
      if (m.phase !== "question" || m.field === undefined) return null;
      const { key, focused, text, pointer } = m.field;
      return { key, focused, text, pointer };
    },
    sameDialog: (m) => wizardsSameIdentity(m, tapped),
    digitFocuses: true,
  };
}

/**
 * Answer the step in the person's own words (ADR 0113): the shared recipe (lib/answer-field.ts)
 * reaches the field, clears what the person saw in it, types `text` and proves it arrived; then
 * `Enter`, which answers the step and advances, bound to the read that proved the text. A keystroke at
 * the terminal after that read makes the bridge refuse rather than answer with something else.
 */
export async function submitWizardAnswer(
  args: WizardArgs & { text: string; sleep?: Sleep },
): Promise<PromptActionResult> {
  const filled = await fillAnswerField({ ...args, kind: "wizard", model: args.wizard }, wizardFieldAccess(args.wizard), args.text);
  if (!filled.ok) return filled.result;
  const commit = await sendBoundKeys(args, ["Enter"], DIALOG_CONTRACT.wizard.region(filled.proof));
  return commit.status === "changed" ? { status: "changed", why: commit.why ?? "bridge" } : commit;
}
