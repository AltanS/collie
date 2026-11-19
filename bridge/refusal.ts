import type { AuditDetail, AuditEntry, AuditLog } from "./audit.ts";
import type { DropReason } from "./surface/edges.ts";
import type { HoldRecord } from "./surface/hold.ts";
import { HOLD_SKIP_REASONS } from "../web/src/lib/surface/hold.ts";

// Every tap that reaches a bridge, and every hook request a bridge receives, leaves exactly one record
// (M102 spec 14, invariant I3 of the 2026-11-16 red team). A record is one audit line: who refused,
// the outcome, a reason code from the list below, the pane when one is known, and the line's own time.
// Never text: not a message, an answer, a command, a path of the person's project or a login. The
// phone gets the same reason code, in the `x-collie-reason` header of the refusal (and `x-collie-by`).
//
// The list is ONE exported array so a test can walk it, and so a code cannot be invented at a call
// site: {@link refusalRecord} takes only a {@link RefusalReason}.

/** The hook-socket drop reasons the edge placement names (bridge/surface/edges.ts), as they are logged. */
const PLACEMENT_DROPS = ["unparsed", "old", "foreign-mux", "no-pane", "ambiguous", "dead-pid", "not-foreground"] as const satisfies readonly DropReason[];

/** Every reason code a refusal record, or a refusal header, may carry. */
export const REFUSAL_REASONS = [
  // ── The crew forward, written by the lead (bridge/crew/forward.ts) ──
  /** The lead's poll holds the member unreachable: refused before the dial. */
  "member_unreachable",
  /** The member speaks a crew protocol this lead cannot: refused before or after the dial. */
  "member_incompatible",
  /** The member runs an older Collie that cannot take this action (a checked text, an ask by id). */
  "member_old",
  /** The dial provably never left the lead (no crew secret, an address it refuses). */
  "link_refused",
  /** The dial ran out of its budget: the member may still be doing it. */
  "link_timeout",
  /** The link broke after the request may have been written. */
  "link_lost",
  /** The phone (or the lead's own caller) went away before the answer ended: the dial was aborted for it, and a write may still have been done. */
  "caller_left",
  // ── The send and ask routes, written by the bridge that owns the pane (bridge/server.ts) ──
  /** A body the route cannot read. */
  "bad_body",
  /** No terminal pane (or conversation) by that id in this session. */
  "no_pane",
  /** The Send Protocol is off on this bridge (COLLIE_SEND_PROTOCOL=0). */
  "send_off",
  /** A Resend for a held send this pane does not keep. */
  "no_held_send",
  /** The multiplexer takes no raw input on this pane (`rawInputRefusal`). */
  "no_raw_input",
  /** Another bridge on this machine writes into the pane now (M102 spec 16, bridge/surface/pane-lock.ts): nothing was typed. */
  "pane_busy",
  // ── The hook socket, written by the bridge that received the request (bridge/surface/hold.ts) ──
  /** The request line did not arrive in time. */
  "slow",
  /** The request line was longer than the wire allows. */
  "long",
  /** The bridge failed while it placed the request. */
  "error",
  /** The pane's session takes no holds. */
  "no-hold",
  ...PLACEMENT_DROPS,
  /** The hook sent no request and said why (cli/hold.ts): the agent's environment, pid or tool. */
  ...HOLD_SKIP_REASONS,
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** Whether a string is one of {@link REFUSAL_REASONS}. */
export function isRefusalReason(value: string): value is RefusalReason {
  return REFUSAL_REASONS.some((reason) => reason === value);
}

/**
 * Who refused: the `lead` for a member's pane it refused before or after the dial, the `member` whose
 * own route refused a forwarded action, the `bridge` that owns the pane for a local refusal, and the
 * `hook` for a request the agent's hook could not make.
 */
export type RefusedBy = "lead" | "member" | "bridge" | "hook";

/** The response headers that carry a refusal's reason to the phone. The lead keeps them on a proxied answer. */
export const REASON_HEADER = "x-collie-reason";
export const REFUSED_BY_HEADER = "x-collie-by";

/** One refusal record, before it becomes an audit line. */
export interface RefusalRecord {
  /** The audit action the record belongs to: `send`, `ask`, `hold`, or the forward's own action. */
  readonly action: string;
  readonly by: RefusedBy;
  /** `refused` for a request nothing came of, `dropped` for a hook request, `unknown` for a write that may have landed. */
  readonly outcome: "refused" | "dropped" | "unknown";
  readonly reason: RefusalReason;
  readonly paneId?: string | undefined;
  readonly session?: string | undefined;
  readonly device?: string | null | undefined;
  /** The crew member a lead's record names. */
  readonly host?: string | undefined;
}

/** The audit entry of one refusal: the envelope, and `by`, `outcome` and `reason` as detail. No text. */
export function refusalEntry(record: RefusalRecord): AuditEntry {
  const detail: AuditDetail = { by: record.by, outcome: record.outcome, reason: record.reason };
  const entry: AuditEntry = { action: record.action, detail };
  if (record.host !== undefined) entry.host = record.host;
  if (record.paneId !== undefined) entry.paneId = record.paneId;
  if (record.session !== undefined) entry.session = record.session;
  if (record.device !== undefined) entry.device = record.device;
  return entry;
}

/** Write one refusal record. Never throws: an audit write must not fail the refusal it records. */
export function recordRefusal(audit: Pick<AuditLog, "record">, record: RefusalRecord): void {
  audit.record(refusalEntry(record));
}

/** A response with the refusal's reason and its author set, the body and status kept. */
export function withRefusal(res: Response, by: RefusedBy, reason: RefusalReason): Response {
  res.headers.set(REASON_HEADER, reason);
  res.headers.set(REFUSED_BY_HEADER, by);
  return res;
}

/** The audit entry of a hook request's one record (bridge/surface/hold.ts `HoldRecord`): action `hold`. */
export function holdAuditEntry(record: HoldRecord): AuditEntry {
  if (record.outcome === "placed") {
    return { action: "hold", paneId: record.paneId, session: record.session, detail: { by: "bridge", outcome: "placed" } };
  }
  const by: RefusedBy = HOLD_SKIP_REASONS.some((reason) => reason === record.reason) ? "hook" : "bridge";
  return refusalEntry({ action: "hold", by, outcome: "dropped", reason: record.reason, paneId: record.paneId, session: record.session });
}
