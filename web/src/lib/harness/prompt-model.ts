// The PROMPT-SELECT MODEL — the harness-NEUTRAL payload of a `prompt-select` Block.
//
// A single-choice dialog: a question, a list of options, and the family whose verified keystroke
// recipe each option's `keys` already encodes. Any adapter can produce one; the renderer
// (components/prompt-select-block.tsx) and the race guard (lib/prompt-action.ts → lib/dialog-guard.ts)
// are written against these types alone, never against a harness's internals.
//
// Types + the pure IDENTITY COMPARATOR, no detection and no harness conventions. Claude's reference
// detector is harness/claude/prompt-select.ts. This module imports nothing, so `lib/blocks.ts` can
// re-export it without a cycle.

/** The single-choice dialog families a harness can report, discriminated by its footer hint bar.
 *  The family is what pins the keystroke recipe (digit-then-Enter vs digit alone), so it is part of
 *  the neutral contract even though today only Claude's footers are classified. */
export type PromptFamily = "select" | "permission" | "trust" | "plan";

/** One selectable option, up-levelled into a tappable button. */
export interface PromptOption {
  /** The visible option label (rendered as a React text node — the XSS boundary is unchanged). */
  label: string;
  /** Secondary descriptive line(s) the dialog supplies, joined with spaces. Absent when none. */
  description?: string;
  /**
   * The keys to send (in order) to choose this option, per the dialog family's verified recipe:
   * `select` needs the digit THEN `Enter` ("Enter to select"); `permission`/`trust`/`plan` confirm
   * on the digit ALONE (a trailing Enter there would leak into whatever renders next).
   */
  keys: string[];
  /**
   * What the option's badge shows when `keys[0]` is not the identifying key — e.g. Grok's parked
   * ask card sends `["Tab", "2"]` (Tab re-enters the card first) but the row is still "option 2".
   * Absent when `keys[0]` already is the badge.
   */
  keyLabel?: string;
}

/**
 * Why the inline free-text row exists. Absent means Claude's plan-approval input — the only
 * purpose `submitPromptFeedback` will type into.
 *
 *   - `plan-change` — Claude's "Tell Claude what to change": the digit focuses the field, typing
 *     fills it, Enter denies the plan and hands the agent the text (PLAN_FEEDBACK_NOTES.md).
 *   - `free-text` — another harness's custom-answer row (Grok's `z`). Parsed so a focused row can
 *     lock the option buttons; Collie does not type into it. The Claude plan-feedback send path
 *     is the wrong recipe (different key, different Enter, unmeasured caret/wrap).
 */
export type PromptFeedbackPurpose = "plan-change" | "free-text";

/**
 * The dialog's inline free-text INPUT row, when it has one (Claude's plan approval: "Tell Claude
 * what to change"; Grok's ask card: `z`). It is never an option — it is answered by typing, and
 * its key only moves focus onto it. Modelled rather than merely dropped because both of its
 * variables change what every OTHER row's digit does, and the phone has to see that:
 *
 *   - `focused` — while `❯` sits on the row the field owns the keyboard, and the dialog routes every
 *     digit into it AS TEXT instead of answering. No button on this dialog can fire.
 *   - `text` — what the box holds. Empty (the row shows its placeholder) is the only state Collie
 *     will type into on a `plan-change` row: re-entering a non-empty field puts the caret at
 *     position 0, so our text would be PREPENDED to a sentence someone else is mid-way through writing.
 *
 * Claude's four states were measured a keystroke at a time against Claude Code 2.1.228 — see
 * `web/src/lib/grammar/PLAN_FEEDBACK_NOTES.md`, which is the ground truth for `plan-change`.
 */
export interface PromptFeedback {
  /** The key that focuses the field. On Claude this is a digit (INSTALL-DEPENDENT —
   *  `showClearContextOnPlanAccept` adds a row, making it 4 instead of 3). On Grok it is `z`.
   *  Nothing may assume a fixed value. */
  key: string;
  /** `❯` is on this row: the field has the keyboard and every digit is swallowed as a character. */
  focused: boolean;
  /** What the box holds; `""` while it shows its placeholder. See the caret hazard above. */
  text: string;
  /** Absent = `plan-change` (Claude). Set explicitly when the row is not that input. */
  purpose?: PromptFeedbackPurpose;
}

