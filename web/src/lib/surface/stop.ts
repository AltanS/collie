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
 * `stopped`: the keys went in and a read within 3 s shows the turn gone and no dialog. `pressed`: the
 * keys went in and the turn still reads running (or the read could not tell). `refused`: no key left.
 */
export const STOP_OUTCOMES = ["stopped", "pressed", "refused"] as const;
export type StopOutcome = (typeof STOP_OUTCOMES)[number];

/**
 * Why a Stop pressed nothing. `no_profile`: Collie has no reader for this pane, so it does not stop it
 * blind. `turn_idle`: the turn already ended. `dialog_open`: a dialog is up and Escape would answer it.
 * `draft_present`: the box holds text and this harness's interrupt key clears it first.
 * `unreadable`: Collie cannot tell whether a turn runs on this screen. `press_failed`: the multiplexer
 * refused the keys. `pane_gone`: the multiplexer could not read the pane.
 */
export const STOP_REASONS = ["no_profile", "turn_idle", "dialog_open", "draft_present", "unreadable", "press_failed", "pane_gone"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** The receipt a Stop answers, and the same one again for the same request id. */
export interface StopReceipt {
  readonly requestId: string;
  readonly outcome: StopOutcome;
  /** Set on a refusal. */
  readonly reason?: StopReason;
  /** The keys pressed, by name. Absent on a refusal. */
  readonly keys?: readonly string[];
}

/** The request id's grammar is the Send Protocol's: see `REQUEST_ID` in ./send. */
