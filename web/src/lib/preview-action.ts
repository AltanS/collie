// The preview-variant action recipes — the generic race guard (lib/dialog-guard.ts) plus the extra
// verified steps this dialog's MULTI-step choreography needs (grammar/NOTES_NOTES.md):
//
//   - Selecting an option is digit → verify pointer → Enter. A `[digit, Enter]` pair in ONE
//     send_keys call picks the WRONG row (the TUI processes both keys in one input chunk and the
//     Enter still sees the pre-digit pointer — observed live), so the Enter is only sent after a
//     fresh read shows the pointer on the tapped row.
//   - Adding/editing a note is n → verify the input focused → clear → type → Escape. Focus is not
//     instantaneous, keystrokes sent early are misrouted, and Enter inside the input would submit
//     the dialog — so every step that types is gated on a verified pane state, and Enter is never
//     part of the recipe.
//
// Every flow starts with the same guard as its siblings (lib/dialog-guard.ts): a FRESH pane read, the
// unconditional revision check, and a re-derivation THROUGH THE PANE'S ADAPTER compared against what
// the user tapped (Herdr 0.7.x's revision is a stub — the re-derivation is the load-bearing check).
// The mid-flight verification polls re-derive the same way; a dialog that drifts structurally at any
// point aborts with "changed" BEFORE anything irreversible is sent. The two comparators the polls use
// (`previewsEqual` for the entry, `previewCoreEqual` for the mid-flight identity) are the neutral
// contract in harness/preview-model.ts, wired to this kind by harness/dialog-contract.ts.

import { sendReply } from "./api";
import { type PreviewOption, type PreviewSelectModel } from "./blocks";
import { guardDialog, pollDialog, sendBoundKeys, type DialogTarget } from "./dialog-guard";
import { previewCoreEqual, previewStructureEqual } from "./harness/preview-model";
import { sanitizeTypedText, type ActionResult, type Sleep } from "./harness/guard";

/** This module's slice of the generic guard: the preview dialog the tap is aimed at. */
function target(args: GuardArgs): DialogTarget<"preview-select"> & { sleep?: Sleep } {
  return { ...args, kind: "preview-select", model: args.preview };
}

/** Longest note Collie will type (the editor enforces it). The TUI itself windows the display at
 *  ~60 columns, so long notes can't be read back faithfully anyway — keep them phone-sized. */
export const NOTE_MAX_LENGTH = 300;
// The deterministic clear for an existing note: ctrl+k kills cursor→end, the Backspace sweep kills
// the head (surplus presses at position 0 are no-ops). Sized past NOTE_MAX_LENGTH so any note
// Collie itself attached is always fully cleared; ctrl+u/ctrl+a are NOT supported by the input.
const CLEAR_SWEEP = NOTE_MAX_LENGTH + 20;

/** The preview identity comparators, part of the neutral contract (harness/preview-model.ts).
 *  Re-exported under the original name so existing call sites and tests keep one import site. */
export { previewsEqual } from "./harness/preview-model";

interface GuardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered dialog was detected against. */
  detectedRevision: number;
  preview: PreviewSelectModel;
  /** The session the pane lives in (undefined = primary) — scopes every read + keystroke below. */
  session?: string;
  /** Live pane-write permission, rechecked before every key or reply write. */
  canWrite: () => boolean;
  /** The pane's agent — which adapter re-derives the fresh screen. No adapter = the guard refuses. */
  agent?: string;
  /** Test seam for the verification polls' pacing. */
  sleep?: Sleep;
}

/**
 * Select an option: entry guard → digit (pointer move) → poll until the pointer verifiably sits on
 * the tapped row → Enter. If the pointer never converges nothing has been submitted — the digit's
 * pointer move is the only side effect — so the caller just refreshes.
 */
export async function submitPreviewOption(
  args: GuardArgs & { option: PreviewOption },
): Promise<ActionResult> {
  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;

  // Bind only this first write. It changes the dialog, so later steps must not reuse this region.
  const digit = await sendBoundKeys(target(args), [String(args.option.n)], guarded.region);
  if (digit.status !== "sent") return digit;

  const pointed = await pollDialog(
    target(args),
    (m) =>
      previewStructureEqual(m, args.preview) && // same dialog, note untouched (an open input eats keys)
      (m.options.find((o) => o.n === args.option.n)?.pointed ?? false),
  );
  if (pointed !== "ok") return { status: "changed" };

  return sendBoundKeys(target(args), ["Enter"]);
}

