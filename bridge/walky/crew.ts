// Walky talky across a crew (M62 spec 03, CREW_PROTOCOL.md §21). A message between two machines
// always travels through the lead, the only topology the trust store supports: a member pins only its
// lead, and the lead pins every member (§8.1).
//
//   member → lead   `POST /crew/v1/walky`, body: the signed message. It carries §8.6's request
//                   signature, so the lead knows which member dialled. The lead then checks the
//                   message's own signature against that member's pinned certificate, and that the
//                   message names that member as its sender and signer.
//   lead → member   `POST /crew/v1/pane/<pane | all>/walky`, body `{ message, attest }`. `attest` is
//                   the lead's signature over `attestationString` (canonical.ts): it binds the message,
//                   the crew and the receiving member. The member checks it against its pinned lead.
//
// Trust, in one line: a member verifies its lead's attestation; only the lead verifies the origin.
// A member can verify the origin too when the lead itself sent the message, because that is the one
// certificate it pins: `verified` is then `origin`, and `lead` otherwise.
//
// The outcome comes back on the sweep: a member reports the receipts it wrote for messages from
// elsewhere on its next `/crew/v1/snapshot` answer (`walky: { receipts }`), and the lead writes them
// into its own log. The lead has no path to tell a member, so a member that sent to a third machine
// sees `accepted` and the words "outcome known on the lead".
//
// Every verification failure is the uniform 401 (§8.1); a malformed body from an admitted caller is
// a 400 that may say why (§8.5).

import type { JsonObject, JsonValue } from "../json.ts";
import type { PeerSnapshotBody } from "../crew/merge.ts";
import { signCanonical, verifyCanonical } from "../crew/signing.ts";
import type { TrustedMember, TrustStoreData } from "../crew/trust-store.ts";
import { labelOf, LOCAL_MEMBER, parseAddress } from "./address.ts";
import { attestationString, verifyMessage } from "./canonical.ts";
import { cleanBody } from "./clean.ts";
import type { RouteRemote } from "./deliver.ts";
import type { LogRecord, WalkyLog } from "./log.ts";
import { readCrewDelivery, readErrorText, readMessage, readReceiptsAnswer } from "./parse.ts";
import type { WalkyService } from "./service.ts";
import { WALKY_BODY_MAX, WALKY_HARNESS_MAX, WALKY_LABEL_MAX, type WalkyMessage, type WalkyReceipt, type WalkyReceiptState, type WalkySkipped, type WalkyTarget, type WalkyVerified } from "./types.ts";

/** The member-to-lead route, under the crew prefix: `POST /crew/v1/walky`. */
export const CREW_WALKY_ROUTE = "walky";
/** The pane segment of the lead-to-member route when the message names a whole machine. */
export const WALKY_ALL_SEGMENT = "all";
/** The sibling of a member's snapshot body that carries its walky report (§21). */
export const WALKY_REPORT_FIELD = "walky";
/** The most receipts one report holds. The oldest goes first. */
export const WALKY_REPORT_MAX = 100;

/** One answer of a crew route: a status and a JSON body. The router and the dispatch frame it. */
export interface CrewAnswer {
  readonly status: number;
  readonly body: { readonly error: string } | { readonly receipts: readonly WalkyReceipt[] };
}

const UNAUTHORIZED: CrewAnswer = { status: 401, body: { error: "unauthorized" } };

function badRequest(error: string): CrewAnswer {
  return { status: 400, body: { error } };
}

/** A body as the sender's bridge cleans it: not empty, within the cap, and unchanged by a second clean. */
function cleanEnough(body: string): boolean {
  return body !== "" && [...body].length <= WALKY_BODY_MAX && cleanBody(body).body === body;
}

/** An address a crew hop may carry: `all`, or one that names its member (`local` is a solo word). */
function crewAddressable(to: string): boolean {
  const address = parseAddress(to);
  return address !== null && (address.kind === "all" || address.memberId !== LOCAL_MEMBER);
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
 * A member's check of a message its lead routed to it. `segment` is the pane segment of the route,
 * already decoded; `self` is this member's id. The attestation is checked against the pinned lead;
 * the origin signature too, which verifies only when the lead itself sent the message.
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
  const { message, attest } = delivery;
  if (!verifyCanonical(lead.certPem, attest, attestationString(message, crewId, self))) return { ok: false, answer: UNAUTHORIZED };
  const problem = checkCrewMessage(message);
  if (problem !== null) return { ok: false, answer: answerOf(problem) };
  // The route names the pane the message is for: its own pane id, or `all` for a whole machine.
  const to = parseAddress(message.to);
  const fits =
    to !== null &&
    (to.kind === "all"
      ? segment === WALKY_ALL_SEGMENT
      : to.memberId === self && (to.kind === "member-all" ? segment === WALKY_ALL_SEGMENT : segment === to.paneId));
  if (!fits) return { ok: false, answer: badRequest("the route does not name this message's address on this member") };
  // `origin` only when the lead itself sent it: the one certificate a member pins, the signer and the
  // sender the same machine, and the signature good over the message as it stands.
  const fromLead = message.signer === lead.memberId && message.from.memberId === message.signer;
  const verified: WalkyVerified = fromLead && verifyMessage(message, lead.certPem) ? "origin" : "lead";
  return { ok: true, message, verified };
}

/** The lead's signature beside a message it routes to `receiver`. */
export function attestFor(message: WalkyMessage, keyPem: string, crewId: string, receiver: string): string {
  return signCanonical(keyPem, attestationString(message, crewId, receiver));
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
    // This machine's panes only: a message a crew hop brought is never routed on.
    return { status: 200, body: { receipts: await this.deps.service.receive(message, verified, true) } };
  }
}

