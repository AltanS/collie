// The walky talky service: what the local socket (socket.ts) and the phone's routes (server.ts) both
// call. It builds a message from a request (cleans the body, names the sender, signs on a crew), hands
// it to delivery, and answers the reads: who is reachable, a pane's inbox, a message's receipts.
//
// Two kinds, by what the bridge proved (decision 3, hardened 2026-10-17). `agent`: the CLI ran inside a
// pane the bridge placed from the multiplexer's own markers in its environment. `operator`: a paired
// device, through `POST /api/walky`, and nothing else: the local socket refuses a send that names no
// pane, so the kind fails closed. The local uid can lie about its pane (decision 4); the docs say so.

import { isSelf, paneAddress, parseAddress, LOCAL_MEMBER } from "./address.ts";
import { signMessage } from "./canonical.ts";
import { BODY_TOO_LONG, cleanBody } from "./clean.ts";
import { CANCELLED_BY_SENDER, DROPPED_BY_OWNER, isFanOut, withoutAnsweredLegs, WalkyDeliverer, type DelivererDeps, type SenderPane, type TakeBack, type WalkyPane } from "./deliver.ts";
import { sameInstance, type LogRecord, type WalkyLog } from "./log.ts";
import type { RefusalCounts } from "./refusals.ts";
import { headerField, WALKY_LABEL_MAX, type WalkyEntry, type WalkyMessage, type WalkyReceipt, type WalkySkipped, type WalkyTarget, type WalkyVerified } from "./types.ts";

/** Who is sending: an agent's pane, or an operator by label. */
export type WalkySenderRef = { readonly kind: "agent"; readonly pane: WalkyPane } | { readonly kind: "operator"; readonly label: string };

export interface SendInput {
  readonly id: string;
  /** The address. A reply's address is the bridge's to fill: the replied-to message's sender. */
  readonly to: string | null;
  readonly body: string;
  readonly replyTo: string | null;
}

export type SendAnswer =
  | {
      readonly ok: true;
      readonly receipts: readonly WalkyReceipt[];
      /** The one pane the message went to, as `who` lists it, when this bridge knows it. */
      readonly target?: WalkyTarget;
    }
  | { readonly ok: false; readonly error: string };

export interface WalkyServiceDeps extends DelivererDeps {
  /** This machine's name, as `who` prints it. */
  readonly machine: string;
  /** The PKCS#8 key behind this collie's crew certificate, or null (solo: nothing is signed). */
  readonly keyPem: () => string | null;
  /**
   * THE CREW SEAM FOR `who`. Spec 03 fills it: the targets the lead knows on other members. Absent,
   * `who` lists this machine's panes only.
   */
  readonly remoteTargets?: () => readonly WalkyTarget[];
  /**
   * True on a crew member that is not the lead. Such a bridge hands a message for another machine to
   * its lead, and learns how it ended there only when the lead pushes the outcome back (CREW_PROTOCOL
   * §21). Until then `status` names those targets, and `who` says the other machines are the lead's
   * to list.
   */
  readonly outcomesOnLead?: boolean;
  /** On a member: its lead's member id, named in the `who` note. */
  readonly leadName?: () => string | null;
  /** On a lead: the shell panes the crew's members report, which a broadcast skips. */
  readonly remoteSkipped?: () => readonly WalkySkipped[];
}

/** What `who` on a crew member adds below its own panes: the roster is the lead's, and the command to run there. */
export function whoElsewhereNote(lead: string | null): string {
  return `other machines: run \`collie walky who\` on the lead${lead === null ? "" : ` (${lead})`}, or use the phone`;
}

/** A message's receipts on this bridge, and the message itself when the log holds it. */
export interface WalkyStatus {
  readonly receipts: WalkyReceipt[];
  readonly message: WalkyMessage | null;
  /**
   * The targets among `receipts` that are still `accepted` on another machine, on a member whose lead
   * holds their outcome until it pushes it back ({@link WalkyServiceDeps.outcomesOnLead}). Empty
   * everywhere else.
   */
  readonly elsewhere: string[];
}

/** What `cancel` answers a sender that is not the message's: the id is kept out, the caller prints it. */
export const NOT_THE_SENDER = "only the sender can cancel it";

/** A take-back's answer (M62 spec 03): one result per logged target, or why none was touched. */
export type TakeBackAnswer = { readonly ok: true; readonly results: readonly TakeBack[] } | { readonly ok: false; readonly error: string };

