// Delivery (M62 README, decisions 1, 6 and 7): log first, then type.
//
//   1. Resolve the address to target panes. A shell pane is never a target. An address on another
//      member goes to the crew seam (`routeRemote`, spec 03); with no seam it is refused.
//   2. The same id again returns the stored receipts and types nothing. The same id with another
//      text is refused `id reused` and logs nothing.
//   3. `COLLIE_WALKY=off` refuses `off`; the sender cap refuses `rate limit`. Neither is logged.
//   4. Each target gets a message line, an inbox entry and an `accepted` receipt, in that order,
//      before any key. The answer leaves with those receipts.
//   5. Then the envelope (types.ts `formatEnvelope`) goes through the pane's Send Protocol as one
//      send, mode `send`. An agent's message types ONE line, the header and a nudge, and no body: the
//      body reaches the agent as the output of `collie walky inbox <id>`, a tool result, never as a
//      prompt from its operator. An operator's message types the header and the body. `sent` or
//      `effective` is `delivered`; an operator's acks the inbox entry, an agent's stays unread until
//      the agent reads it. A refusal, a
//      typed-not-submitted, an expiry or a cancel is `inbox-only` with the reason. A send held behind
//      a running turn is watched for 10 minutes; still held then, it is cancelled and `inbox-only`.
//      An `unknown` stays `unknown`, and is never sent again (CREW_PROTOCOL §10.3).
//
// Collie never answers a message and never answers a dialog with one (decision 6): the Send
// Protocol refuses a send over a dialog, and the message waits in the inbox.

import { createHash } from "node:crypto";

import { LOCAL_MEMBER, isSelf, parseAddress } from "./address.ts";
import { canonicalMessage } from "./canonical.ts";
import type { LogRecord, Placement, WalkyLog } from "./log.ts";
import { MEMBER_LIMIT, PAIR_LIMIT, pairKey, RateLimiter, senderKey } from "./rate.ts";
import { formatEnvelope, type WalkyMessage, type WalkyReceipt, type WalkyReceiptState, type WalkyVerified } from "./types.ts";

/** How long a held send may wait before the message is left in the inbox only. */
export const HELD_LIMIT_MS = 10 * 60 * 1000;
/** How often a held send's state is read. */
export const HELD_POLL_MS = 2000;

/** One pane of this bridge, as walky talky sees it. */
export interface WalkyPane {
  readonly session: string;
  readonly paneId: string;
  /** False for a bare shell: it never receives a message. */
  readonly agent: boolean;
  readonly harness: string | null;
  readonly label: string;
  /** The pane's status word, as the snapshot gives it. */
  readonly state: string;
  /** False when the session has no Send Protocol (no screen, or COLLIE_SEND_PROTOCOL=0). */
  readonly terminal: boolean;
}

/** A Send Protocol outcome and reason, as the request store holds them. */
export interface SendResult {
  readonly outcome: string;
  readonly reason?: string;
}

/** What delivery needs of the bridge. index.ts builds it from the session registry. */
export interface WalkyHost {
  /** Every pane of every session, in registry order (the primary first). */
  panes(): readonly WalkyPane[];
  /** Run one send through the pane's Send Protocol. */
  send(pane: WalkyPane, sendId: string, text: string): Promise<SendResult>;
  /** The stored outcome of a send request, or null when the protocol never took it. */
  sendState(sendId: string): SendResult | null;
  /** Take back a held send. */
  cancelHeld(session: string, paneId: string, sendId: string): void;
}

/**
 * THE CREW SEAM. Spec 03 fills it: hand a message to the crew for one other member (`memberId`) or
 * for every other member (`"all"`), and answer the receipts the crew wrote. Absent, an address on
 * another member is refused `crew routing not built`, and `all` reaches this machine's panes only.
 */
export type RouteRemote = (message: WalkyMessage, members: string) => Promise<readonly WalkyReceipt[]>;