// ── Sending: the two RouteRemote seams ───────────────────────────────────────────────────────────

/** One receipt the routing bridge writes itself, for a target it could not reach. */
function ownReceipt(message: WalkyMessage, target: string, state: WalkyReceiptState, by: string, at: number, reason?: string): WalkyReceipt {
  const base: WalkyReceipt = { id: message.id, target, state, verified: "local", at, by };
  return reason === undefined ? base : { ...base, reason };
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

/**
 * The lead's seam: a message for another member goes to `/crew/v1/pane/<pane | all>/walky` there,
 * with the lead's attestation beside it. `all` goes to every member but the sender's own machine,
 * which delivered to its panes itself before it asked the lead.
 */
export function leadRouteRemote(deps: LeadRouteDeps): RouteRemote {
  const now = deps.now ?? Date.now;
  return async (message, members) => {
    const roster = deps.members();
    const targets = members === WALKY_ALL_SEGMENT ? roster.filter((id) => id !== message.from.memberId && id !== deps.self) : [members];
    const address = parseAddress(message.to);
    const segment = address?.kind === "pane" ? address.paneId : WALKY_ALL_SEGMENT;
    const signing = deps.signing();
    const lists = await Promise.all(
      targets.map(async (memberId): Promise<WalkyReceipt[]> => {
        const target = members === WALKY_ALL_SEGMENT ? `${memberId}/${WALKY_ALL_SEGMENT}` : message.to;
        if (!roster.includes(memberId)) return [ownReceipt(message, target, "refused", deps.self, now(), "no such member")];
        if (deps.older?.(memberId) === true) return [ownReceipt(message, target, "refused", deps.self, now(), "older member")];
        if (signing === null) return [ownReceipt(message, target, "refused", deps.self, now(), "no crew key")];
        const attest = attestFor(message, signing.keyPem, signing.crewId, memberId);
        // Every member is dialled at once, and each leg is cut at WALKY_LEG_MS.
        const answer = await within(deps.post(memberId, segment, JSON.stringify({ message, attest })), deps.legMs ?? WALKY_LEG_MS);
        if (answer === null) return [ownReceipt(message, target, "unknown", deps.self, now(), MEMBER_SLOW)];
        const receipts = receiptsOfAnswer(message, target, answer, deps.self, now(), "older member");
        // Only a 200 carries the member's own receipts; every other answer is this lead's word.
        if (answer.kind !== "answer" || answer.status !== 200) return receipts;
        const scoped = scopedToMember(receipts, memberId, target);
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
function scopedToMember(receipts: readonly WalkyReceipt[], memberId: string, target: string): WalkyReceipt[] {
  return receipts.flatMap((receipt) => {
    if (receipt.by !== memberId) return [];
    const address = parseAddress(receipt.target);
    if (address?.kind === "pane") return address.memberId === memberId ? [receipt] : [];
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
    const target = members === WALKY_ALL_SEGMENT ? WALKY_ALL_SEGMENT : message.to;
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
      out.push({
        address: `${member.memberId}/${pane.paneId}`,
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

/**
 * A member's report to its lead: the receipts it wrote, for its own panes, for messages that came
 * from another machine. Filled as the log writes them and emptied by each `/crew/v1/snapshot`
 * answer. In memory only, at most {@link WALKY_REPORT_MAX}, oldest dropped: it is a report on the
 * exchange, never a stored state (§18.5), so an answer the lead never read loses those lines and
 * the lead keeps `accepted`.
 */
export class WalkyReport {
  private held: WalkyReceipt[] = [];

  constructor(
    private readonly self: string,
    private readonly max = WALKY_REPORT_MAX,
  ) {}

  /** Listen on a log: every receipt for a message from elsewhere, placed on a pane here, past `accepted`. */
  listen(log: WalkyLog): void {
    log.onReceipt((record) => this.note(record));
  }

  /** Hold one record's newest receipt when it belongs in the report. */
  note(record: LogRecord): void {
    if (record.session === null || record.message.from.memberId === this.self) return;
    if (record.receipt.state === "accepted") return;
    this.held = this.held.filter((held) => !(held.id === record.receipt.id && held.target === record.receipt.target));
    this.held.push(record.receipt);
    if (this.held.length > this.max) this.held = this.held.slice(this.held.length - this.max);
  }

  /** The report for one snapshot answer, and an empty one after it. */
  drain(): WalkyReceipt[] {
    const out = this.held;
    this.held = [];
    return out;
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
    if (receipt.by !== memberId) continue;
    const address = parseAddress(receipt.target);
    if (address === null || address.kind !== "pane" || address.memberId !== memberId) continue;
    const held = log.get(receipt.id, receipt.target);
    if (held === null) {
      // A pane of a leg this lead routed as a whole (`<member>/all`, or `all`) that never answered
      // pane by pane (a slow member, a lost answer): the report names the pane, and it is logged as a
      // target of its own under the leg's message.
      const leg = log.get(receipt.id, `${memberId}/all`) ?? log.get(receipt.id, "all");
      if (leg === null) continue;
      log.record(leg.message, receipt.target, { session: null, paneId: null }, receipt);
      written += 1;
      continue;
    }
    if (held.receipt.state === receipt.state && held.receipt.at >= receipt.at) continue;
    log.update(receipt);
    written += 1;
  }
  return written;
}
