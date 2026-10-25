// The Stop receipt's wire shape and its closed lists (M68 spec 01). `POST /api/pane/:id/abort` on a
// pane with a screen takes `{ requestId }` and presses the profile's interrupt key as a person's tap.
// The bridge runs it (bridge/surface/stop.ts); the phone posts the body and renders the receipt. Both
// read the types from here, so the lists cannot drift apart.
//
// Pure: no DOM, no Bun API, no harness name.

/** What the phone posts: one request id, the same shape as a send's. */
export interface StopBody {
  readonly requestId: string;
}

/**
 * `stopped`: the keys went in and two reads in a row within 3 s show the turn gone and no dialog.
 * `pressed`: the keys went in and the read-back did not show that (one idle read alone, a turn that
 * still reads running, or a read that could not tell). `refused`: no key left. `unknown` is the
 * phone's word, never the bridge's: no receipt came back (a crew member that did not answer the lead
 * in time, the lead's `write_outcome_unknown`), so the key may or may not have gone in.
 */
export const STOP_OUTCOMES = ["stopped", "pressed", "refused", "unknown"] as const;
export type StopOutcome = (typeof STOP_OUTCOMES)[number];

/**
 * Why a Stop pressed nothing. `no_profile`: Collie has no reader for this pane, so it does not stop it
 * blind. `turn_idle`: the turn already ended. `dialog_open`: a dialog is up and Escape would answer it.
 * `draft_present`: the box holds text and this harness's interrupt key clears it first.
 * `unreadable`: Collie cannot tell whether a turn runs on this screen. `press_failed`: the multiplexer
 * refused the keys. `pane_gone`: the multiplexer could not read the pane. `unsupported_build` is the
 * phone's word, never the bridge's: the machine that owns the pane runs a build with no Stop for a
 * screen pane (its route answered a bare 404 or a 400 instead of a receipt), so nothing was pressed.
 */
export const STOP_REASONS = ["no_profile", "turn_idle", "dialog_open", "draft_present", "unreadable", "press_failed", "pane_gone", "unsupported_build"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** The receipt a Stop answers, and the same one again for the same request id. */
export interface StopReceipt {
  readonly requestId: string;
  readonly outcome: StopOutcome;
  /** Set on a refusal, and `dialog_open` on a `pressed` receipt whose read-back shows a dialog the key opened. */
  readonly reason?: StopReason;
  /** The keys pressed, by name. Absent on a refusal. */
  readonly keys?: readonly string[];
  /**
   * On `stopped` or `pressed`: the request ids of this pane's queued sends whose text a read-back after
   * the key showed back in the input box (the harness returned its queue to the box, ADR 0122). Only
   * what a read showed, never a guess; absent when none came back, and from an older bridge.
   */
  readonly returned?: readonly string[];
}

/** The request id's grammar is the Send Protocol's: see `REQUEST_ID` in ./send. */
