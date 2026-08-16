// The wizard tap: one guarded keystroke against the step currently on screen.
//
// A thin wrapper over the generic race guard (lib/dialog-guard.ts). Under the INCREMENTAL round-trip
// model (grammar/WIZARD_NOTES.md) every tap — an option digit, Left/Right navigation, the review
// step's submit/cancel — is ONE keystroke against the step that is there right now, which is exactly
// what makes the guard's re-derivation load-bearing: a wizard that advanced, re-rendered, or vanished
// between render and tap can never match `wizardsEqual` (harness/wizard-model.ts), so the keystroke
// is discarded and the caller refreshes.

import { type WizardModel } from "./blocks";
import { sendGuardedKeys } from "./dialog-guard";
import type { PromptActionResult } from "./prompt-action";

/** The wizard identity comparator, part of the neutral contract (harness/wizard-model.ts).
 *  Re-exported under its original name so existing call sites and tests keep one import site. */
export { wizardsEqual } from "./harness/wizard-model";

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
  /** The session the pane lives in (undefined = primary) — scopes the read + keystroke. */
  session?: string;
  /** Live pane-write permission, rechecked after the freshness guard and before the send. */
  canWrite: () => boolean;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
}): Promise<PromptActionResult> {
  return sendGuardedKeys({ ...args, kind: "wizard", model: args.wizard }, args.keys);
}
