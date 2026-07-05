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

import { fetchPane, sendKeys, sendReply } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type PreviewOption, type PreviewSelectModel } from "./blocks";
import { detectPreviewSelect } from "./grammar/preview-select";
import type { PromptActionResult } from "./prompt-action";

/** Longest note Collie will type (the editor enforces it). The TUI itself windows the display at
 *  ~60 columns, so long notes can't be read back faithfully anyway — keep them phone-sized. */
export const NOTE_MAX_LENGTH = 300;
// The deterministic clear for an existing note: ctrl+k kills cursor→end, the Backspace sweep kills
// the head (surplus presses at position 0 are no-ops). Sized past NOTE_MAX_LENGTH so any note
// Collie itself attached is always fully cleared; ctrl+u/ctrl+a are NOT supported by the input.
const CLEAR_SWEEP = NOTE_MAX_LENGTH + 20;

// Bounded verification polling between choreography steps (the TUI re-renders well under a
// second; ~3s total before we give up and refresh).
const POLL_ATTEMPTS = 8;
const POLL_DELAY_MS = 350;

type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  /** Test seam for the verification polls' pacing. */
  sleep?: Sleep;
}

/** One fresh read + re-derivation. Returns the model (null = no preview dialog on screen). */
async function readModel(
  paneId: string,
  requestedLines: number,
): Promise<{ revision: number; model: PreviewSelectModel | null }> {
  const fresh = await fetchPane(paneId, requestedLines);
  return { revision: fresh.revision, model: detectPreviewSelect(splitLines(parseAnsi(fresh.text))) };
}

/** The shared entry guard: fresh read, unconditional revision equality, full model equality. */
async function entryGuard(args: GuardArgs): Promise<PromptActionResult | null> {
  let fresh;
  try {
    fresh = await readModel(args.paneId, args.requestedLines);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
  if (fresh.revision !== args.detectedRevision) return { status: "changed" };
  if (!fresh.model || !previewsEqual(fresh.model, args.preview)) return { status: "changed" };
  return null;
}

/**
 * Poll (bounded) until `accept` passes on a fresh re-derivation. THREE-VALUED, because the caller
 * must distinguish "the awaited state never arrived, but this is still our dialog" from "a different
 * dialog is on screen now":
 *   - `"ok"`      — `accept` passed.
 *   - `"drifted"` — the dialog's IDENTITY changed: a fresh model whose core signature no longer
 *                   matches (a same-shaped successor / another dialog entirely), OR the dialog is
 *                   GONE (every read re-derived to null — e.g. the agent is running again). No
 *                   further key may be sent: a blind keystroke would hit whatever replaced it.
 *   - `"timeout"` — our dialog stayed on screen (signature intact) but the awaited state never came
 *                   within the bounded window (e.g. a swallowed keystroke). The dialog is still ours,
 *                   so a bounded RETRY of the same key is safe.
 * A transient null re-derivation MID-poll keeps polling (the TUI redraw can briefly hide the tail);
 * only an all-null poll (the dialog truly vanished) resolves to `"drifted"`.
 */
async function pollUntil(
  args: GuardArgs,
  accept: (m: PreviewSelectModel) => boolean,
): Promise<"ok" | "drifted" | "timeout"> {
  const sleep = args.sleep ?? defaultSleep;
  let sawDialog = false;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS);
    let fresh;
    try {
      fresh = await readModel(args.paneId, args.requestedLines);
    } catch {
      continue; // transient read failure — the bounded loop is the timeout
    }
    if (!fresh.model) continue; // transient redraw hid the tail — keep polling
    sawDialog = true;
    if (accept(fresh.model)) return "ok";
    if (!coreEqual(fresh.model, args.preview)) return "drifted"; // a different dialog now
  }
  // Exhausted. If we never saw the dialog at all it has vanished (a now-running agent) — treat as
  // drift, NOT a retryable timeout, so no blind key is sent at whatever replaced it.
  return sawDialog ? "timeout" : "drifted";
}

/**
 * Select an option: entry guard → digit (pointer move) → poll until the pointer verifiably sits on
 * the tapped row → Enter. If the pointer never converges nothing has been submitted — the digit's
 * pointer move is the only side effect — so the caller just refreshes.
 */
export async function submitPreviewOption(
  args: GuardArgs & { option: PreviewOption },
): Promise<PromptActionResult> {
  const guarded = await entryGuard(args);
  if (guarded) return guarded;

  try {
    const digit = await sendKeys(args.paneId, [String(args.option.n)]);
    if (!digit.ok) return { status: "error", error: digit.error };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const pointed = await pollUntil(
    args,
    (m) =>
      structureEqual(m, args.preview) && // same dialog, note untouched (an opened input eats keys)
      (m.options.find((o) => o.n === args.option.n)?.pointed ?? false),
  );
  if (pointed !== "ok") return { status: "changed" };

  try {
    const enter = await sendKeys(args.paneId, ["Enter"]);
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
): Promise<PromptActionResult> {
  if (args.preview.note.state === "editing") return { status: "changed" };
  const guarded = await entryGuard(args);
  if (guarded) return guarded;

  // Collapse whitespace to single spaces FIRST (so \t \n \r become word boundaries, not glue), then
  // strip any remaining C0/C1 control chars. Pasted clipboard text can smuggle in ESC (\x1b — blurs/
  // cancels the dialog), BEL (\x07 — "edit in nano"), ETX (\x03), etc., which the reply path would
  // deliver straight into the focused input BEFORE the readback check — so they must never reach it.
  const text = args.text
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, NOTE_MAX_LENGTH);
  const editing = (m: PreviewSelectModel) => coreEqual(m, args.preview) && m.note.state === "editing";

  try {
    const open = await sendKeys(args.paneId, ["n"]);
    if (!open.ok) return { status: "error", error: open.error };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  // The input must be FOCUSED before anything else is sent — early keys are misrouted (verified).
  // On timeout we stop dead: a blind Escape could cancel the whole dialog if `n` never landed.
  if ((await pollUntil(args, editing)) !== "ok") {
    return { status: "error", error: "Note input didn't open — check the pane" };
  }

  try {
    if (args.preview.note.state === "attached") {
      // Deterministic clear: the restored cursor position is unreliable, so kill the tail from
      // wherever it is, then sweep the head with Backspaces (no-ops once the text is gone). Then
      // wait until the input verifiably shows empty before typing into it.
      const clear = await sendKeys(args.paneId, [
        "ctrl+k",
        ...Array.from({ length: CLEAR_SWEEP }, () => "Backspace"),
      ]);
      if (!clear.ok) return { status: "error", error: clear.error };
      if ((await pollUntil(args, (m) => editing(m) && m.note.text === "")) !== "ok") {
        return { status: "error", error: "Couldn't clear the existing note — check the pane" };
      }
    }
    if (text.length > 0) {
      const typed = await sendReply(args.paneId, text, false);
      if (!typed.ok) return { status: "error", error: typed.error };
      // Wait for the text to render. The input windows long text around the trailing cursor, so
      // the visible value is the TAIL of what we typed (the whole of it when it fits).
      const landed = await pollUntil(
        args,
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
      const blur = await sendKeys(args.paneId, ["Escape"]);
      if (!blur.ok) return { status: "error", error: blur.error };
      const blurred = await pollUntil(
        args,
        (m) => coreEqual(m, args.preview) && m.note.state !== "editing",
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
): Promise<PromptActionResult> {
  const guarded = await entryGuard(args);
  if (guarded) return guarded;
  try {
    const res = await sendKeys(args.paneId, args.keys);
    if (!res.ok) return { status: "error", error: res.error };
    return { status: "sent" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}