/** How one delivery runs. The defaults are a message this bridge built itself. */
export interface DeliverOptions {
  /**
   * How this bridge knows who sent the message: `local` for one it built, `origin` when it verified
   * the sender's own signature, `lead` when it verified its lead's attestation (CREW_PROTOCOL §21).
   */
  readonly verified?: WalkyVerified;
  /**
   * True for a message a crew hop brought to this bridge's panes. It reaches this machine only: an
   * address on another member is refused `no such pane`, and `all` is never routed on, so a message
   * cannot loop between a member and its lead.
   */
  readonly localOnly?: boolean;
  /**
   * On a lead, the member whose request signature carried the message (CREW_PROTOCOL §21): its outer
   * bucket of 60 tokens per 10 minutes is counted too.
   */
  readonly via?: string;
}

/** The parts of a receipt beside its id, target and state. */
interface ReceiptExtra {
  readonly reason?: string | undefined;
  readonly sendId?: string | undefined;
  readonly verified?: WalkyVerified;
}

/** The deepest reply chain a message may sit in: a fifth reply in a row is refused `thread depth`. */
export const THREAD_DEPTH_MAX = 4;

/**
 * Whether two messages under one id are the same message. The sender's clock (`at`) is left out: a
 * phone's retry of the same attempt reuses the id and is built again a moment later, and that is a
 * replay, not a second message.
 */
export function sameMessage(a: WalkyMessage, b: WalkyMessage): boolean {
  return canonicalMessage({ ...a, at: 0 }) === canonicalMessage({ ...b, at: 0 });
}

/** Whether a target names a fan-out (`all` or `<member>/all`), not one pane. */
export function isFanOut(target: string): boolean {
  return target === "all" || target.endsWith("/all");
}

/** Who sent a message, as delivery needs it: the pane it came from, if any. */
export interface SenderPane {
  readonly session: string;
  readonly paneId: string;
}

export interface DelivererDeps {
  readonly log: WalkyLog;
  readonly host: WalkyHost;
  /** This bridge's member id, null on a solo install. */
  readonly memberId: string | null;
  /** False with COLLIE_WALKY=off. Read per message. */
  readonly enabled: () => boolean;
  /** The sender cap, 30 per sender per 10 minutes. */
  readonly rate?: RateLimiter;
  /** The pair cap, 6 per two addresses per 10 minutes. */
  readonly pairs?: RateLimiter;
  /** The lead's outer cap, 60 per member per 10 minutes. */
  readonly members?: RateLimiter;
  readonly routeRemote?: RouteRemote;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly warn?: (line: string) => void;
}

/** The Send Protocol request id of one message to one target: deterministic, so a retry is a replay there too. */
export function sendIdOf(id: string, target: string): string {
  return `${id}-${createHash("sha256").update(target).digest("hex").slice(0, 8)}`;
}

/** A refusal's reason in the receipt's words. */
export function reasonOf(result: SendResult): string {
  if (result.outcome === "typed_not_submitted") return "typed, not submitted";
  if (result.outcome !== "refused") return result.reason === undefined ? result.outcome : `${result.outcome}: ${result.reason.replace(/_/gu, " ")}`;
  if (result.reason === "not_free" || result.reason === "busy") return "dialog open";
  if (result.reason === "pane_gone") return "no such pane";
  return (result.reason ?? "refused").replace(/_/gu, " ");
}

