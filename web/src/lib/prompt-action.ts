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

import { sendReply } from "./api";
import { type PromptModel, type PromptOption } from "./blocks";
import {
  guardDialog,
  pollDialog,
  readDialog,
  sendBoundKeys,
  sendGuardedKeys,
  type DialogTarget,
} from "./dialog-guard";
import { promptsSameIdentity } from "./harness/prompt-model";
import { sanitizeTypedText, type ActionResult, type Sleep } from "./harness/guard";

/** The prompt-select identity comparators, part of the neutral contract (harness/prompt-model.ts).
 *  Re-exported under their original names so existing call sites and tests keep one import site. */
export { promptsEqual, promptsSameIdentity, sameKeys } from "./harness/prompt-model";

/** The guarded-action result union, canonical in `harness/guard.ts`; re-exported under the original
 *  name so existing imports (wizard-action, AgentChat, tests) keep working. */
export type PromptActionResult = ActionResult;

/**
 * Longest feedback Collie will type into a plan dialog.
 *
 * Not a comfort limit — a grammar one. The row does not window long text: Claude re-flows the whole
 * value across as many display lines as it needs, which pushes the dialog's footer away from its
 * options. `MAX_FEEDBACK_WRAP` (harness/claude/prompt-select.ts) is how far that may go before the
 * screen stops parsing at all, and this is sized to stay inside it even on a narrow pane (~4 lines of
 * ~60 usable columns). Longer text isn't dangerous — the read-back check simply refuses and nothing is
 * submitted — but the dialog would drop off the phone, so we don't let it happen.
 */
export const FEEDBACK_MAX_LENGTH = 240;

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
 * of answering (issue #95).
 *
 * This is NOT a duplicate of the renderer's lock, and not belt-and-braces — it is the only thing at
 * the write layer that refuses the STATE. The race guard below verifies SAMENESS: a model captured
 * while focused, compared against a fresh screen that is still focused, compares EQUAL and the digit
 * goes out. The renderer's lock is UX; this is the invariant. Don't remove it as redundant.
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

  // Bind this write to the guarded region. It moves focus, so the steps after it must re-derive
  // rather than reuse this binding.
  const focus = await sendBoundKeys(args, [row.key], guarded.region);
  if (focus.status !== "sent") return focus;

  // The field must be FOCUSED, and STILL EMPTY, before anything is typed. Focus alone is not enough:
  // this flow runs while a human is looking at the same dialog, so the window between our digit and
  // our paste is exactly when they might start typing into the box themselves. Their fragment would
  // sit at the head, our paste would follow it, and the tail-windowed read-back below cannot see a
  // prefix — so the Enter would submit both as one garbled sentence. The note flow solves this by
  // clearing first; this row cannot be cleared (Backspace at position 0 is a no-op), so refusing on a
  // non-empty box is the substitute. It narrows the shared-PTY window to one read-to-write round
  // trip, which is irreducible. On timeout we stop dead: nothing has been typed.
  const focusedAndEmpty = (m: PromptModel) =>
    promptsSameIdentity(m, args.prompt) && (m.feedback?.focused ?? false) && m.feedback?.text === "";
  if ((await pollDialog(target(args), focusedAndEmpty)) !== "ok") {
    return { status: "error", error: "The feedback box didn't open — check the pane" };
  }

  try {
    const typed = await sendReply(args.paneId, text, false, args.session);
    if (!typed.ok) return { status: "error", error: typed.error };
    // Wait for our words to render, then match them EXACTLY. The row re-flows rather than windowing,
    // and the grammar rejoins its wrapped lines, so the whole value is readable — there is no reason to
    // accept a partial match, and every reason not to: this is the evidence the irreversible Enter is
    // sent on. Anything the terminal did to our text that we can't account for (a mid-word wrap seam, a
    // truncation) shows up as inequality and stops the flow with the box unsubmitted.
    const landed = (m: PromptModel) =>
      promptsSameIdentity(m, args.prompt) &&
      (m.feedback?.focused ?? false) &&
      m.feedback?.text === text;
    if ((await pollDialog(target(args), landed)) !== "ok") {
      return { status: "error", error: "The feedback didn't arrive — nothing was submitted" };
    }
    // The Enter is the only irreversible write in this flow — it rejects a plan and puts words in the
    // agent's mouth — so it is also the one that must not go out unbound. Re-read, re-check, and hand
    // the bridge the region it must still find before writing: a keystroke at the terminal between
    // that read and this write then produces a server-side refusal instead of a submit aimed at a
    // screen that has moved. (The sibling flows send their last key unbound; this one carries more.)
    const fresh = await readDialog(target(args));
    if (!fresh.model || !landed(fresh.model)) return { status: "changed" };
    return sendBoundKeys(args, ["Enter"], fresh.model.signature);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
