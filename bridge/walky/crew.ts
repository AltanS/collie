// Walky talky across a crew (M62 spec 03, CREW_PROTOCOL.md §21). A message between two machines
// always travels through the lead, the only topology the trust store supports: a member pins only its
// lead, and the lead pins every member (§8.1).
//
//   member → lead   `POST /crew/v1/walky`, body: the signed message. It carries §8.6's request
//                   signature, so the lead knows which member dialled. The lead then checks the
//                   message's own signature against that member's pinned certificate, and that the
//                   message names that member as its sender and signer.
//   lead → member   `POST /crew/v1/pane/<pane | all>/walky`, body `{ message, attest, sender? }`.
//                   `attest` is the lead's signature over `attestationString` (canonical.ts): it binds
//                   the message, the crew and the receiving member. The member checks it against its
//                   pinned lead. `sender` (added 2026-10-18) is the sending member's certificate and
//                   the lead's voucher for it, on a message from another member of the roster.
//   lead → member   `POST /crew/v1/walky/outcomes`, body `{ receipts }` (added 2026-10-18): how the
//                   messages that member sent to other machines ended.
//
// Trust, in one line: a member verifies its lead's attestation, and the origin through a certificate
// its lead vouched for. A member pins only its lead, so it checks the sender's own signature when the
// lead itself sent the message, or when the lead sent the sender's certificate with a voucher for it:
// `verified` is then `origin`, and `lead` otherwise.
//
// The outcome comes back on the sweep: a member reports the receipts it wrote for messages from
// elsewhere on its `/crew/v1/snapshot` answers (`walky: { receipts, cursor }`) until the lead acks
// the cursor, and the lead writes them into its own log. The lead then pushes each outcome of a
// member's own message back to that member (`WalkyLeadSide`), so the sender learns it too.
//
// Every verification failure is the uniform 401 (§8.1); a malformed body from an admitted caller is
// a 400 that may say why (§8.5).

import { randomBytes } from "node:crypto";

import type { JsonObject, JsonValue } from "../json.ts";
import { fingerprintOfCert } from "../crew/identity.ts";
import type { PeerSnapshotBody } from "../crew/merge.ts";
import { signCanonical, verifyCanonical } from "../crew/signing.ts";
import type { TrustedMember, TrustStoreData } from "../crew/trust-store.ts";
import { bareAddress, INSTANCE_TOKEN, isPaneId, isScopeAddress, labelOf, LOCAL_MEMBER, paneAddress, parseAddress, type WalkyAddress } from "./address.ts";
import { attestationString, verifyMessage, voucherString } from "./canonical.ts";
import { cleanBody } from "./clean.ts";
import type { RouteRemote } from "./deliver.ts";
import type { LogRecord, WalkyLog } from "./log.ts";
import { readCrewDelivery, readErrorText, readMessage, readOutcomesPush, readReceiptsAnswer, readWalkyCursor, type CrewSenderBlock, type WalkyReportBody } from "./parse.ts";
import type { WalkyService } from "./service.ts";
import { movesForward, receiptReason, WALKY_BODY_MAX, WALKY_HARNESS_MAX, WALKY_LABEL_MAX, type WalkyMessage, type WalkyReceipt, type WalkyReceiptState, type WalkySkipped, type WalkyTarget, type WalkyVerified } from "./types.ts";

/** The member-to-lead route, under the crew prefix: `POST /crew/v1/walky`. */
export const CREW_WALKY_ROUTE = "walky";
/** The pane segment of the lead-to-member route when the message names a whole machine. */
export const WALKY_ALL_SEGMENT = "all";
/** The sibling of a member's snapshot body that carries its walky report (§21). */
export const WALKY_REPORT_FIELD = "walky";
/** The most receipts one report holds. The oldest goes first. */
export const WALKY_REPORT_MAX = 100;
/**
 * How many pane targets one message may gain on one member from a receipt naming a pane under a leg
 * sent as a whole (`<member>/all`, `all`): a member's report on the lead, the lead's push on the
 * sender (§21, added 2026-10-18). Far above any machine's agent panes.
 */
export const WALKY_LEG_PANES_MAX = 50;
/**
 * The request header the lead's sweep carries to ack a member's report (§21, added 2026-10-18): the
 * cursor of the last report it read from that member. Absent: nothing is acked, as before.
 */
export const WALKY_ACK_HEADER = "X-Crew-Walky-Ack";
/** The lead-to-member route of the outcomes push, under the crew prefix: `POST /crew/v1/walky/outcomes`. */
export const WALKY_OUTCOMES_ROUTE = "walky/outcomes";
/** The most receipts the lead holds for one member's outbox. The oldest goes first. */
export const WALKY_OUTBOX_MAX = 100;

/** One answer of a crew route: a status and a JSON body. The router and the dispatch frame it. */
export interface CrewAnswer {
  readonly status: number;
  readonly body: { readonly error: string } | { readonly receipts: readonly WalkyReceipt[] } | { readonly written: number };
}

const UNAUTHORIZED: CrewAnswer = { status: 401, body: { error: "unauthorized" } };

function badRequest(error: string): CrewAnswer {
  return { status: 400, body: { error } };
}

/** A body as the sender's bridge cleans it: not empty, within the cap, and unchanged by a second clean. */
function cleanEnough(body: string): boolean {
  return body !== "" && [...body].length <= WALKY_BODY_MAX && cleanBody(body).body === body;
}

/** An address a crew hop may carry: `all`, a scope (M75), or one that names its member (`local` is a solo word). */
function crewAddressable(to: string): boolean {
  const address = parseAddress(to);
  if (address === null) return false;
  if (address.kind === "all" || isScopeAddress(address)) return true;
  return address.memberId !== LOCAL_MEMBER;
}

/**
 * Whether a route segment names an address on this member. A scope (M75) names no member: the lead
 * expanded it and routes it one pane at a time, so its segment is a pane id, never `all`, and the
 * member checks that pane's label against the scope itself (deliver.ts `scopeDelivery`).
 */
