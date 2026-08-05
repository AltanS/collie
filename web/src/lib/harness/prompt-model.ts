// The PROMPT-SELECT MODEL — the harness-NEUTRAL payload of a `prompt-select` Block.
//
// A single-choice dialog: a question, a list of options, and the family whose verified keystroke
// recipe each option's `keys` already encodes. Any adapter can produce one; the renderer
// (components/prompt-select-block.tsx) and the race guard (lib/prompt-action.ts → lib/dialog-guard.ts)
// are written against these types alone, never against a harness's internals.
//
// Types only — no detection, no harness conventions. Claude's reference detector is
// harness/claude/prompt-select.ts. This module imports nothing, so `lib/blocks.ts` can re-export it
// without a cycle. The identity comparator lives in dialog-contract.ts with its siblings.

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
}

/** A recognised single-choice dialog: the question, its selectable options, and the family. */
export interface PromptModel {
  question: string;
  options: PromptOption[];
  family: PromptFamily;
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
