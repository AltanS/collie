// The walky talky service: what the local socket (socket.ts) and the phone's routes (server.ts) both
// call. It builds a message from a request (cleans the body, names the sender, signs on a crew), hands
// it to delivery, and answers the reads: who is reachable, a pane's inbox, a message's receipts.
//
// Two kinds, by what the bridge proved (decision 3, hardened 2026-10-17). `agent`: the CLI ran inside a
// pane the bridge placed from the multiplexer's own markers in its environment. `operator`: a paired
// device, through `POST /api/walky`, and nothing else: the local socket refuses a send that names no
// pane, so the kind fails closed. The local uid can lie about its pane (decision 4); the docs say so.

import { paneAddress, parseAddress, LOCAL_MEMBER } from "./address.ts";
import { signMessage } from "./canonical.ts";
import { cleanBody } from "./clean.ts";
import { isFanOut, WalkyDeliverer, type DelivererDeps, type SenderPane, type WalkyPane } from "./deliver.ts";
import type { LogRecord, WalkyLog } from "./log.ts";
import { headerField, WALKY_LABEL_MAX, type WalkyEntry, type WalkyMessage, type WalkyReceipt, type WalkyTarget, type WalkyVerified } from "./types.ts";

/** Who is sending: an agent's pane, or an operator by label. */
export type WalkySenderRef = { readonly kind: "agent"; readonly pane: WalkyPane } | { readonly kind: "operator"; readonly label: string };

export interface SendInput {
  readonly id: string;
  /** The address. A reply's address is the bridge's to fill: the replied-to message's sender. */
  readonly to: string | null;
  readonly body: string;
  readonly replyTo: string | null;
}

export type SendAnswer = { readonly ok: true; readonly receipts: readonly WalkyReceipt[] } | { readonly ok: false; readonly error: string };

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
   * its lead and never learns how it ended there: the lead keeps that outcome (CREW_PROTOCOL §21).
   * `status` then names those targets, and `who` says the other machines are the lead's to list.
   */
  readonly outcomesOnLead?: boolean;
}

/** What `who` on a crew member adds below its own panes: the roster is the lead's. */
export const WHO_ELSEWHERE_NOTE = "other machines: ask the lead (collie walky who there, or the phone)";

/** A message's receipts on this bridge, and the message itself when the log holds it. */
export interface WalkyStatus {
  readonly receipts: WalkyReceipt[];
  readonly message: WalkyMessage | null;
  /**
   * The targets among `receipts` that are still `accepted` on another machine, on a member whose lead
   * keeps their outcome ({@link WalkyServiceDeps.outcomesOnLead}). Empty everywhere else.
   */
  readonly elsewhere: string[];
}

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

  /** The address of a pane of this bridge. */
  addressOf(paneId: string): string {
    return paneAddress(this.deps.memberId, paneId);
  }

  /**
   * The message a reply answers, as this bridge's log holds it (M62 hardening D): for an agent, one
   * that went to the agent's own pane; for the operator, any. It must have come from a pane, which is
   * where the reply goes. Null: `unknown reply`.
   */
  replyParent(replyTo: string, sender: WalkySenderRef): LogRecord | null {
    const records = this.deps.log.all(replyTo);
    const parent =
      sender.kind === "agent" ? records.find((record) => record.session === sender.pane.session && record.paneId === sender.pane.paneId) : records.find((record) => record.session !== null);
    return parent === undefined || parent.message.from.address === null ? null : parent;
  }

  /** Build the message a request stands for: the body cleaned, the sender named, signed on a crew. */
  compose(input: SendInput & { readonly to: string }, sender: WalkySenderRef): WalkyMessage | null {
    const clean = cleanBody(input.body);
    if (clean.body === "") return null;
    const memberId = this.deps.memberId;
    const from =
      sender.kind === "agent"
        ? { memberId, address: paneAddress(memberId, sender.pane.paneId), harness: sender.pane.harness, label: sender.pane.label }
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
      if (parent === null) return { ok: true, receipts: [this.deliverer.refusal(input.id, input.to ?? "-", "unknown reply")] };
      to = parent.message.from.address;
    }
    if (to === null) return { ok: false, error: "bad request" };
    const message = this.compose({ ...input, to }, sender);
    if (message === null) return { ok: false, error: "empty body" };
    const from: SenderPane | null = sender.kind === "agent" ? { session: sender.pane.session, paneId: sender.pane.paneId } : null;
    return { ok: true, receipts: await this.deliverer.deliver(message, from) };
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
    return this.deps.outcomesOnLead === true ? WHO_ELSEWHERE_NOTE : null;
  }

  /** Every reachable target: this machine's agent panes, then what the crew seam adds. */
  who(): WalkyTarget[] {
    const memberId = this.deps.memberId ?? LOCAL_MEMBER;
    const local = this.deps.host
      .panes()
      .filter((pane) => pane.agent)
      .map((pane) => ({ address: this.addressOf(pane.paneId), memberId, machine: this.deps.machine, harness: pane.harness, label: pane.label, state: pane.state }));
    return [...local, ...(this.deps.remoteTargets?.() ?? [])];
  }

  /** A pane's unread messages, oldest first, each with its newest receipt. `all`: every message that reached the pane, newest first. */
  inbox(session: string, paneId: string, all: boolean, limit = 50): WalkyEntry[] {
    if (all) return this.deps.log.forPane(session, paneId, limit);
    return this.deps.log.inbox(session, paneId).map((message) => {
      const target = this.addressOf(paneId);
      const receipt = this.deps.log.get(message.id, target)?.receipt ?? { id: message.id, target, state: "inbox-only", verified: "local", at: message.at, by: this.deliverer.by };
      return entryOf(message, receipt);
    });
  }

  /**
   * One message by id, as `collie walky inbox <id>` reads it. In a pane: only a message that went to
   * that pane. Outside one (the operator's own terminal): the first record of the id on this bridge.
   */
  one(id: string, pane: { readonly session: string; readonly paneId: string } | null): WalkyEntry | null {
    const records = this.deps.log.all(id);
    const record = pane === null ? records[0] : records.find((held) => held.session === pane.session && held.paneId === pane.paneId);
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
    // once the panes it reached have receipts of their own, those are the answer.
    const panes = records.filter((record) => !isFanOut(record.target));
    const shown = (panes.length > 0 ? panes : records).map((record) => record.receipt);
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

  /** Mark messages read for a pane: the ids, or all of them. */
  ack(session: string, paneId: string, ids: readonly string[] | null): number {
    return this.deps.log.ack(session, paneId, ids);
  }
}