export class WalkyDeliverer {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rate: RateLimiter;
  private readonly pairs: RateLimiter;
  private readonly members: RateLimiter;
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly deps: DelivererDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rate = deps.rate ?? new RateLimiter();
    this.pairs = deps.pairs ?? new RateLimiter(PAIR_LIMIT);
    this.members = deps.members ?? new RateLimiter(MEMBER_LIMIT);
  }

  /** The `by` of every receipt this bridge writes. */
  get by(): string {
    return this.deps.memberId ?? "solo";
  }

  private receipt(id: string, target: string, state: WalkyReceiptState, extra: ReceiptExtra = {}): WalkyReceipt {
    const base: WalkyReceipt = { id, target, state, verified: extra.verified ?? "local", at: this.now(), by: this.by };
    const withReason = extra.reason === undefined ? base : { ...base, reason: extra.reason };
    return extra.sendId === undefined ? withReason : { ...withReason, sendId: extra.sendId };
  }

  /** A refusal written by this bridge: nothing typed, nothing logged but the count (M62 hardening I). */
  refusal(id: string, target: string, reason: string, verified: WalkyVerified = "local"): WalkyReceipt {
    return this.receipt(id, target, "refused", { reason, verified });
  }

  /** A newer receipt for a logged record: same id, target and verification, a new state. */
  private next(record: LogRecord, state: WalkyReceiptState, reason?: string, sendId?: string): WalkyReceipt {
    return this.receipt(record.message.id, record.target, state, { reason, sendId, verified: record.receipt.verified });
  }

  /** Resolves when every delivery started so far has settled. For tests and a clean stop. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running);
  }

  /** An address as this bridge spells it: `local/…` on a crew member is its own member id. */
  private normal(raw: string): string {
    const address = parseAddress(raw);
    if (address === null || address.kind === "all") return raw;
    const member = isSelf(address.memberId, this.deps.memberId) ? (this.deps.memberId ?? LOCAL_MEMBER) : address.memberId;
    return address.kind === "pane" ? `${member}/${address.paneId}` : `${member}/all`;
  }

  /**
   * How deep a message sits in its thread: how many of its `replyTo` links this bridge's log holds,
   * walking up. A link the log does not hold ends the walk and counts 0.
   */
  threadDepth(message: Pick<WalkyMessage, "id" | "replyTo">): number {
    const seen = new Set<string>([message.id]);
    let depth = 0;
    let link = message.replyTo;
    while (link !== null && !seen.has(link) && depth <= THREAD_DEPTH_MAX) {
      seen.add(link);
      const parent = this.deps.log.first(link);
      if (parent === null) break;
      depth += 1;
      link = parent.message.replyTo;
    }
    return depth;
  }

  /**
   * Deliver one built message. Answers at once with the receipts written before any key. The checks,
   * in order, each a refusal that types nothing and logs no message (M62 hardening D and F):
   *
   *   `no such pane`                    the address does not parse, or names another machine on a crew hop
   *   `id reused`                       the id is taken by another message
   *   `only the operator may broadcast` an agent named `all` or `<member>/all`
   *   `that is your own pane`           the target is the sender's own pane
   *   `thread depth`                    the reply chain is deeper than 4 in this bridge's log
   *   `off`                             COLLIE_WALKY=off on this machine
   *   `ambiguous pane`                  more than one session has a pane with the target's id
   *   `sender gone`                     a reply's pane is gone, or now in another session
   *   `not an agent pane`               the target is a shell
   *   `rate limit` / `pair limit`       a cap is full: the sender's, the lead's per member, or the pair's
   */
  async deliver(message: WalkyMessage, sender: SenderPane | null, options: DeliverOptions = {}): Promise<WalkyReceipt[]> {
    const verified = options.verified ?? "local";
    const refuse = (reason: string): WalkyReceipt[] => [this.refusal(message.id, message.to, reason, verified)];
    const address = parseAddress(message.to);
    if (address === null) return refuse("no such pane");
    const stored = this.deps.log.all(message.id);
    if (stored.length > 0) {
      if (!sameMessage(stored[0]!.message, message)) return refuse("id reused");
      return stored.map((record) => record.receipt);
    }
    if (address.kind !== "pane" && message.kind === "agent") return refuse("only the operator may broadcast");
    const remote = address.kind !== "all" && !isSelf(address.memberId, this.deps.memberId);
    if (remote && options.localOnly === true) return refuse("no such pane");
    if (message.from.address !== null && this.normal(message.from.address) === this.normal(message.to)) return refuse("that is your own pane");
    if (this.threadDepth(message) > THREAD_DEPTH_MAX) return refuse("thread depth");
    if (remote) return this.capped(message, 1, options) ?? this.remote(message, address.memberId, sender);
    if (!this.deps.enabled()) return refuse("off");
    const panes = this.deps.host.panes();
    const isSender = (pane: WalkyPane): boolean => sender !== null && pane.session === sender.session && pane.paneId === sender.paneId;
    const self = this.deps.memberId ?? LOCAL_MEMBER;
    const refusedTargets: WalkyReceipt[] = [];
    let targets: WalkyPane[];
    if (address.kind === "pane") {
      let pane: WalkyPane | undefined;
      const pin = this.replyPin(message);
      if (pin !== null) {
        pane = panes.find((candidate) => candidate.session === pin.session && candidate.paneId === pin.paneId);
        if (pane === undefined || pane.paneId !== address.paneId) return refuse("sender gone");
      } else {
        const named = panes.filter((candidate) => candidate.paneId === address.paneId);
        if (named.length > 1) return refuse("ambiguous pane");
        pane = named[0];
      }
      if (pane === undefined) return refuse("no such pane");
      if (isSender(pane)) return refuse("that is your own pane");
      if (!pane.agent) return refuse("not an agent pane");
      targets = [pane];
    } else {
      // A pane id that more than one session uses is one address for two panes: neither is typed.
      const counts = new Map<string, number>();
      for (const pane of panes) counts.set(pane.paneId, (counts.get(pane.paneId) ?? 0) + 1);
      targets = [];
      for (const pane of panes) {
        if (!pane.agent || isSender(pane)) continue;
        if ((counts.get(pane.paneId) ?? 0) > 1) {
          const target = `${self}/${pane.paneId}`;
          if (!refusedTargets.some((held) => held.target === target)) refusedTargets.push(this.refusal(message.id, target, "ambiguous pane", verified));
          continue;
        }
        targets.push(pane);
      }
    }
    const routesOn = address.kind === "all" && this.deps.routeRemote !== undefined && options.localOnly !== true;
    const capped = this.capped(message, targets.length + (routesOn ? 1 : 0), options);
    if (capped !== null) return capped;
    const receipts: WalkyReceipt[] = [...refusedTargets];
    for (const pane of targets) {
      const target = `${self}/${pane.paneId}`;
      const accepted = this.receipt(message.id, target, "accepted", { verified });
      const record = this.deps.log.record(message, target, { session: pane.session, paneId: pane.paneId }, accepted, sender);
      this.deps.log.inboxAdd(pane.session, pane.paneId, message);
      receipts.push(accepted);
      this.track(this.type(record, pane));
    }
    if (routesOn) receipts.push(...(await this.remote(message, "all", sender)));
    return receipts;
  }

  /**
   * The exact pane a reply goes back to: the session and pane this bridge took the replied-to message
   * from, when the reply names that message's sender. Null when the log does not know it: the address
   * then picks the pane, and must pick exactly one.
   */
  private replyPin(message: WalkyMessage): SenderPane | null {
    if (message.replyTo === null) return null;
    const parent = this.deps.log.first(message.replyTo);
    if (parent === null || parent.sender === null || parent.message.from.address === null) return null;
    if (this.normal(parent.message.from.address) !== this.normal(message.to)) return null;
    const { session, paneId } = parent.sender;
    return session === null || paneId === null ? null : { session, paneId };
  }

  /**
   * The caps, checked together and taken together: `tokens` from the sender's bucket and, on a lead,
   * from the dialling member's; one from the pair's for a message between two panes. Null when all
   * fit (and are now counted), else the refusal.
   */
  private capped(message: WalkyMessage, tokens: number, options: DeliverOptions): WalkyReceipt[] | null {
    const now = this.now();
    const verified = options.verified ?? "local";
    const refuse = (reason: string): WalkyReceipt[] => [this.refusal(message.id, message.to, reason, verified)];
    const count = Math.max(1, tokens);
    const key = senderKey(message.kind, message.from.memberId, message.from.address);
    const pair = message.from.address === null ? null : pairKey(this.normal(message.from.address), this.normal(message.to));
    if (!this.rate.room(key, now, count)) return refuse("rate limit");
    if (options.via !== undefined && !this.members.room(options.via, now, count)) return refuse("rate limit");
    if (pair !== null && !this.pairs.room(pair, now)) return refuse("pair limit");
    this.rate.take(key, now, count);
    if (options.via !== undefined) this.members.take(options.via, now, count);
    if (pair !== null) this.pairs.take(pair, now);
    return null;
  }

  /** An address on another member: through the crew seam, or refused while there is none. */
  private async remote(message: WalkyMessage, members: string, sender: SenderPane | null): Promise<WalkyReceipt[]> {
    const route = this.deps.routeRemote;
    if (route === undefined) return [this.receipt(message.id, message.to, "refused", { reason: "crew routing not built" })];
    const placement: Placement = { session: null, paneId: null };
    const accepted = this.receipt(message.id, members === "all" ? "all" : message.to, "accepted");
    this.deps.log.record(message, accepted.target, placement, accepted, sender);
    try {
      const receipts = [...(await route(message, members))];
      // A fan-out comes back as one receipt per pane on the far side: each is logged as a target of
      // its own, so `status` and the outcome report (crew.ts) can find it by id and target.
      for (const receipt of receipts) {
        if (receipt.id !== message.id) continue;
        if (this.deps.log.get(message.id, receipt.target) === null) this.deps.log.record(message, receipt.target, placement, receipt, sender);
        else this.deps.log.update(receipt);
      }
      return receipts.length === 0 ? [accepted] : receipts;
    } catch (err) {
      const failed = this.receipt(message.id, accepted.target, "unknown", { reason: `crew: ${err instanceof Error ? err.message : String(err)}` });
      this.deps.log.update(failed);
      return [failed];
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((err: Error) => this.deps.warn?.(`[walky] delivery failed: ${err.message}`)).finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  /** Type one logged message into its pane, and write how it ended. */
  private async type(record: LogRecord, pane: WalkyPane): Promise<void> {
    const { message, target } = record;
    if (!pane.terminal) {
      this.deps.log.update(this.next(record, "inbox-only", "no terminal"));
      return;
    }
    const sendId = sendIdOf(message.id, target);
    // The send id is on disk before the send: a restart reads the request store under it.
    this.deps.log.update(this.next(record, "accepted", undefined, sendId));
    let result: SendResult;
    try {
      result = await this.deps.host.send(pane, sendId, formatEnvelope(message));
    } catch (err) {
      result = { outcome: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
    await this.settle(record, pane.session, pane.paneId, sendId, result);
  }

  /** Write the receipt an outcome stands for. A held send is watched until it ends or its 10 minutes pass. */
  private async settle(record: LogRecord, session: string, paneId: string, sendId: string, first: SendResult): Promise<void> {
    const { message } = record;
    let result = first;
    if (result.outcome === "held") {
      const until = record.receipt.at + HELD_LIMIT_MS;
      while (result.outcome === "held" && this.now() < until) {
        await this.sleep(HELD_POLL_MS);
        result = this.deps.host.sendState(sendId) ?? result;
      }
      if (result.outcome === "held") {
        this.deps.host.cancelHeld(session, paneId, sendId);
        const after = this.deps.host.sendState(sendId);
        result = after === null || after.outcome === "held" || after.outcome === "cancelled" ? { outcome: "held" } : after;
        if (result.outcome === "held") {
          this.deps.log.update(this.next(record, "inbox-only", "held past 10 minutes", sendId));
          return;
        }
      }
    }
    if (result.outcome === "sent" || result.outcome === "effective") {
      this.deps.log.update(this.next(record, "delivered", undefined, sendId));
      // The operator's body was typed: read. An agent's was not: it waits for `inbox <id>`.
      if (message.kind === "operator") this.deps.log.ack(session, paneId, [message.id]);
      return;
    }
    if (result.outcome === "unknown") {
      this.deps.log.update(this.next(record, "unknown", result.reason?.replace(/_/gu, " "), sendId));
      return;
    }
    this.deps.log.update(this.next(record, "inbox-only", reasonOf(result), sendId));
  }

  /**
   * After a restart: every receipt still `accepted` is settled from what the Send Protocol stored.
   * No send id means no key went out: `inbox-only`. A send id the store never took is the same. A
   * held send is watched again from where it stood.
   */
  recover(): number {
    let count = 0;
    for (const record of this.deps.log.pending()) {
      const { session, paneId } = record;
      if (session === null || paneId === null) continue;
      count += 1;
      const sendId = record.receipt.sendId;
      const state = sendId === undefined ? null : this.deps.host.sendState(sendId);
      if (sendId === undefined || state === null) {
        this.deps.log.update(this.next(record, "inbox-only", "bridge restarted", sendId));
        continue;
      }
      this.track(this.settle(record, session, paneId, sendId, state));
    }
    return count;
  }
}