/** Who asks to take a message back: the agent in a pane of this bridge, or the operator on a paired device. */
export type TakeBackRef = { readonly kind: "agent"; readonly pane: WalkyPane } | { readonly kind: "operator" };

/** A message with its newest receipt. */
function entryOf(message: WalkyMessage, receipt: WalkyReceipt): WalkyEntry {
  return { ...message, receipt };
}

export class WalkyService {
  readonly deliverer: WalkyDeliverer;
  private readonly now: () => number;

  constructor(private readonly deps: WalkyServiceDeps) {
    this.deliverer = new WalkyDeliverer(deps);
    this.now = deps.now ?? Date.now;
  }

  get log(): WalkyLog {
    return this.deps.log;
  }

  /** The pane at one place, or null. */
  paneAt(session: string, paneId: string): WalkyPane | null {
    return this.deps.host.panes().find((pane) => pane.session === session && pane.paneId === paneId) ?? null;
  }

  /** The instance token a pane of this bridge holds now, or null when no such pane is there. */
  instanceOf(session: string, paneId: string): string | null {
    return this.paneAt(session, paneId)?.instance ?? null;
  }

  /** The address of a pane of this bridge, with its instance token when given (as `who` prints it). */
  addressOf(paneId: string, instance?: string | null): string {
    return paneAddress(this.deps.memberId, paneId, instance);
  }

  /**
   * The message a reply answers, as this bridge's log holds it (M62 hardening D): for an agent, one
   * that went to the agent's own pane; for the operator, one that reached a pane here, else any this
   * bridge logged. A lead logs the messages it routed or sent to a member's pane, and the phone shows
   * those on that pane (§21, added 2026-10-18). It must have come from a pane, which is where the reply
   * goes. Null: `unknown reply`, unless {@link elsewhereReply} lets the address carry it.
   */
  replyParent(replyTo: string, sender: WalkySenderRef): LogRecord | null {
    const records = this.deps.log.all(replyTo);
    const parent =
      sender.kind === "agent"
        ? records.find((record) => record.session === sender.pane.session && record.paneId === sender.pane.paneId && sameInstance(record.instance, sender.pane.instance))
        : (records.find((record) => record.session !== null) ?? records[0]);
    return parent === undefined || parent.message.from.address === null ? null : parent;
  }

  /**
   * Whether an operator's reply this log cannot place may go by its address (added 2026-10-18). The
   * phone shows a crew member's pane from that member's own log, so a message between two panes of that
   * member never reached this bridge. The reply then goes to the one pane its address names, on another
   * machine, with `replyTo` kept; that machine's log holds the message, and its bridge pins the reply to
   * the sender's pane as it does for its own (`replyPin` in deliver.ts). An agent's reply, a fan-out and
   * a pane on this machine still need this log's record.
   */
  private elsewhereReply(to: string | null, sender: WalkySenderRef): to is string {
    if (sender.kind !== "operator" || to === null) return false;
    const address = parseAddress(to);
    return address !== null && address.kind === "pane" && !isSelf(address.memberId, this.deps.memberId);
  }

  /** Build the message a request stands for: the body cleaned, the sender named, signed on a crew. */
  compose(input: SendInput & { readonly to: string }, sender: WalkySenderRef): WalkyMessage | null {
    const clean = cleanBody(input.body);
    if (clean.body === "") return null;
    const memberId = this.deps.memberId;
    const from =
      sender.kind === "agent"
        ? { memberId, address: paneAddress(memberId, sender.pane.paneId, sender.pane.instance), harness: sender.pane.harness, label: sender.pane.label }
        : { memberId, address: null, harness: null, label: headerField(sender.label, WALKY_LABEL_MAX) };
    const message: WalkyMessage = { v: 1, id: input.id, kind: sender.kind, from, to: input.to, replyTo: input.replyTo, at: this.now(), body: clean.body, signer: null, signature: null };
    const key = this.deps.keyPem();
    return key === null || memberId === null ? message : signMessage(message, key, memberId);
  }

