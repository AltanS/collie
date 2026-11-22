// The take-back receipt's wire shape and its closed lists (ADR 0122, the 2026-11-22 addendum). `POST
// /api/pane/:id/dequeue` on a pane with a screen takes `{ requestId }` and, where the harness names a
// dequeue key (`JournalAdapter.dequeue`, Claude Code's Up), takes the agent's whole waiting queue back:
// the key once, the journal's proof, the box emptied, and the texts in the answer, so the phone puts
// them into its own composer. The bridge runs it (bridge/surface/dequeue.ts); the phone posts the body
// and renders the receipt. Both read the types from here, so the lists cannot drift apart.
//
// Pure: no DOM, no Bun API, no harness name.

/** What the phone posts: one request id, the same shape as a Stop's and a Clear's. */
export interface DequeueBody {
  readonly requestId: string;
}

/**
 * `taken`: the journal showed the queue that was read go back into the agent's box, the box was emptied
 * and read back empty; `texts` holds the queue's texts in order. `in_box`: the key went in and the text
 * stands in the agent's box, but Collie did not empty it (the box did not hold exactly the queue, or the
 * clear did not read back empty); the "Back in the box" card carries on. `too_late`: the queue went out
 * before the key; the key recalled the last prompt from the agent's history, and Collie emptied the box
 * again (or found it empty). `unknown`: the key went in and Collie cannot tell what it did; it touched
 * nothing more. `refused`: no key left, with one reason. On the phone `unknown` is also the word for an
 * answer that never came back.
 */
export const DEQUEUE_OUTCOMES = ["taken", "in_box", "too_late", "unknown", "refused"] as const;
export type DequeueOutcome = (typeof DEQUEUE_OUTCOMES)[number];

/**
 * Why no key left. `no_profile`: Collie has no reader for this pane, so it does not press blind.
 * `no_key`: the harness names no dequeue key, or the multiplexer cannot deliver it. `no_journal`: the
 * session's journal could not be read, so no proof could follow the key. `turn_idle`: the turn already
 * ended. `dialog_open`: a dialog is up, and the key would move in it. `draft_present`: the agent's box
 * holds text, and the key would move the cursor in it. `queue_empty`: the journal lists no waiting
 * message. `not_whole`: a waiting message cannot come back whole (a picture or a paste the journal
 * names only by a marker, a text too long to clear, or one this bridge masks). `busy`: another send
 * holds the pane. `unreadable`: the screen does not say whether a turn runs, a dialog is up or the box is
 * empty. `press_failed`: the multiplexer refused the key. `pane_gone`: the multiplexer could not read the
 * pane. `unsupported_build` is the phone's word, never the bridge's: the machine that owns the pane runs
 * a build with no take-back route (a bare 404, a 400 or a 405 instead of a receipt).
 */
export const DEQUEUE_REASONS = [
  "no_profile",
  "no_key",
  "no_journal",
  "turn_idle",
  "dialog_open",
  "draft_present",
  "queue_empty",
  "not_whole",
  "busy",
  "unreadable",
  "press_failed",
  "pane_gone",
  "unsupported_build",
] as const;
export type DequeueReason = (typeof DEQUEUE_REASONS)[number];

/** The receipt a take-back answers, and the same one again for the same request id. */
export interface DequeueReceipt {
  readonly requestId: string;
  readonly outcome: DequeueOutcome;
  /** Set on a refusal. */
  readonly reason?: DequeueReason;
  /**
   * Set on `taken` only: the texts of the queue, oldest first, whole. They are the person's own words,
   * behind the same write gate as the tap: the bridge keeps them only for this receipt's replay, never
   * logs them, never puts them on the audit line or into a trace.
   */
  readonly texts?: readonly string[];
  /**
   * Set on `taken` and `too_late` when a clear key left and the agent's box did not read back empty: the
   * texts left the queue all the same, and the agent's box may still hold a cut-off rest of them.
   */
  readonly leftover?: true;
}

/** The texts of a `taken` receipt as one composer text: in queue order, joined by one newline. */
export function takenText(texts: readonly string[]): string {
  return texts.join("\n");
}

/** The request id's grammar is the Send Protocol's: see `REQUEST_ID` in ./send. */
