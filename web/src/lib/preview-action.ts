// The preview-variant race guards — prompt-action's philosophy applied to the preview
// AskUserQuestion dialog, whose choreography is MULTI-step (grammar/NOTES_NOTES.md):
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
// Every flow starts with the same guard as submitPromptOption/submitWizardKeys: a FRESH pane read,
// the unconditional revision check, and a full model re-derivation compared against what the user
// tapped (Herdr 0.7.x's revision is a stub — the re-derivation is the load-bearing check). The
// mid-flight verification polls then re-derive from fresh reads again; a dialog that drifts
// structurally at any point aborts with "changed" BEFORE anything irreversible is sent.

import { sendKeys, sendReply } from "./api";
import { type PreviewOption, type PreviewSelectModel } from "./blocks";
import { detectPreviewSelect } from "./harness/claude/preview-select";
import {
  entryGuard,
  pollUntil,
  sanitizeTypedText,
  type ActionResult,
  type Sleep,
} from "./harness/guard";

/** Longest note Collie will type (the editor enforces it). The TUI itself windows the display at
 *  ~60 columns, so long notes can't be read back faithfully anyway — keep them phone-sized. */
export const NOTE_MAX_LENGTH = 300;
// The deterministic clear for an existing note: ctrl+k kills cursor→end, the Backspace sweep kills
// the head (surplus presses at position 0 are no-ops). Sized past NOTE_MAX_LENGTH so any note
// Collie itself attached is always fully cleared; ctrl+u/ctrl+a are NOT supported by the input.
const CLEAR_SWEEP = NOTE_MAX_LENGTH + 20;

/**
 * Whether two detected preview dialogs are the same dialog in the same visible state: identity (the
 * pointer/note-independent core signature — see below), question, stepper chips, options (labels,
 * pointer, chosen marks), note state+text, and the preview pane. The strictest of the three equality
 * checks — everything the user can see participates AND the region signature must byte-match, because
 * every visible change (even a terminal-side pointer move) re-routes what our keystrokes would do.
 */
export function previewsEqual(a: PreviewSelectModel, b: PreviewSelectModel): boolean {
  return (
    structureEqual(a, b) && // core signature + question/chips/labels + note state
    a.options.every((o, i) => o.pointed === b.options[i]!.pointed) &&
    a.preview.length === b.preview.length &&
    a.preview.every((l, i) => l === b.preview[i])
  );
}

/** The dialog's identity, independent of transient state: the region CORE SIGNATURE (the subject
 *  above the options + the option labels/layout, pointer normalised) plus question, stepper chips,
 *  and option labels/chosen marks — but NOT the pointer (our own digit legitimately moves it), NOT
 *  the preview pane (it follows the pointer), and NOT the note (the note flow legitimately transitions
 *  it). The mid-flight polls key on this: same dialog (same signature), awaited state. The signature
 *  is the load-bearing check — a same-SHAPED successor (identical question+labels, different subject)
 *  has a different signature, so it can never pass as the dialog the user tapped. */
function coreEqual(a: PreviewSelectModel, b: PreviewSelectModel): boolean {
  if (a.coreSignature !== b.coreSignature) return false;
  if (a.question !== b.question) return false;
  if ((a.steps === null) !== (b.steps === null)) return false;
  if (
    a.steps !== null &&
    b.steps !== null &&
    (a.steps.length !== b.steps.length ||
      !a.steps.every(
        (s, i) =>
          s.label === b.steps![i]!.label &&
          s.answered === b.steps![i]!.answered &&
          s.current === b.steps![i]!.current,
      ))
  ) {
    return false;
  }
  return (
    a.options.length === b.options.length &&
    a.options.every((o, i) => o.label === b.options[i]!.label && o.chosen === b.options[i]!.chosen)
  );
}

/** Core identity plus the note's visible state — everything except the pointer/preview. */
function structureEqual(a: PreviewSelectModel, b: PreviewSelectModel): boolean {
  return coreEqual(a, b) && a.note.state === b.note.state && a.note.text === b.note.text;
}