function routeFits(to: WalkyAddress, self: string, segment: string): boolean {
  if (to.kind === "all") return segment === WALKY_ALL_SEGMENT;
  if (isScopeAddress(to)) return segment !== WALKY_ALL_SEGMENT && isPaneId(segment);
  if (to.memberId !== self) return false;
  return to.kind === "member-all" ? segment === WALKY_ALL_SEGMENT : segment === to.paneId;
}

/** Printable ASCII with no bracket or parenthesis: the characters a header field may carry. */
const DISPLAY_FIELD = /^[\x20-\x7e]*$/u;
const FRAMES = /[[\]()]/u;

function displayField(value: string, max: number): boolean {
  return value.length <= max && DISPLAY_FIELD.test(value) && !FRAMES.test(value);
}

/** Whether a value holds a C0, DEL or C1 control byte: LF and CR among them. */
function hasControl(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** What the shape check found: nothing, a 400 that may say why, or the uniform 401. */
export type CrewMessageProblem = { readonly status: 400; readonly error: string } | { readonly status: 401 } | null;

/**
 * THE ONE SHAPE CHECK of a message that crossed a crew hop, shared by both directions (M62 hardening
 * B). It runs on the message as it arrived, before any signature, and it is the rule for:
 *
 *   - every signed string field (`id`, `kind`, `from.memberId`, `from.address`, `from.harness`, `to`,
 *     `replyTo`, `signer`): no line break or other control byte, and never the bare `-`, which is how
 *     the canonical string spells a null (an LF would let one field pose as two, a `-` as a null);
 *   - `from.memberId === signer`: the machine that signed is the machine that sent;
 *   - an agent's `from.address` names a pane on the signer's member; an operator names no address and
 *     no harness;
 *   - `from.label` and `from.harness`: printable ASCII with no `[ ] ( )`, at most 48 and 32 characters;
 *   - the body as the sender's bridge cleans it, and an address that names its member.
 *
 * A malformed field is a 400 that says why (the caller passed both factors, §8.5); a claim that does
 * not match the signer is the uniform 401 (§8.1).
 */
export function checkCrewMessage(message: WalkyMessage): CrewMessageProblem {
  const signed = [message.id, message.kind, message.from.memberId, message.from.address, message.from.harness, message.to, message.replyTo, message.signer];
  if (signed.some((value) => value !== null && (hasControl(value) || value === "-"))) {
    return { status: 400, error: "a signed field holds a line break or a bare `-`" };
  }
  if (!displayField(message.from.label, WALKY_LABEL_MAX)) return { status: 400, error: "the sender's label is not a header field of at most 48 characters" };
  if (message.from.harness !== null && !displayField(message.from.harness, WALKY_HARNESS_MAX)) {
    return { status: 400, error: "the sender's harness is not a header field of at most 32 characters" };
  }
  if (!cleanEnough(message.body)) return { status: 400, error: "a walky message needs a clean body of at most 4000 characters" };
  if (message.kind === "operator" && (message.from.address !== null || message.from.harness !== null)) {
    return { status: 400, error: "the sender's address does not fit its kind" };
  }
  if (message.kind === "agent" && message.from.address === null) return { status: 400, error: "the sender's address does not fit its kind" };
  if (!crewAddressable(message.to)) return { status: 400, error: "an address on a crew names its member" };
  // The machine that signed is the machine that sent, and an agent's pane is on that machine.
  if (message.signer === null || message.from.memberId !== message.signer) return { status: 401 };
  if (message.from.address !== null) {
    const from = parseAddress(message.from.address);
    if (from === null || from.kind !== "pane" || from.memberId !== message.signer) return { status: 401 };
  }
  return null;
}

/** A shape problem as the route's answer. */
function answerOf(problem: Exclude<CrewMessageProblem, null>): CrewAnswer {
  return problem.status === 401 ? UNAUTHORIZED : badRequest(problem.error);
}

export type Checked<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly answer: CrewAnswer };

/**
 * The lead's check of a message a member sent it. `signer` is the member §8.6's request signature
 * named, never a body field. The order is the rule: shape first (the caller passed both factors),
 * then the claims against the signer, then the message signature.
 */
export function checkFromMember(body: JsonValue | undefined, signer: TrustedMember): Checked<{ readonly message: WalkyMessage }> {
  const message = readMessage(body);
  if (message === null) return { ok: false, answer: badRequest("a walky message needs a well-formed message") };
  const problem = checkCrewMessage(message);
  if (problem !== null) return { ok: false, answer: answerOf(problem) };
  // The member that dialled is the signer, so (by the shape check) the sender and the machine of the
  // sender's pane. A member never speaks for another: the crew secret is crew-wide, the signature is
  // not (§8.6).
  if (message.signer !== signer.memberId) return { ok: false, answer: UNAUTHORIZED };
  if (!verifyMessage(message, signer.certPem)) return { ok: false, answer: UNAUTHORIZED };
  return { ok: true, message };
}

/**
 * Whether a sender block holds: the voucher is the lead's signature over this crew, the message's
 * signer and the fingerprint of `certPem`, and the message's own signature verifies against `certPem`.
 */
function senderHolds(sender: CrewSenderBlock, message: WalkyMessage, lead: TrustedMember, crewId: string): boolean {
  const fingerprint = fingerprintOfCert(sender.certPem);
  if (fingerprint === null || message.signer === null) return false;
  if (!verifyCanonical(lead.certPem, sender.voucher, voucherString(crewId, message.signer, fingerprint))) return false;
  return verifyMessage(message, sender.certPem);
}

/**
 * A member's check of a message its lead routed to it. `segment` is the pane segment of the route,
 * already decoded; `self` is this member's id. The attestation is checked against the pinned lead;
 * the origin signature too: against the lead's own certificate when the lead sent the message, or
 * against the sender's certificate when the lead vouched for it in a `sender` block. A sender block
 * that does not hold is the uniform 401: it is a claim that does not verify. Nothing in it is pinned
 * or stored; the voucher is the lead's word for this one message.
 */