/**
 * Attach, replace, or remove (empty `text`) the question's note: entry guard → `n` → poll until
 * the note input is verifiably focused → clear (when replacing) → type via the reply path (one
 * agent.send paste — immune to the per-key focus race) → Escape (blur, keep; never Enter, which
 * would submit the dialog). The entry guard also rejects while the input is ALREADY focused
 * (a terminal user is typing there — our keys would corrupt their note).
 *
 * EVERY stage is verified rendered before the next is sent, and the final blur is verified too
 * (with one retry): an Escape written on the heels of the paste can land in the same input chunk,
 * where the bare ESC byte is misparsed and swallowed (observed live) — the render round-trip
 * between stages is what guarantees each write arrives as its own clean chunk.
 */
export async function submitPreviewNote(
  args: GuardArgs & { text: string },
): Promise<ActionResult> {
  if (args.preview.note.state === "editing") return { status: "changed" };
  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;

  const text = sanitizeTypedText(args.text, NOTE_MAX_LENGTH);
  const editing = (m: PreviewSelectModel) =>
    previewCoreEqual(m, args.preview) && m.note.state === "editing";

  // Bind only this first write. It changes the dialog, so later steps must not reuse this region.
  const open = await sendBoundKeys(target(args), ["n"], guarded.region);
  if (open.status !== "sent") return open;

  // The input must be FOCUSED before anything else is sent — early keys are misrouted (verified).
  // On timeout we stop dead: a blind Escape could cancel the whole dialog if `n` never landed.
  if ((await pollDialog(target(args), editing)) !== "ok") {
    return { status: "error", error: "Note input didn't open — check the pane" };
  }

  try {
    if (args.preview.note.state === "attached") {
      // Deterministic clear: the restored cursor position is unreliable, so kill the tail from
      // wherever it is, then sweep the head with Backspaces (no-ops once the text is gone). Then
      // wait until the input verifiably shows empty before typing into it.
      const clear = await sendBoundKeys(
        target(args),
        ["ctrl+k", ...Array.from({ length: CLEAR_SWEEP }, () => "Backspace")],
      );
      if (clear.status !== "sent") return clear;
      if (
        (await pollDialog(target(args), (m) => editing(m) && m.note.text === "")) !== "ok"
      ) {
        return { status: "error", error: "Couldn't clear the existing note — check the pane" };
      }
    }
    if (text.length > 0) {
      if (!args.canWrite()) return { status: "changed" };
      const typed = await sendReply(args.paneId, text, false, args.session);
      if (!typed.ok) return { status: "error", error: typed.error };
      // Wait for the text to render. The input windows long text around the trailing cursor, so
      // the visible value is the TAIL of what we typed (the whole of it when it fits).
      const landed = await pollDialog(
        target(args),
        (m) => editing(m) && m.note.text.length > 0 && text.endsWith(m.note.text),
      );
      if (landed !== "ok") {
        return { status: "error", error: "Note text didn't arrive — check the pane" };
      }
    }
    // Blur, keeping the text. Verified (the swallowed-ESC hazard above). The ONLY safe reason to
    // resend Escape is a swallowed key while OUR dialog is still on screen and still editing (a
    // "timeout" — the ESC glued onto the paste chunk). If instead the dialog DRIFTED or VANISHED
    // (a successor dialog, or a now-running agent — pollUntil returns "drifted"), a second blind
    // Escape would cancel/interrupt whatever is there now — so abort with "changed" and send nothing.
    for (let attempt = 0; attempt < 2; attempt++) {
      const blur = await sendBoundKeys(target(args), ["Escape"]);
      if (blur.status !== "sent") return blur;
      const blurred = await pollDialog(
        target(args),
        (m) => previewCoreEqual(m, args.preview) && m.note.state !== "editing",
      );
      if (blurred === "ok") return { status: "sent" };
      if (blurred === "drifted") return { status: "changed" }; // no second Escape at a successor
      // "timeout": our dialog is still editing — the ESC was likely swallowed. Retry once.
    }
    return { status: "error", error: "Note input didn't close — check the pane" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One guarded keystroke against the dialog (the wizard step's Left/Right navigation) — the exact
 * shape of submitWizardKeys, but re-deriving the PREVIEW model.
 */
export async function submitPreviewKeys(
  args: GuardArgs & { keys: string[] },
): Promise<ActionResult> {
  const guarded = await guardDialog(target(args));
  if (!guarded.ok) return guarded.result;
  // Bind only this first write. It changes the dialog, so later steps must not reuse this region.
  return sendBoundKeys(target(args), args.keys, guarded.region);
}
