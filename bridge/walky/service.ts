// The walky talky service: what the local socket (socket.ts) and the phone's routes (server.ts) both
// call. It builds a message from a request (cleans the body, names the sender, signs on a crew), hands
// it to delivery, and answers the reads: who is reachable, a pane's inbox, a message's receipts.
//
// Two kinds, by who typed it (decision 3). `agent`: the CLI ran inside a pane the bridge placed from
// the multiplexer's own markers. `operator`: a paired phone (its device label), or the CLI outside any
// pane (label `cli`). The local uid can lie about its pane (decision 4); the docs say so.

import { paneAddress, LOCAL_MEMBER } from "./address.ts";
import { signMessage } from "./canonical.ts";
import { cleanBody } from "./clean.ts";
import { WalkyDeliverer, type DelivererDeps, type SenderPane, type WalkyPane } from "./deliver.ts";
import type { WalkyLog } from "./log.ts";
import type { WalkyEntry, WalkyMessage, WalkyReceipt, WalkyTarget } from "./types.ts";

/** Who is sending: an agent's pane, or an operator by label. */
export type WalkySenderRef = { readonly kind: "agent"; readonly pane: WalkyPane } | { readonly kind: "operator"; readonly label: string };

export interface SendInput {
  readonly id: string;
  readonly to: string;
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
}

/** A message's receipts on this bridge, and the message itself when the log holds it. */
export interface WalkyStatus {
  readonly receipts: WalkyReceipt[];
  readonly message: WalkyMessage | null;
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

  /** Build the message a request stands for: the body cleaned, the sender named, signed on a crew. */
  compose(input: SendInput, sender: WalkySenderRef): WalkyMessage | null {
    const clean = cleanBody(input.body);
    if (clean.body === "") return null;
    const memberId = this.deps.memberId;
    const from =
      sender.kind === "agent"
        ? { memberId, address: paneAddress(memberId, sender.pane.paneId), harness: sender.pane.harness, label: sender.pane.label }
        : { memberId, address: null, harness: null, label: sender.label };
    const message: WalkyMessage = { v: 1, id: input.id, kind: sender.kind, from, to: input.to, replyTo: input.replyTo, at: this.now(), body: clean.body, signer: null, signature: null };
    const key = this.deps.keyPem();
    return key === null || memberId === null ? message : signMessage(message, key, memberId);
  }

  /** One send, from the socket or the phone. */
  async send(input: SendInput, sender: WalkySenderRef): Promise<SendAnswer> {
    const message = this.compose(input, sender);
    if (message === null) return { ok: false, error: "empty body" };
    const from: SenderPane | null = sender.kind === "agent" ? { session: sender.pane.session, paneId: sender.pane.paneId } : null;
    return { ok: true, receipts: await this.deliverer.deliver(message, from) };
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

  /** Every message on this bridge, newest first (the operator's `inbox --all` outside a pane). */
  newest(limit = 50): WalkyEntry[] {
    return this.deps.log.newest(limit).map((record) => entryOf(record.message, record.receipt));
  }

  /** A message's receipts on this bridge, and the message itself when the log holds it. */
  status(id: string): WalkyStatus {
    const records = this.deps.log.all(id);
    return { receipts: records.map((record) => record.receipt), message: records[0]?.message ?? null };
  }

  /** Mark messages read for a pane: the ids, or all of them. */
  ack(session: string, paneId: string, ids: readonly string[] | null): number {
    return this.deps.log.ack(session, paneId, ids);
  }
}
