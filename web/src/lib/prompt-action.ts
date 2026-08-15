// The prompt-select action recipes — the generic race guard (lib/dialog-guard.ts) plus, for the one
// dialog that carries an inline text input, the extra verified steps its MULTI-step choreography
// needs (grammar/PLAN_FEEDBACK_NOTES.md):
//
//   - Answering an option is the digit alone (or digit+Enter for the `select` family): one guarded
//     write, nothing to sequence.
//   - Sending FEEDBACK on a plan is the input row's digit → verify the field focused → type → Enter.
//     The digit does not answer anything; it moves `❯` onto the row and focuses the field, after
//     which the dialog routes every keystroke into the box as text. Enter then submits the box as
//     DENY-WITH-FEEDBACK: the plan is rejected, the agent is handed the text and re-plans. That Enter
//     is irreversible and it is the LAST thing sent, only after a fresh read shows our own words in
//     the box — the same "never submit blind" rule as reply-action and submitPreviewNote.
//
// Both flows start with the same guard as their siblings: a FRESH pane read, the unconditional
// revision check, and a re-derivation THROUGH THE PANE'S ADAPTER compared against what the user
// tapped. The mid-flight polls re-derive the same way, against `promptsSameIdentity` — the feedback
// flow moves the pointer and fills the input by design, so `promptsEqual` would reject its own work.

import { sendKeys, sendReply } from "./api";
import { type PromptModel, type PromptOption } from "./blocks";
import { guardDialog, pollDialog, sendGuardedKeys, type DialogTarget } from "./dialog-guard";
import { promptsSameIdentity } from "./harness/prompt-model";
import { sanitizeTypedText, type ActionResult, type Sleep } from "./harness/guard";

/** The prompt-select identity comparators, part of the neutral contract (harness/prompt-model.ts).
 *  Re-exported under their original names so existing call sites and tests keep one import site. */
export { promptsEqual, promptsSameIdentity, sameKeys } from "./harness/prompt-model";

/** The guarded-action result union, canonical in `harness/guard.ts`; re-exported under the original
 *  name so existing imports (wizard-action, AgentChat, tests) keep working. */
export type PromptActionResult = ActionResult;

/**
 * Longest feedback Collie will type into a plan dialog. The box is a single visible row that windows
 * long text around the caret, so the verification below can only ever read back its TAIL — keep what
 * we type short enough to stay reviewable on a phone before it is submitted irreversibly.
 */
export const FEEDBACK_MAX_LENGTH = 500;

interface GuardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered menu was detected against. */
  detectedRevision: number;
  prompt: PromptModel;
  /** The session the pane lives in (undefined = primary) — scopes the read + keystroke. */
  session?: string;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
  /** Test seam for the verification polls' pacing. */
  sleep?: Sleep;
}

/** This module's slice of the generic guard: the prompt dialog the tap is aimed at. */
function target(args: GuardArgs): DialogTarget<"prompt-select"> & { sleep?: Sleep } {
  return { ...args, kind: "prompt-select", model: args.prompt };
}

/**
 * Run the race guard and, if it passes, send `option.keys`. Pure of any UI — the caller maps the
 * result to a status message and a revalidation.
 *
 * Refuses outright while the dialog's own input row has FOCUS: the terminal then swallows every digit
 * as a character, so the keystroke would silently type into someone's half-written sentence instead
 * of answering (issue #95). The renderer already locks the buttons in that state; this is the second
 * half of the same rule, at the layer that actually writes.
 */
export async function submitPromptOption(
  args: GuardArgs & { option: PromptOption },
): Promise<PromptActionResult> {
  if (args.prompt.feedback?.focused) return { status: "changed" };
  return sendGuardedKeys({ ...args, kind: "prompt-select", model: args.prompt }, args.option.keys);
}

/**
 * Deny the plan WITH feedback: entry guard → the input row's digit → poll until the field is
 * verifiably focused → type via the reply path (one paste; immune to the per-key focus race) → poll
 * until our own words are visibly in the box → Enter.
 *
 * Refused before anything is sent unless the box is EMPTY and unfocused. Two different hazards:
 *   - focused already — someone at the terminal is typing in it right now;
 *   - non-empty — re-entering the field puts the caret at position 0 (measured), so our text would be
 *     PREPENDED to theirs and the Enter would submit the pair as one garbled sentence. Backspace at
 *     position 0 is a no-op, so there is no safe clear from here either. The phone waits instead.
 *
 * If focus never lands, nothing has been typed and nothing is submitted — the digit's pointer move is
 * the only side effect, and `Up` (from the keys pad, or the terminal) undoes it. If the text never
 * lands, NO Enter is sent: the words sit unsubmitted in the box for a human to finish or discard,
 * which is the same bargain reply-action's `stalled` strikes.
 */
export async function submitPromptFeedback(
  args: GuardArgs & { text: string },
): Promise<PromptActionResult> {
  const row = args.prompt.feedback;
  if (!row || row.focused || row.text !== "") return { status: "changed" };
  const text = sanitizeTypedText(args.text, FEEDBACK_MAX_LENGTH);
  if (text.length === 0) return { status: "error", error: "Nothing to send" };

  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;

  try {
    // Bind only this first write. It changes the dialog (focus moves), so later steps must not reuse
    // this region.
    const focus = await sendKeys(args.paneId, [row.key], args.session, guarded.region);
    if (!focus.ok && focus.code === "prompt_changed") return { status: "changed" };
    if (!focus.ok) return { status: "error", error: focus.error };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // The field must be FOCUSED before anything is typed — text sent early goes nowhere useful, and the
  // Enter that follows would answer whatever row the pointer is still on. On timeout we stop dead.
  const focused = (m: PromptModel) =>
    promptsSameIdentity(m, args.prompt) && (m.feedback?.focused ?? false);
  if ((await pollDialog(target(args), focused)) !== "ok") {
    return { status: "error", error: "The feedback box didn't open — check the pane" };
  }

  try {
    const typed = await sendReply(args.paneId, text, false, args.session);
    if (!typed.ok) return { status: "error", error: typed.error };
    // Wait for our words to render. The row windows long text around the caret, so what is visible is
    // the TAIL of what we typed (the whole of it when it fits) — the same read-back shape the note
    // flow uses. Enter is sent only on this evidence.
    const landed = await pollDialog(
      target(args),
      (m) =>
        focused(m) && (m.feedback?.text.length ?? 0) > 0 && text.endsWith(m.feedback!.text),
    );
    if (landed !== "ok") {
      return { status: "error", error: "The feedback didn't arrive — nothing was submitted" };
    }
    const submit = await sendKeys(args.paneId, ["Enter"], args.session);
    if (!submit.ok) return { status: "error", error: submit.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