  /** One send, from the socket or the phone. A reply goes to the stored sender of what it answers. */
  async send(input: SendInput, sender: WalkySenderRef): Promise<SendAnswer> {
    let to = input.to;
    if (input.replyTo !== null) {
      const parent = this.replyParent(input.replyTo, sender);
      if (parent !== null) to = parent.message.from.address;
      else if (!this.elsewhereReply(input.to, sender)) return { ok: true, receipts: [this.deliverer.refusal(input.id, input.to ?? "-", "unknown reply")] };
    }
    if (to === null) return { ok: false, error: "bad request" };
    // Past the cap the send is refused, never cut: the receipt says why, and the count keeps it.
    if (cleanBody(input.body).cut) return { ok: true, receipts: [this.deliverer.refusal(input.id, to, BODY_TOO_LONG)] };
    const message = this.compose({ ...input, to }, sender);
    if (message === null) return { ok: false, error: "empty body" };
    const from: SenderPane | null = sender.kind === "agent" ? { session: sender.pane.session, paneId: sender.pane.paneId, instance: sender.pane.instance } : null;
    const receipts = await this.deliverer.deliver(message, from);
    const target = this.targetOf(message.to);
    return target === null ? { ok: true, receipts } : { ok: true, receipts, target };
  }

  /**
   * The one pane an address names, as `who` lists it, or null (a fan-out, or a pane this bridge cannot
   * see). A bare address matches the listed pane with that id; one with a token, that instance only.
   */
  private targetOf(to: string): WalkyTarget | null {
    const address = parseAddress(to);
    if (address === null || address.kind !== "pane") return null;
    const member = isSelf(address.memberId, this.deps.memberId) ? (this.deps.memberId ?? LOCAL_MEMBER) : address.memberId;
    return (
      this.who().find((target) => {
        const listed = parseAddress(target.address);
        return listed?.kind === "pane" && listed.memberId === member && listed.paneId === address.paneId && (address.instance === null || listed.instance === address.instance);
      }) ?? null
    );
  }

  /**
   * One message a crew hop brought: from a member to this lead, or from the lead to this member
   * (bridge/walky/crew.ts checked its signature first). It reaches this machine's panes, and on a
   * lead it is routed on to the members it names; `verified` says how its sender was known.
   */
  async receive(message: WalkyMessage, verified: WalkyVerified, localOnly: boolean, via?: string): Promise<WalkyReceipt[]> {
    return this.deliverer.deliver(message, null, via === undefined ? { verified, localOnly } : { verified, localOnly, via });
  }

  /** The line `who` prints below this machine's targets, or null when it lists the whole crew. */
  whoNote(): string | null {
    return this.deps.outcomesOnLead === true ? whoElsewhereNote(this.deps.leadName?.() ?? null) : null;
  }

  /** The shell panes a broadcast skips: this machine's, then what a lead knows of its members. */
  skipped(): WalkySkipped[] {
    const memberId = this.deps.memberId ?? LOCAL_MEMBER;
    const local = this.deps.host
      .panes()
      .filter((pane) => !pane.agent)
      .map((pane) => ({ address: this.addressOf(pane.paneId), memberId, machine: this.deps.machine, label: pane.label }));
    return [...local, ...(this.deps.remoteSkipped?.() ?? [])];
  }

  /** Count a refusal that wrote no receipt (a socket send that named no pane). */
  noteRefusal(reason: string): void {
    this.deliverer.noteRefusal(reason);
  }

  /** How many messages this bridge refused, per reason, and since when. */
  refusals(): RefusalCounts {
    return this.deliverer.refusalCounts();
  }

  /** Every reachable target: this machine's agent panes, then what the crew seam adds. */
  who(): WalkyTarget[] {
    const memberId = this.deps.memberId ?? LOCAL_MEMBER;
    const local = this.deps.host
      .panes()
      .filter((pane) => pane.agent)
      .map((pane) => ({ address: this.addressOf(pane.paneId, pane.instance), memberId, machine: this.deps.machine, harness: pane.harness, label: pane.label, state: pane.state }));
    return [...local, ...(this.deps.remoteTargets?.() ?? [])];
  }

  /**
   * A pane instance's unread messages, oldest first, each with its newest receipt. `all`: every
   * message that reached the instance, newest first (a record from before instances counts too).
   * Only a received message is ever unread; what the pane sent is in {@link paneList}.
   */
  inbox(session: string, paneId: string, instance: string, all: boolean, limit = 50): WalkyEntry[] {
    if (all) return this.deps.log.forPane(session, paneId, instance, limit);
    return this.deps.log.inbox(session, paneId, instance).map((message) => {
      const target = this.addressOf(paneId);
      const receipt = this.deps.log.get(message.id, target)?.receipt ?? { id: message.id, target, state: "inbox-only", verified: "local", at: message.at, by: this.deliverer.by };
      return entryOf(message, receipt);
    });
  }