/** A recognised single-choice dialog: the question, its selectable options, and the family. */
export interface PromptModel {
  question: string;
  options: PromptOption[];
  family: PromptFamily;
  /** The dialog's inline free-text input row, when it has one. Absent on dialogs without one. */
  feedback?: PromptFeedback;
  /**
   * The dialog's identity, independent of everything OUR OWN choreography changes: the `❯` pointer,
   * the feedback row's contents, and the row's HEIGHT (a long value wraps, which re-flows the screen
   * above it). Runs from the QUESTION — not `signature`'s wider lookback — with pointers normalised
   * and the whole feedback block collapsed to one token. The feedback flow moves all three by design,
   * so its mid-flight polls compare THIS. Narrower than `signature` by exactly the subject above the
   * question, which is the part that provably drifts under the flow's own keystrokes; the ENTRY guard
   * still compares the full `signature`, so a stale tap never starts against the wrong dialog.
   * Mirrors preview-select's `coreSignature`, for the same reason.
   */
  coreSignature: string;
  /**
   * A byte-signature of the dialog's on-screen region — a bounded run of lines from ABOVE the first
   * option (capturing the subject: the diff/command/context the dialog is about) through the footer.
   * The race guard compares this so a same-SHAPED successor dialog (identical question + labels but a
   * different subject — e.g. a second edit to the same file) can't pass as the one the user saw.
   * Herdr's `revision` is a stub, so this content signature is the load-bearing freshness check —
   * it MUST be non-empty and MUST change when the region's text changes.
   */
  signature: string;
}

/**
 * Whether two derivations are the SAME on-screen prompt — not merely the same shape. `signature`
 * (the dialog's region text, incl. the subject above the options) is the decisive check: two edits to
 * the same file yield an identical family/question/labels but a different signature, so a stale tap on
 * one can't approve the other. The family/question/label checks stay as a cheap fast-path and to keep
 * the intent explicit. (`revision` is a stub, so this content comparison is the real freshness guard.)
 *
 * Part of the CONTRACT, not of any harness: the race guard (lib/dialog-guard.ts) compares whatever
 * adapter produced the block through exactly this function.
 */
export function promptsEqual(a: PromptModel, b: PromptModel): boolean {
  return (
    promptsSameIdentity(a, b) &&
    a.signature === b.signature &&
    // The feedback row's VISIBLE state, which the identity check deliberately ignores. A committing
    // digit must not fire across a change to it: focus decides whether that digit answers at all, and
    // text appearing in the box means someone at the terminal is typing into this very dialog.
    a.feedback?.focused === b.feedback?.focused &&
    a.feedback?.text === b.feedback?.text
  );
}

/**
 * "Same dialog" only — the weaker comparison for the keystrokes whose OWN effect is the change. The
 * feedback flow's digit focuses the input and its typing fills it, so `focused`, `text`, and the
 * pointer- and text-dependent `signature` all move by design; `coreSignature` is what stays put.
 * Everything that would re-route a keystroke to a DIFFERENT dialog still participates.
 *
 * Part of the CONTRACT, not of any harness — harness/dialog-contract.ts wires it in as
 * prompt-select's `identity`.
 */
export function promptsSameIdentity(a: PromptModel, b: PromptModel): boolean {
  return (
    a.family === b.family &&
    a.question === b.question &&
    a.coreSignature === b.coreSignature &&
    // The row's key and purpose, not its state: a feedback row that appeared, vanished,
    // renumbered, or changed purpose is a different dialog, and the flow's remaining
    // keystrokes would be aimed at the wrong row.
    a.feedback?.key === b.feedback?.key &&
    a.feedback?.purpose === b.feedback?.purpose &&
    a.options.length === b.options.length &&
    a.options.every((o, i) => o.label === b.options[i]!.label && sameKeys(o.keys, b.options[i]!.keys))
  );
}

/** Exact keystroke-plan equality — a label can map to a different digit across hidden-row layouts. */
export function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