export function checkFromLead(
  body: JsonValue | undefined,
  segment: string,
  lead: TrustedMember,
  crewId: string,
  self: string,
): Checked<{ readonly message: WalkyMessage; readonly verified: WalkyVerified }> {
  const delivery = readCrewDelivery(body);
  if (delivery === null) return { ok: false, answer: badRequest("a walky delivery needs a well-formed `message` and `attest`") };
  const { message, attest, sender } = delivery;
  if (!verifyCanonical(lead.certPem, attest, attestationString(message, crewId, self))) return { ok: false, answer: UNAUTHORIZED };
  const problem = checkCrewMessage(message);
  if (problem !== null) return { ok: false, answer: answerOf(problem) };
  if (sender !== undefined && !senderHolds(sender, message, lead, crewId)) return { ok: false, answer: UNAUTHORIZED };
  // The route names the pane the message is for: its own pane id, or `all` for a whole machine.
  const to = parseAddress(message.to);
  const fits = to !== null && routeFits(to, self, segment);
  if (!fits) return { ok: false, answer: badRequest("the route does not name this message's address on this member") };
  // A sender block that held: the sender's own signature verified, against a certificate the lead vouched for.
  if (sender !== undefined) return { ok: true, message, verified: "origin" };
  // `origin` when the lead itself sent it: the one certificate a member pins, the signer and the
  // sender the same machine, and the signature good over the message as it stands.
  const fromLead = message.signer === lead.memberId && message.from.memberId === message.signer;
  const verified: WalkyVerified = fromLead && verifyMessage(message, lead.certPem) ? "origin" : "lead";
  return { ok: true, message, verified };
}

/** The lead's signature beside a message it routes to `receiver`. */
export function attestFor(message: WalkyMessage, keyPem: string, crewId: string, receiver: string): string {
  return signCanonical(keyPem, attestationString(message, crewId, receiver));
}

/**
 * The sender block the lead adds beside a message from `memberId`: the certificate it pinned for that
 * member and its voucher for it. Null when the certificate does not parse (no fingerprint to vouch for).
 */
export function senderBlockFor(memberId: string, certPem: string, keyPem: string, crewId: string): CrewSenderBlock | null {
  const fingerprint = fingerprintOfCert(certPem);
  if (fingerprint === null) return null;
  return { certPem, voucher: signCanonical(keyPem, voucherString(crewId, memberId, fingerprint)) };
}

/** One audit line, as the bridge's audit log takes it. */
export type WalkyAudit = (entry: { readonly action: string; readonly detail: JsonObject }) => void;

export interface WalkyCrewDeps {
  readonly service: WalkyService;
  /** The trust store as it stands, read per request: a rotation or a re-join changes it under a running bridge. */
  readonly trust: () => TrustStoreData | null;
  readonly audit?: WalkyAudit;
  readonly now?: () => number;
}

/**
 * How far a message's `at` may sit from this bridge's clock, either way, on a crew hop (M62 hardening
 * E). Past it the message is refused `stale`: a replay a day later, or a sender whose clock is wrong.
 */
export const STALE_MS = 10 * 60 * 1000;

/** Whether a message's clock is inside the window. */
export function fresh(message: Pick<WalkyMessage, "at">, now: number): boolean {
  return Math.abs(now - message.at) <= STALE_MS;
}

/** The two receiving halves, built once in index.ts and handed to the router and the dispatch. */
export class WalkyCrew {
  private readonly now: () => number;

