// "Report a problem", the rule that offers it (ADR 0123): three sends in a row on one pane that failed
// for a reason that points at Collie. Plain rules over the Send Protocol's own outcome and reason
// codes (lib/surface/send.ts), on the phone, in memory. No model, no guess about the screen and no
// harness name: a harness is data on a receipt, never a branch here.
//
// THE RULE NEVER ACTS. It offers a card; it never resends, retries or types, and it sends nothing
// anywhere. A report leaves the phone only through the person's own taps on the sheet.
//
// Pure: no DOM, no clock of its own, no storage. `store.ts` keeps one streak per pane.

import type { SendOutcome, SendReason } from "../surface/send";

/** How many counted failures in a row offer the card (Altan's pick, 2026-10-25). */
export const TROUBLE_THRESHOLD = 3;

/** The longest a streak runs: a failure more than this after the one before it starts a new streak. */
export const TROUBLE_WINDOW_MS = 10 * 60 * 1000;

/** What an outcome does to a streak: ends it (it worked), may count (its reason decides), or nothing. */
type OutcomeRule = "reset" | "failure" | "ignore";

/**
 * Every outcome, so a new one in `SEND_OUTCOMES` fails `tsc` until it has a row. `held`, `cancelled`,
 * `discarded` and `expired` neither count nor reset: none of them is the end of the trouble.
 */
const OUTCOMES = {
  effective: "reset",
  sent: "reset",
  steered: "reset",
  refused: "failure",
  typed_not_submitted: "failure",
  unknown: "failure",
  held: "ignore",
  cancelled: "ignore",
  discarded: "ignore",
  expired: "ignore",
} as const satisfies Record<SendOutcome, OutcomeRule>;

/**
 * Every reason, so a new one in `SEND_REASONS` fails `tsc` until someone decides whether it points at
 * Collie. `count`: Collie could not read or write the box, the text went in and Enter did not follow,
 * or Collie lost track of its own send. `ignore`: a guard did its job, the state is the person's (a
 * draft, a running turn, a gone pane), or a dialog is on screen and the phone already shows it.
 */
const REASONS = {
  // refused: Collie could not read or write the box
  probe_failed: "count",
  not_free: "count",
  unconfirmed: "count",
  stale_surface: "count",
  bound: "count",
  write_failed: "count",
  // typed_not_submitted: the text went in and Enter did not follow
  mismatch: "count",
  changed: "count",
  modal_cue: "count",
  stale_token: "count",
  submit_failed: "count",
  unreadable: "count",
  // unknown: Collie lost track of its own send
  crash: "count",
  lost_lock: "count",
  no_evidence: "count",
  // the guard did its job, or the state is the person's
  id_reused: "ignore",
  busy: "ignore",
  draft_present: "ignore",
  reserved_lead: "ignore",
  pane_gone: "ignore",
  multiline: "ignore",
  turn_running: "ignore",
  steer_unsupported: "ignore",
  steer_not_allowed: "ignore",
  // a dialog on screen, shown already
  dialog_open: "ignore",
  dialog_after_enter: "ignore",
} as const satisfies Record<SendReason, "count" | "ignore">;

/** One settled send as the rule reads it: the request id, the outcome and reason, and when it ended. */
export interface SettledSend {
  readonly requestId: string;
  readonly outcome: SendOutcome;
  readonly reason: SendReason | null;
  /** True on the cap's `unconfirmed` (M56 spec 09): a confirm the person owes, not a failure. */
  readonly cap?: boolean;
  /** Epoch ms. */
  readonly at: number;
}

/** What a settled send does to a pane's streak. */
export type TroubleStep = "reset" | "count" | "ignore";

/** What one settled send does to a streak, by its outcome and reason alone. */
export function troubleStep(send: Pick<SettledSend, "outcome" | "reason" | "cap">): TroubleStep {
  const rule = OUTCOMES[send.outcome];
  if (rule !== "failure") return rule;
  if (send.cap === true) return "ignore";
  // A refusal always names a reason; a typed or unknown end with none still means Enter did not follow
  // or Collie lost track, so it counts.
  if (send.reason === null) return send.outcome === "refused" ? "ignore" : "count";
  return REASONS[send.reason];
}

/**
 * One pane's streak. `sends` are the counted failures in a row, oldest first. `offered` is set when the
 * streak reached the threshold, once per streak; `closed` when the person closed the card, which keeps
 * it closed until the streak ends.
 */
export interface Trouble {
  readonly sends: readonly SettledSend[];
  readonly offered: boolean;
  readonly closed: boolean;
}

export const NO_TROUBLE: Trouble = { sends: [], offered: false, closed: false };

/**
 * The streak after one more settled send. A request id already in the streak changes nothing: a retry
 * that got the stored receipt back is the same send, counted once. A success ends the streak; a failure
 * more than {@link TROUBLE_WINDOW_MS} after the last counted one starts a new streak with itself.
 */
export function noteSettled(trouble: Trouble, send: SettledSend): Trouble {
  const step = troubleStep(send);
  if (step === "reset") return NO_TROUBLE;
  if (step === "ignore") return trouble;
  if (trouble.sends.some((counted) => counted.requestId === send.requestId)) return trouble;
  const last = trouble.sends.at(-1);
  const fresh = last === undefined || send.at - last.at > TROUBLE_WINDOW_MS;
  const sends = fresh ? [send] : [...trouble.sends, send];
  if (fresh) return { sends, offered: sends.length >= TROUBLE_THRESHOLD, closed: false };
  return { sends, offered: trouble.offered || sends.length >= TROUBLE_THRESHOLD, closed: trouble.closed };
}

/** The streak folded from settled sends, oldest first. */
export function troubleFrom(sends: readonly SettledSend[]): Trouble {
  return sends.reduce(noteSettled, NO_TROUBLE);
}

/** Whether the card shows: the streak reached the threshold and the person has not closed it. */
export function offersReport(trouble: Trouble): boolean {
  return trouble.offered && !trouble.closed;
}

/** The streak with its card closed. It stays closed until a success or a new streak. */
export function closeOffer(trouble: Trouble): Trouble {
  return trouble.offered ? { ...trouble, closed: true } : trouble;
}
