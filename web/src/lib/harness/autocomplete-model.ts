// The AUTOCOMPLETE MODEL — the harness-NEUTRAL payload of an `autocomplete` Block.
//
// An "autocomplete" is the agent's own COMPLETION POPUP: the list of candidates a TUI paints while
// the operator is still typing into its input box (Claude Code's slash-command menu). It is NOT a
// dialog. Nothing on that screen owns the keyboard — the input box is live, the composer can type
// into it, and the popup disappears on its own once the draft stops matching. That is why this model
// carries no keys, no signature and no comparators, and why `autocomplete` has no row in
// harness/dialog-contract.ts: there is no committing keystroke to race-guard.
//
// Types only. This module imports nothing, so `lib/blocks.ts` can re-export it without a cycle.

/** One candidate the popup listed: the completion itself, and the one-line blurb beside it. */
export interface AutocompleteEntry {
  /** The completion text as printed, leading marker included — e.g. `/model`. */
  name: string;
  /** The description column, wrapped continuation rows folded back into one string. May be empty. */
  description: string;
}

/** A recognised completion popup: the candidates it listed, top to bottom, as printed. */
export interface AutocompleteModel {
  entries: AutocompleteEntry[];
}