  constructor(private readonly deps: WalkyCrewDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** `POST /crew/v1/walky` on the lead. `member` is the member the request signature named. */
  async fromMember(body: JsonValue | undefined, member: TrustedMember): Promise<CrewAnswer> {
    const checked = checkFromMember(body, member);
    if (!checked.ok) return checked.answer;
    const { message } = checked;
    if (!fresh(message, this.now())) return { status: 200, body: { receipts: [this.deps.service.deliverer.refusal(message.id, message.to, "stale", "origin")] } };
    this.deps.audit?.({ action: "walky.send", detail: { via: "crew", from: member.memberId, to: message.to, textLength: message.body.length } });
    // Delivered here, and routed on to every other member it names: `localOnly` is false on a lead.
    // `via`: the member's outer bucket, 60 tokens per 10 minutes on this lead.
    return { status: 200, body: { receipts: await this.deps.service.receive(message, "origin", false, member.memberId) } };
  }

  /** `POST /crew/v1/pane/<segment>/walky` on a member, from the dispatch. `from` is the admitted caller. */
  async fromLead(segment: string, body: JsonValue | undefined, from: string): Promise<CrewAnswer> {
    const data = this.deps.trust();
    const lead = data?.lead ?? null;
    const crewId = data?.crew?.crewId ?? null;
    if (data === null || lead === null || lead.status !== "enrolled" || crewId === null || lead.memberId !== from) return UNAUTHORIZED;
    const checked = checkFromLead(body, segment, lead, crewId, data.self.memberId);
    if (!checked.ok) return checked.answer;
    const { message, verified } = checked;
    if (!fresh(message, this.now())) return { status: 200, body: { receipts: [this.deps.service.deliverer.refusal(message.id, message.to, "stale", verified)] } };
    this.deps.audit?.({ action: "walky.deliver", detail: { via: "crew", from, to: message.to, verified, textLength: message.body.length } });
    // This machine's panes only: a message a crew hop brought is never routed on. A scope (M75) is
    // delivered to the one pane the route names, and only while that pane's label sits in the scope.
    const pane = isScopeAddress(parseAddress(message.to)) ? segment : undefined;
    return { status: 200, body: { receipts: await this.deps.service.receive(message, verified, true, undefined, pane) } };
  }

  /**
   * `POST /crew/v1/walky/outcomes` on a member (§21, added 2026-10-18). `from` is the admitted caller,
   * and only this member's own lead may push: anyone else is the uniform 401. Answers how many
   * receipts were written (`writeOutcomes` decides which).
   */
  outcomes(body: JsonValue | undefined, from: string): CrewAnswer {
    const data = this.deps.trust();
    const lead = data?.lead ?? null;
    if (data === null || lead === null || lead.status !== "enrolled" || lead.memberId !== from) return UNAUTHORIZED;
    const receipts = readOutcomesPush(body);
    if (receipts === null) return badRequest("an outcomes push needs a `receipts` list");
    return { status: 200, body: { written: writeOutcomes(this.deps.service.log, data.self.memberId, receipts) } };
  }
}

/**
 * The member's half of the outcomes push: write each receipt its lead sent for a message THIS member
 * sent to another machine. A receipt is written only when this member's log holds a record for that
 * id and target whose message names this member as its sender, and only when it moves forward
 * (`movesForward`, the `mergeReport` rule, so a resent receipt is skipped). A receipt for a pane on this
 * machine is never taken: this member's own outcome is its own word. Answers how many were written.
 */
export function writeOutcomes(log: WalkyLog, self: string, receipts: readonly WalkyReceipt[]): number {
  let written = 0;
  for (const receipt of receipts) {
    if (!canonicalTarget(receipt.target)) continue;
    const address = parseAddress(receipt.target);
    // A scope's own line is the sender's word on its own machine: the lead never sends one back.
    if (address === null || isScopeAddress(address) || (address.kind !== "all" && address.memberId === self)) continue;
    const held = log.get(receipt.id, receipt.target);
    if (held === null) {
      // A pane of a leg this member sent as a whole and never heard pane by pane (a slow leg): the
      // same rule as the lead's `mergeReport`, a target of its own under this member's message.
      const leg = address.kind === "pane" ? legOf(log, receipt.id, address.memberId) : null;
      if (leg === null || leg.message.from.memberId !== self) continue;
      log.record(leg.message, receipt.target, { session: null, paneId: null, instance: null }, receipt);
      written += 1;
      continue;
    }
    if (held.message.from.memberId !== self || !movesForward(held.receipt, receipt)) continue;
    log.update(receipt);
    written += 1;
  }
  return written;
}

/** Whether a receipt's target is in the one form this crew logs: bare (`bareAddress`) and trimmed. */
function canonicalTarget(target: string): boolean {
  return target === bareAddress(target.trim());
}

/**
 * The record a pane receipt on `memberId` lands under when the log holds none for that pane: the leg
 * this machine sent there as a whole, `<memberId>/all` or `all`. Null when there is none, or when the
 * message already holds {@link WALKY_LEG_PANES_MAX} pane targets on that member.
 */
function legOf(log: WalkyLog, id: string, memberId: string): LogRecord | null {
  const leg = log.get(id, `${memberId}/all`) ?? log.get(id, "all");
  if (leg === null) return null;
  const panes = log.all(id).filter((record) => record.target.startsWith(`${memberId}/`) && record.target !== `${memberId}/all`).length;
  return panes >= WALKY_LEG_PANES_MAX ? null : leg;
}

// ── Sending: the two RouteRemote seams ───────────────────────────────────────────────────────────

/** One receipt the routing bridge writes itself, for a target it could not reach. */
function ownReceipt(message: WalkyMessage, target: string, state: WalkyReceiptState, by: string, at: number, reason?: string): WalkyReceipt {
  const base: WalkyReceipt = { id: message.id, target, state, verified: "local", at, by };
  // A dial's reason can be the far side's own error text: cleaned to the form every reader keeps.
  const clean = receiptReason(reason);
  return clean === undefined ? base : { ...base, reason: clean };
}

/** What one dial to the other side came to. */
export type CrewDialAnswer =
  /** The far side answered: its status and its JSON body (null when the body would not parse). */
  | { readonly kind: "answer"; readonly status: number; readonly body: JsonValue | null }
  /** Nothing was taken: the link refused before anything reached a pane. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The request may have landed: never re-sent (§10.3). */
  | { readonly kind: "unknown"; readonly reason: string };

/** The receipts one answer stands for. A peer's own refusal statuses are named, never retried. */
export function receiptsOfAnswer(message: WalkyMessage, target: string, answer: CrewDialAnswer, by: string, at: number, older: string): WalkyReceipt[] {
  if (answer.kind === "refused") return [ownReceipt(message, target, "refused", by, at, answer.reason)];
  if (answer.kind === "unknown") return [ownReceipt(message, target, "unknown", by, at, answer.reason)];
  if (answer.status === 200) {
    const receipts = readReceiptsAnswer(answer.body ?? undefined).filter((receipt) => receipt.id === message.id);
    return receipts.length > 0 ? receipts : [ownReceipt(message, target, "accepted", by, at)];
  }
  // A build that predates the route answers the crew's own 404 (§21, compatibility).
  if (answer.status === 404) return [ownReceipt(message, target, "refused", by, at, older)];
  if (answer.status === 401) return [ownReceipt(message, target, "refused", by, at, "signature")];
  const error = readErrorText(answer.body ?? undefined);
  return [ownReceipt(message, target, "refused", by, at, error === null ? `crew: HTTP ${String(answer.status)}` : `crew: ${error}`)];
}

export interface LeadRouteDeps {
  /** This lead's member id, the `by` of the receipts it writes itself. */
  readonly self: string;
  /** Every member this lead leads and may route to. Read per message. */
  readonly members: () => readonly string[];
  /** This lead's key and crew id, or null when the store cannot give them. Read per message. */
  readonly signing: () => { readonly keyPem: string; readonly crewId: string } | null;
  /**
   * The certificate this lead pinned for an ENROLLED member of its roster, or null (§21, added
   * 2026-10-18). A message signed by such a member travels with a `sender` block, so the receiving
   * member can check the signature itself. Absent: no message carries one, as before.
   */
  readonly senderCert?: (memberId: string) => string | null;
  /** POST one body to `/crew/v1/pane/<segment>/walky` on one member, through the lead's forward. */
  readonly post: (memberId: string, segment: string, payload: string) => Promise<CrewDialAnswer>;
  /**
   * Whether a member's reported version predates walky talky (`olderThanWalky`). Such a member is
   * refused `older member` at once, without a dial; its 404 stays the backstop for one that reported
   * nothing. Absent: every member is dialled.
   */
  readonly older?: (memberId: string) => boolean;
  /** How long one member's leg may take before it is `unknown: member slow`. Default {@link WALKY_LEG_MS}. */
  readonly legMs?: number;
  readonly now?: () => number;
}

/**
 * The most one member's leg may take, all of it: the dial, the answer's headers and its body. The
 * forward's own write budget bounds the dial to the headers only, and the phone gives up at 20 s, so a
 * broadcast must answer well inside that whatever a member does. Past it the leg is the lead's own
 * `unknown` (the member may still deliver, and its report then updates the leg), never `refused`.
 */
export const WALKY_LEG_MS = 8000;

/** The reason a leg that ran out of {@link WALKY_LEG_MS} carries. */
export const MEMBER_SLOW = "member slow";

/** The work, or null once `ms` passed. The timer never keeps the process alive. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first release that carries walky talky (CREW_PROTOCOL §21). */
export const WALKY_FIRST_VERSION = "1.23.0";

/**
 * Whether a member's reported version is too old for walky talky: below 1.23.0, or, on a lead built
 * before 1.23.0 (a development build that carries the feature), below the lead's own version. A
 * member that reported no version is never called older: the 404 answers for it. `compare` is
 * semver's (bridge/update.ts `compareSemver`), passed in so this file holds no release logic.
 */
export function olderThanWalky(version: string | null, own: string, compare: (a: string, b: string) => number): boolean {
  // A version that names no release (`unknown`, a hash) is not called older either.
  if (version === null || !/^\d+\.\d+\.\d+/u.test(version)) return false;
  const floor = /^\d+\.\d+\.\d+/u.test(own) && compare(own, WALKY_FIRST_VERSION) < 0 ? own : WALKY_FIRST_VERSION;
  return compare(version, floor) < 0;
}

/** One dial of the lead's seam: the member, the route's pane segment, and the target its receipts name. */
interface Leg {
  readonly memberId: string;
  readonly segment: string;
  readonly target: string;
}

/**
 * The lead's seam: a message for another member goes to `/crew/v1/pane/<pane | all>/walky` there,
 * with the lead's attestation beside it. `all` goes to every member but the sender's own machine,
 * which delivered to its panes itself before it asked the lead. A scope (M75, `panes` given) goes to
 * one member, one leg per pane the lead's expansion named there, the sender's own machine included:
 * the sender's machine handed the scope over whole and delivered nothing itself.
 */
export function leadRouteRemote(deps: LeadRouteDeps): RouteRemote {
  const now = deps.now ?? Date.now;
  return async (message, members, panes) => {
    const roster = deps.members();
    const address = parseAddress(message.to);
    const whole = address?.kind === "pane" ? address.paneId : WALKY_ALL_SEGMENT;
    const legs: Leg[] =
      panes !== undefined
        ? panes.map((paneId) => ({ memberId: members, segment: paneId, target: `${members}/${paneId}` }))
        : (members === WALKY_ALL_SEGMENT ? roster.filter((id) => id !== message.from.memberId && id !== deps.self) : [members]).map((memberId) => ({
            memberId,
            segment: whole,
            // A receipt names the pane id, never the instance token the address may carry.
            target: members === WALKY_ALL_SEGMENT ? `${memberId}/${WALKY_ALL_SEGMENT}` : bareAddress(message.to),
          }));
    const signing = deps.signing();
    // One block per message: the voucher names the sender, not the receiver. Never for this lead's own
    // message, which every member checks against the one certificate it pins already.
    const signer = message.signer;
    const senderCert = signing === null || signer === null || signer === deps.self ? null : (deps.senderCert?.(signer) ?? null);
    const sender = senderCert === null || signing === null || signer === null ? null : senderBlockFor(signer, senderCert, signing.keyPem, signing.crewId);
    const lists = await Promise.all(
      legs.map(async ({ memberId, segment, target }): Promise<WalkyReceipt[]> => {
        if (!roster.includes(memberId)) return [ownReceipt(message, target, "refused", deps.self, now(), "no such member")];
        if (deps.older?.(memberId) === true) return [ownReceipt(message, target, "refused", deps.self, now(), "older member")];
        if (signing === null) return [ownReceipt(message, target, "refused", deps.self, now(), "no crew key")];
        const attest = attestFor(message, signing.keyPem, signing.crewId, memberId);
        // Every member is dialled at once, and each leg is cut at WALKY_LEG_MS.
        const body = sender === null ? { message, attest } : { message, attest, sender };
        const answer = await within(deps.post(memberId, segment, JSON.stringify(body)), deps.legMs ?? WALKY_LEG_MS);
        if (answer === null) return [ownReceipt(message, target, "unknown", deps.self, now(), MEMBER_SLOW)];
        const receipts = receiptsOfAnswer(message, target, answer, deps.self, now(), "older member");
        // Only a 200 carries the member's own receipts; every other answer is this lead's word.
        if (answer.kind !== "answer" || answer.status !== 200) return receipts;
        const scoped = scopedToMember(receipts, memberId, target, panes !== undefined);
        return scoped.length > 0 ? scoped : [ownReceipt(message, target, "accepted", deps.self, now())];
      }),
    );
    return lists.flat();
  };
}

/**
 * A member's answer, as the lead may believe it: a member speaks for its own panes only. A receipt it
 * wrote for one of them keeps its target. One it wrote for the message as a whole (a refusal names the
 * message's own `to`, which for a broadcast is `all`) stands for the leg the lead dialled, so it takes
 * that leg's target: without this, one member's `off` would overwrite the lead's own `all` line and
 * read as the whole broadcast refused. A receipt in another machine's name (this lead's included), or
 * for a pane on another machine, is dropped.
 */
function scopedToMember(receipts: readonly WalkyReceipt[], memberId: string, target: string, onePane: boolean): WalkyReceipt[] {
  return receipts.flatMap((receipt) => {
    if (receipt.by !== memberId) return [];
    const address = parseAddress(receipt.target);
    // A scope's leg names one pane (M75): the member answers for that pane, never for a sibling.
    if (address?.kind === "pane") return address.memberId === memberId && (!onePane || receipt.target === target) ? [receipt] : [];
    return [{ ...receipt, target }];
  });
}

export interface MemberRouteDeps {
  /** This member's id, the `by` of the receipts it writes itself. */
  readonly self: string;
  /** POST the signed message to the lead's `/crew/v1/walky`, signed per §8.6. */
  readonly post: (payload: string) => Promise<CrewDialAnswer>;
  readonly now?: () => number;
}

/** A member's seam: every message for another machine goes to the lead once, and the lead routes it. */
export function memberRouteRemote(deps: MemberRouteDeps): RouteRemote {
  const now = deps.now ?? Date.now;
  return async (message, members) => {
    const target = members === WALKY_ALL_SEGMENT ? WALKY_ALL_SEGMENT : bareAddress(message.to);
    const answer = await deps.post(JSON.stringify(message));
    return receiptsOfAnswer(message, target, answer, deps.self, now(), "older lead");
  };
}

// ── `who` on a lead ──────────────────────────────────────────────────────────────────────────────

/** One member as the lead's sweep holds it. */
export interface CrewMemberView {
  readonly memberId: string;
  readonly name: string;
  readonly reachable: boolean;
  readonly body: PeerSnapshotBody | null;
}

/**
 * Every agent pane on every member, from the bodies the lead's sweep already holds: no dial. A
 * member the lead cannot reach right now keeps its last panes, each with the state `unreachable`.
 * A pane that carries its instance token (`PaneWire.instance`) is listed as `<member>/<pane>#<token>`;
 * one from an older member, with no token, as `<member>/<pane>`.
 */
export function crewTargets(members: readonly CrewMemberView[], titles: boolean): WalkyTarget[] {
  const out: WalkyTarget[] = [];
  for (const member of members) {
    const seen = new Set<string>();
    for (const pane of member.body?.agents ?? []) {
      if (pane.kind === "shell" || seen.has(pane.paneId)) continue;
      seen.add(pane.paneId);
      const branch = pane.gitHead?.kind === "branch" ? pane.gitHead.name : null;
      const facts = { paneId: pane.paneId, cwd: pane.cwd, branch, paneLabel: pane.paneLabel, terminalTitle: pane.terminalTitle };
      // The token is the member's word, already parsed at the merge (crew/merge.ts `untagPane`); checked again here.
      const instance = pane.instance !== undefined && INSTANCE_TOKEN.test(pane.instance) ? pane.instance : null;
      out.push({
        address: paneAddress(member.memberId, pane.paneId, instance),
        memberId: member.memberId,
        machine: member.name,
        harness: pane.agent,
        label: labelOf(facts, titles),
        state: member.reachable ? pane.status : "unreachable",
      });
    }
  }
  return out;
}

/**
 * The shell panes on every member, which never receive a message: the Crew page lists them as
 * skipped beside a broadcast's count. From the same bodies, with no dial.
 */
export function crewSkipped(members: readonly CrewMemberView[], titles: boolean): WalkySkipped[] {
  const out: WalkySkipped[] = [];
  for (const member of members) {
    const seen = new Set<string>();
    const shells = [...(member.body?.agents ?? []).filter((pane) => pane.kind === "shell"), ...(member.body?.shellPanes ?? [])];
    for (const pane of shells) {
      if (seen.has(pane.paneId)) continue;
      seen.add(pane.paneId);
      const branch = pane.gitHead?.kind === "branch" ? pane.gitHead.name : null;
      const facts = { paneId: pane.paneId, cwd: pane.cwd, branch, paneLabel: pane.paneLabel, terminalTitle: pane.terminalTitle };
      out.push({ address: `${member.memberId}/${pane.paneId}`, memberId: member.memberId, machine: member.name, label: labelOf(facts, titles) });
    }
  }
  return out;
}

// ── The outcome report ───────────────────────────────────────────────────────────────────────────

/** A random 8-hex epoch, minted once per bridge process: a restarted member never matches an old ack. */
export function mintEpoch(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Whether a receipt goes on the wire in a report or a push (§21): past `accepted`, or `accepted` with a
 * reason, a held send (M62 spec 02, added 2026-10-21). It still ranks as `accepted` (`stateRank`), so it
 * never goes over `unknown` or a finished state, and an older peer reads it as `accepted`.
 */
export function reportable(receipt: WalkyReceipt): boolean {
  return receipt.state !== "accepted" || receipt.reason !== undefined;
}

interface HeldReceipt {
  readonly receipt: WalkyReceipt;
  readonly seq: number;
  /** This bridge's clock when the receipt was held. Past {@link STALE_MS} it goes. */
  readonly heldAt: number;
}

export interface WalkyReportOptions {
  /** At most this many held, oldest dropped. Default {@link WALKY_REPORT_MAX}. */
  readonly max?: number;
  /** The cursor epoch. Default: a fresh one ({@link mintEpoch}). */
  readonly epoch?: string;
  readonly now?: () => number;
}

/**
 * A member's report to its lead: the receipts it wrote, for its own panes, for messages that came
 * from another machine, past `accepted` or held ({@link reportable}). Filled as the log writes them. Each held receipt gets a
 * sequence number, and the report rides every `/crew/v1/snapshot` answer with the cursor of its
 * newest receipt (`<epoch>.<seq>`) until the lead acks that cursor on a later sweep (§21, added
 * 2026-10-18). In memory only: at most {@link WALKY_REPORT_MAX}, oldest dropped, and a receipt goes
 * {@link STALE_MS} after it was held, acked or not. It is a report on the exchange, never a stored
 * state (§18.5). An older lead never acks, so it reads the same receipts for up to 10 minutes;
 * `mergeReport` skips a receipt it already holds.
 */
export class WalkyReport {
  private held: HeldReceipt[] = [];
  private seq = 0;
  readonly epoch: string;
  private readonly max: number;
  private readonly now: () => number;

  constructor(
    private readonly self: string,
    options: WalkyReportOptions = {},
  ) {
    this.max = options.max ?? WALKY_REPORT_MAX;
    this.epoch = options.epoch ?? mintEpoch();
    this.now = options.now ?? Date.now;
  }

  /**
   * Listen on a log: every receipt for a message from elsewhere, placed on a pane here, past `accepted`,
   * and a held one (`accepted` with the reason that holds it, M62 spec 02). A scope this member sent
   * (M75) counts as from elsewhere: the lead expanded it and routed this machine's panes back here,
   * so only the report tells the lead how they ended.
   */
  listen(log: WalkyLog): void {
    log.onReceipt((record) => this.note(record));
  }

  /** Hold one record's newest receipt when it belongs in the report. A newer state replaces the older. */
  note(record: LogRecord): void {
    if (record.session === null) return;
    if (record.message.from.memberId === this.self && !isScopeAddress(parseAddress(record.message.to))) return;
    if (!reportable(record.receipt)) return;
    this.held = this.held.filter((held) => !(held.receipt.id === record.receipt.id && held.receipt.target === record.receipt.target));
    this.seq += 1;
    this.held.push({ receipt: record.receipt, seq: this.seq, heldAt: this.now() });
    if (this.held.length > this.max) this.held = this.held.slice(this.held.length - this.max);
  }

  /**
   * The lead's ack, as its `X-Crew-Walky-Ack` header carried it: every receipt held at or below the
   * acked seq goes. A cursor of another epoch (a lead acking what this member's previous run sent)
   * or one that is not a cursor acks nothing.
   */
  ack(cursor: string | null): void {
    const read = readWalkyCursor(cursor);
    if (read === null || read.epoch !== this.epoch) return;
    this.held = this.held.filter((held) => held.seq > read.seq);
  }

  /** The report for one snapshot answer, or null when nothing is held. It does not empty: only an ack does. */
  report(): WalkyReportBody | null {
    const floor = this.now() - STALE_MS;
    this.held = this.held.filter((held) => held.heldAt >= floor);
    const newest = this.held.at(-1);
    if (newest === undefined) return null;
    return { receipts: this.held.map((held) => held.receipt), cursor: `${this.epoch}.${String(newest.seq)}` };
  }
}

/**
 * The lead's half: write a member's reported receipts into this lead's log. A member reports only
 * for its own panes: a receipt it did not write (`by`), for a target on another machine, or for a
 * message this lead never routed there, is dropped. Answers how many were written.
 */
export function mergeReport(log: WalkyLog, memberId: string, receipts: readonly WalkyReceipt[]): number {
  let written = 0;
  for (const receipt of receipts) {
    if (receipt.by !== memberId || !canonicalTarget(receipt.target)) continue;
    const address = parseAddress(receipt.target);
    if (address === null || address.kind !== "pane" || address.memberId !== memberId) continue;
    const held = log.get(receipt.id, receipt.target);
    if (held === null) {
      // A pane of a leg this lead routed as a whole (`<member>/all`, or `all`) that never answered
      // pane by pane (a slow member, a lost answer): the report names the pane, and it is logged as a
      // target of its own under the leg's message. Never for the member's own broadcast: the lead
      // routed none of it to the sender's machine. At most WALKY_LEG_PANES_MAX panes per message.
      const leg = legOf(log, receipt.id, memberId);
      if (leg === null || leg.message.from.memberId === memberId) continue;
      log.record(leg.message, receipt.target, { session: null, paneId: null, instance: null }, receipt);
      written += 1;
      continue;
    }
    // Only a move forward: a finished outcome is never replaced (types.ts `movesForward`).
    if (!movesForward(held.receipt, receipt)) continue;
    log.update(receipt);
    written += 1;
  }
  return written;
}

// ── The lead's side of the exchange (§21, added 2026-10-18) ─────────────────────────────────────

export interface WalkyLeadSideDeps {
  /** This lead's member id. Its own messages are never pushed: their outcome is on this machine. */
  readonly self: string;
  /** The lead's walky log. A member's report is merged into it. */
  readonly log: WalkyLog;
  /** POST one `{ receipts }` body to `/crew/v1/walky/outcomes` on one member. */
  readonly push: (memberId: string, payload: string) => Promise<CrewDialAnswer>;
  /** At most this many receipts per member's outbox, oldest dropped. Default {@link WALKY_OUTBOX_MAX}. */
  readonly max?: number;
  readonly now?: () => number;
  /** How a push is put off the current tick, so one burst of receipts goes as one POST. Default: a 0 ms timer. */
  readonly later?: (work: () => void) => void;
}

/** A batch the lead sent, keyed as the outbox keys it, so a newer receipt for the same key survives. */
type Batch = ReadonlyMap<string, HeldReceipt>;

function outboxKey(receipt: Pick<WalkyReceipt, "id" | "target">): string {
  return `${receipt.id}\u0000${receipt.target}`;
}

/**
 * The lead's half of the walky exchange with each member, in memory only.
 *
 *   The ack. The cursor of the last report it read from each member, sent back on the next sweep
 *   dial of that member's snapshot as `X-Crew-Walky-Ack`. A lead restart starts with none, and the
 *   member's resend is harmless.
 *
 *   The outbox. Every receipt this lead's log writes, past `accepted` or held, for a message a member sent
 *   to another machine (this lead's own deliveries, and the lines `mergeReport` writes), held for that
 *   member: at most {@link WALKY_OUTBOX_MAX}, and {@link STALE_MS} each. It is pushed with
 *   `POST /crew/v1/walky/outcomes` at once, and again on each sweep while it is not empty. A 200
 *   empties what was sent. A 404 (a member before the push) drops the batch, and the member is pushed
 *   again only when a new receipt settles. A refused or unknown outcome keeps it for the next sweep.
 */
export class WalkyLeadSide {
  private readonly cursors = new Map<string, string>();
  private readonly boxes = new Map<string, Map<string, HeldReceipt>>();
  /** Members that answered the push 404: pushed again only when a new receipt settles. */
  private readonly parked = new Set<string>();
  /** Members with a push on the wire, and those with a push asked for meanwhile. */
  private readonly flying = new Set<string>();
  private readonly again = new Set<string>();
  private readonly scheduled = new Set<string>();
  private seq = 0;
  private readonly now: () => number;
  private readonly later: (work: () => void) => void;
  private readonly max: number;

  constructor(private readonly deps: WalkyLeadSideDeps) {
    this.now = deps.now ?? Date.now;
    this.max = deps.max ?? WALKY_OUTBOX_MAX;
    this.later =
      deps.later ??
      ((work) => {
        const timer = setTimeout(work, 0);
        timer.unref?.();
      });
  }

  /** Listen on the lead's log: every receipt it writes may belong in a member's outbox. */
  listen(): void {
    this.deps.log.onReceipt((record) => this.note(record));
  }

  // ── The ack ──

  /** A member's report, off its snapshot answer: merged into the log, and its cursor kept for the ack. */
  report(memberId: string, receipts: readonly WalkyReceipt[], cursor: string | null): number {
    const written = mergeReport(this.deps.log, memberId, receipts);
    if (cursor !== null) this.cursors.set(memberId, cursor);
    return written;
  }

  /** The cursor to ack on the next snapshot dial of a member, or null. */
  ackFor(memberId: string): string | null {
    return this.cursors.get(memberId) ?? null;
  }

  // ── The outbox ──

  /** Hold a record's newest receipt for its sender's machine, when it belongs there, and push at once. */
  note(record: LogRecord): void {
    const memberId = record.message.from.memberId;
    if (memberId === null || memberId === this.deps.self || !reportable(record.receipt)) return;
    const address = parseAddress(record.target);
    // Only for a target on another machine: the sender's own panes are the sender's word.
    if (address === null || isScopeAddress(address) || (address.kind !== "all" && address.memberId === memberId)) return;
    const box = this.boxes.get(memberId) ?? new Map<string, HeldReceipt>();
    const key = outboxKey(record.receipt);
    box.delete(key);
    this.seq += 1;
    box.set(key, { receipt: record.receipt, seq: this.seq, heldAt: this.now() });
    while (box.size > this.max) {
      const oldest = box.keys().next().value;
      if (oldest === undefined) break;
      box.delete(oldest);
    }
    this.boxes.set(memberId, box);
    // A new receipt settled: a member that answered 404 is asked again.
    this.parked.delete(memberId);
    this.schedule(memberId);
  }

  /** The receipts held for one member, oldest first. */
  pending(memberId: string): WalkyReceipt[] {
    this.prune(memberId);
    return [...(this.boxes.get(memberId)?.values() ?? [])].map((held) => held.receipt);
  }

  /** The sweep answered: push every listed member whose outbox is not empty, and not parked. */
  swept(memberIds: readonly string[]): void {
    for (const memberId of memberIds) {
      if (this.parked.has(memberId) || this.pending(memberId).length === 0) continue;
      void this.flush(memberId);
    }
  }

  /** A member left the roster: its cursor and its outbox go. */
  forget(memberId: string): void {
    this.cursors.delete(memberId);
    this.boxes.delete(memberId);
    this.parked.delete(memberId);
  }

  private schedule(memberId: string): void {
    if (this.scheduled.has(memberId)) return;
    this.scheduled.add(memberId);
    this.later(() => {
      this.scheduled.delete(memberId);
      void this.flush(memberId);
    });
  }

  private prune(memberId: string): void {
    const box = this.boxes.get(memberId);
    if (box === undefined) return;
    const floor = this.now() - STALE_MS;
    for (const [key, held] of box) if (held.heldAt < floor) box.delete(key);
    if (box.size === 0) this.boxes.delete(memberId);
  }

  /** Drop what a batch sent, unless a newer receipt for the same key arrived meanwhile. */
  private drop(memberId: string, batch: Batch): void {
    const box = this.boxes.get(memberId);
    if (box === undefined) return;
    for (const [key, held] of batch) if (box.get(key) === held) box.delete(key);
    if (box.size === 0) this.boxes.delete(memberId);
  }

  /** One push of a member's outbox. Resolves when its answer is handled. Never rejects. */
  async flush(memberId: string): Promise<void> {
    if (this.flying.has(memberId)) {
      this.again.add(memberId);
      return;
    }
    this.prune(memberId);
    const box = this.boxes.get(memberId);
    if (box === undefined || box.size === 0) return;
    const batch: Batch = new Map(box);
    this.flying.add(memberId);
    let answer: CrewDialAnswer;
    try {
      answer = await this.deps.push(memberId, JSON.stringify({ receipts: [...batch.values()].map((held) => held.receipt) }));
    } catch (err) {
      answer = { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.flying.delete(memberId);
    }
    if (answer.kind === "answer" && answer.status === 200) this.drop(memberId, batch);
    else if (answer.kind === "answer" && answer.status === 404) {
      // A member before the push: this batch goes, and the member waits for the next receipt.
      this.drop(memberId, batch);
      this.parked.add(memberId);
    }
    // Any other answer keeps the batch for the next sweep: the member writes a receipt once, so a
    // push that did land and is sent again changes nothing there.
    // A receipt that settled while this push was on the wire is a new receipt: it goes now, 404 or not.
    if (this.again.delete(memberId)) await this.flush(memberId);
  }
}
