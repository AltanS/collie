// The prompt-select tap: one guarded keystroke plan.
//
// A thin wrapper over the generic race guard (lib/dialog-guard.ts) — a fresh pane read, the
// unconditional revision check, and a re-derivation through the pane's own ADAPTER compared against
// what the user tapped (`promptsEqual`, the contract comparator in harness/prompt-model.ts). Only
// then do the option's keys go out, bound to the verified region. A failed guard discards the tap and
// reports "changed" so the caller can surface a "menu changed" notice.
//
// It exists as its own module for the call site's sake: AgentChat dispatches per block kind, and the
// name says which. The choreography itself is no longer per-kind.

import { type PromptModel, type PromptOption } from "./blocks";
import { sendGuardedKeys } from "./dialog-guard";
import type { ActionResult } from "./harness/guard";

/** The prompt-select identity comparator, part of the neutral contract (harness/prompt-model.ts).
 *  Re-exported under its original name so existing call sites and tests keep one import site. */
export { promptsEqual, sameKeys } from "./harness/prompt-model";

/** The guarded-action result union, canonical in `harness/guard.ts`; re-exported under the original
 *  name so existing imports (wizard-action, AgentChat, tests) keep working. */
export type PromptActionResult = ActionResult;

/**
 * Run the race guard and, if it passes, send `option.keys`. Pure of any UI — the caller maps the
 * result to a status message and a revalidation.
 */
export async function submitPromptOption(args: {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered menu was detected against. */
  detectedRevision: number;
  prompt: PromptModel;
  option: PromptOption;
  /** The session the pane lives in (undefined = primary) — scopes the read + keystroke. */
  session?: string;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
}): Promise<PromptActionResult> {
  return sendGuardedKeys({ ...args, kind: "prompt-select", model: args.prompt }, args.option.keys);
}