interface GuardArgs {
  paneId: string;
  requestedLines: number;
  /** The `revision` the rendered dialog was detected against. */
  detectedRevision: number;
  preview: PreviewSelectModel;
  /** The session the pane lives in (undefined = primary) — scopes every read + keystroke below. */
  session?: string;
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
  const guarded = await entryGuard(args, args.preview, detectPreviewSelect, previewsEqual);
  if (guarded) return guarded;

  try {
    const digit = await sendKeys(args.paneId, [String(args.option.n)], args.session);
    if (!digit.ok) return { status: "error", error: digit.error };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const pointed = await pollUntil(
    args,
    args.preview,
    detectPreviewSelect,
    (m) =>
      structureEqual(m, args.preview) && // same dialog, note untouched (an opened input eats keys)
      (m.options.find((o) => o.n === args.option.n)?.pointed ?? false),
    coreEqual,
  );
  if (pointed !== "ok") return { status: "changed" };

  try {
    const enter = await sendKeys(args.paneId, ["Enter"], args.session);
    if (!enter.ok) return { status: "error", error: enter.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
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
  const guarded = await entryGuard(args, args.preview, detectPreviewSelect, previewsEqual);
  if (guarded) return guarded;

  const text = sanitizeTypedText(args.text, NOTE_MAX_LENGTH);
  const editing = (m: PreviewSelectModel) => coreEqual(m, args.preview) && m.note.state === "editing";

  try {
    const open = await sendKeys(args.paneId, ["n"], args.session);
    if (!open.ok) return { status: "error", error: open.error };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // The input must be FOCUSED before anything else is sent — early keys are misrouted (verified).
  // On timeout we stop dead: a blind Escape could cancel the whole dialog if `n` never landed.
  if ((await pollUntil(args, args.preview, detectPreviewSelect, editing, coreEqual)) !== "ok") {
    return { status: "error", error: "Note input didn't open — check the pane" };
  }

  try {
    if (args.preview.note.state === "attached") {
      // Deterministic clear: the restored cursor position is unreliable, so kill the tail from
      // wherever it is, then sweep the head with Backspaces (no-ops once the text is gone). Then
      // wait until the input verifiably shows empty before typing into it.
      const clear = await sendKeys(
        args.paneId,
        ["ctrl+k", ...Array.from({ length: CLEAR_SWEEP }, () => "Backspace")],
        args.session,
      );
      if (!clear.ok) return { status: "error", error: clear.error };
      if (
        (await pollUntil(
          args,
          args.preview,
          detectPreviewSelect,
          (m) => editing(m) && m.note.text === "",
          coreEqual,
        )) !== "ok"
      ) {
        return { status: "error", error: "Couldn't clear the existing note — check the pane" };
      }
    }
    if (text.length > 0) {
      const typed = await sendReply(args.paneId, text, false, args.session);
      if (!typed.ok) return { status: "error", error: typed.error };
      // Wait for the text to render. The input windows long text around the trailing cursor, so
      // the visible value is the TAIL of what we typed (the whole of it when it fits).
      const landed = await pollUntil(
        args,
        args.preview,
        detectPreviewSelect,
        (m) => editing(m) && m.note.text.length > 0 && text.endsWith(m.note.text),
        coreEqual,
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
      const blur = await sendKeys(args.paneId, ["Escape"], args.session);
      if (!blur.ok) return { status: "error", error: blur.error };
      const blurred = await pollUntil(
        args,
        args.preview,
        detectPreviewSelect,
        (m) => coreEqual(m, args.preview) && m.note.state !== "editing",
        coreEqual,
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
  const guarded = await entryGuard(args, args.preview, detectPreviewSelect, previewsEqual);
  if (guarded) return guarded;
  try {
    const res = await sendKeys(args.paneId, args.keys, args.session);
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