  /**
   * The phone's list for one pane instance (`GET /api/pane/:id/walky`), newest first, each with its
   * newest receipt: what reached the pane and what the pane sent (added 2026-10-18), so the phone can
   * show the receipt of an agent's own message. `collie walky inbox --all` stays the received ones.
   */
  paneList(session: string, paneId: string, instance: string, limit: number): WalkyEntry[] {
    return this.deps.log.forPane(session, paneId, instance, limit, true);
  }

  /**
   * One message by id, as `collie walky inbox <id>` reads it. In a pane: only a message that went to
   * that pane instance. Outside one (the operator's own terminal): the first record of the id on this bridge.
   */
  one(id: string, pane: { readonly session: string; readonly paneId: string; readonly instance: string } | null): WalkyEntry | null {
    const records = this.deps.log.all(id);
    const record =
      pane === null ? records[0] : records.find((held) => held.session === pane.session && held.paneId === pane.paneId && sameInstance(held.instance, pane.instance));
    return record === undefined ? null : entryOf(record.message, record.receipt);
  }

  /** Every message on this bridge, newest first (the operator's `inbox --all` outside a pane). */
  newest(limit = 50): WalkyEntry[] {
    return this.deps.log.newest(limit).map((record) => entryOf(record.message, record.receipt));
  }

  /** A message's receipts on this bridge, and the message itself when the log holds it. */
  status(id: string): WalkyStatus {
    const records = this.deps.log.all(id);
    // A fan-out's own line (`all`, `<member>/all`) is the receipt written before the crew was asked;
    // once the panes it reached have receipts of their own, those are the answer. A fan-out line that
    // left `accepted` is an answer of its own (a member that refused the whole leg, a crew leg that
    // ended `unknown`), so it stays.
    const panes = records.filter((record) => !isFanOut(record.target) || record.receipt.state !== "accepted");
    // A `<member>/all` leg whose panes answer for it (a slow member's report) is not shown twice.
    const shown = withoutAnsweredLegs((panes.length > 0 ? panes : records).map((record) => record.receipt));
    const self = this.deps.memberId;
    const elsewhere =
      this.deps.outcomesOnLead === true
        ? shown
            .filter((receipt) => receipt.state === "accepted")
            .filter((receipt) => {
              const address = parseAddress(receipt.target);
              return address !== null && address.kind !== "all" && address.memberId !== self && address.memberId !== LOCAL_MEMBER;
            })
            .map((receipt) => receipt.target)
        : [];
    return { receipts: shown, message: records[0]?.message ?? null, elsewhere };
  }

  /**
   * The sender takes a held message back (M62 spec 03, decision 1 and 5): `collie walky cancel <id>`
   * from the pane that sent it, or the phone's `POST /api/walky/<id>/cancel` for an operator's message.
   * An agent proves it is the sender as a send does, by the pane the mux markers place: its address
   * must be the message's `from.address`, token and all, so a new session in the same pane cannot
   * cancel the old one's message. An operator message belongs to the paired devices as a whole. A
   * fan-out is taken back target by target; each answers for itself.
   */
  cancel(id: string, by: TakeBackRef): TakeBackAnswer {
    const records = this.deps.log.all(id);
    const message = records[0]?.message;
    if (message === undefined) return { ok: false, error: `no message ${id} on this machine` };
    const mine = by.kind === "agent" ? message.from.address !== null && message.from.address === this.addressOf(by.pane.paneId, by.pane.instance) : message.kind === "operator";
    if (!mine) {
      this.deliverer.noteRefusal("not the sender");
      return { ok: false, error: NOT_THE_SENDER };
    }
    return { ok: true, results: records.map((record) => this.deliverer.takeBack(record, CANCELLED_BY_SENDER)) };
  }

  /**
   * The pane's owner drops a message held for the pane (M62 spec 03, decision 3): the phone's
   * `POST /api/pane/<pane>/walky/<id>/drop`, on the machine that owns the pane. Only the records placed
   * on that pane instance are touched; a message to another pane under the same id is not.
   */
  drop(id: string, pane: { readonly session: string; readonly paneId: string; readonly instance: string }): TakeBackAnswer {
    const records = this.deps.log.all(id).filter((record) => record.session === pane.session && record.paneId === pane.paneId && sameInstance(record.instance, pane.instance));
    if (records.length === 0) return { ok: false, error: `no message ${id} for this pane` };
    return { ok: true, results: records.map((record) => this.deliverer.takeBack(record, DROPPED_BY_OWNER)) };
  }

  /** Mark messages read for a pane instance: the ids, or all of them. */
  ack(session: string, paneId: string, instance: string, ids: readonly string[] | null): number {
    return this.deps.log.ack(session, paneId, instance, ids);
  }
}
