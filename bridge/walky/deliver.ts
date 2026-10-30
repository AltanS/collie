// Delivery (M62 README, decisions 1, 6 and 7): log first, then type.
//
//   1. Resolve the address to target panes. A shell pane is never a target. An address on another
//      member goes to the crew seam (`routeRemote`, spec 03); with no seam it is refused.
//   2. The same id again returns the stored receipts and types nothing (seen.ts keeps the ids a day,
//      apart from the log's rotation). The same id with another text is refused `id reused` and logs
//      nothing. A fan-out repeated after a crash finishes the targets it lacks.
//   3. `COLLIE_WALKY=off` refuses `off`; the sender cap refuses `rate limit`. Neither is logged.
//   4. Each target gets a message line, an inbox entry and an `accepted` receipt, in that order,
//      before any key. The answer leaves with those receipts.
//   5. Then the envelope (types.ts `formatEnvelope`) goes through the pane's Send Protocol as one
//      send, mode `send`. An agent's message types ONE line, the header and a nudge, and no body: the
//      body reaches the agent as the output of `collie walky inbox <id>`, a tool result, never as a
//      prompt from its operator. An operator's message types the header and the body. `sent` or
//      `effective` is `delivered`; an operator's acks the inbox entry, an agent's stays unread until
//      the agent reads it. A refusal, a
//      typed-not-submitted, an expiry or a cancel is `inbox-only` with the reason. The send is marked
//      (`draftHolds`, M62 spec 02): a draft in the box holds it, as a running turn does, and nothing is
//      typed over the draft. A held send stays `accepted` with the reason that holds it (`draft
//      present` or `turn running`), and is watched on one clock, 60 minutes from its acceptance, that
//      the Send Protocol's hold is given too. Still held then, it is cancelled and `inbox-only`. Before
//      a hold goes out the pane is checked once more: another instance there never takes it.
//      An `unknown` stays `unknown`, and is never sent again (CREW_PROTOCOL §10.3).
//
// Collie never answers a message and never answers a dialog with one (decision 6): the Send
// Protocol refuses a send over a dialog, and the message waits in the inbox.

import { createHash } from "node:crypto";

import { bareAddress, inScope, isScopeAddress, LOCAL_MEMBER, isSelf, labelScope, paneAddress, parseAddress, type WalkyAddress, type WalkyScope } from "./address.ts";
import { canonicalMessage } from "./canonical.ts";
import { WALKY_LEG_PANES_MAX } from "./crew.ts";
import type { LogRecord, Placement, WalkyLog } from "./log.ts";
import { MEMBER_LIMIT, PAIR_LIMIT, pairKey, RateLimiter, senderKey } from "./rate.ts";
import { HERE_FROM_PHONE, hereWithoutFolder, MEMBER_UNREACHABLE, OUT_OF_SCOPE, RefusalCounter, scopeEmpty, scopeIsMember, scopeTooWide, type RefusalCounts } from "./refusals.ts";
import { seenHash, WalkySeen } from "./seen.ts";
import { formatEnvelope, receiptReason, SEND_ID, type WalkyMessage, type WalkyReceipt, type WalkyReceiptState, type WalkyTarget, type WalkyVerified } from "./types.ts";

/**
 * How long a held send may wait before the message is left in the inbox only: one clock per message,
 * counted from its acceptance, whatever holds it (a draft, a turn). The Send Protocol's hold ends at the
 * same moment (`holdUntil`), so no other clock runs under it.
 */
export const HELD_LIMIT_MS = 60 * 60 * 1000;
/** The reason of a message whose hold outlasted {@link HELD_LIMIT_MS}. */
export const HELD_PAST = "held past 60 minutes";
/** How often a held send's state is read. */
export const HELD_POLL_MS = 2000;
/**
 * How long a message waits for this bridge's earlier walky send into the same pane to be answered
 * before it is typed. Past it the message is `inbox-only: pane busy`. A send answers within its own
 * steps (about 15 s) or as `held`, so two minutes is room enough.
 */
export const LANE_WAIT_MS = 2 * 60 * 1000;
/** The reason of a message that waited out {@link LANE_WAIT_MS}. */
export const PANE_BUSY = "pane busy";
/** The reason of a held message its sender took back (M62 spec 03). */
export const CANCELLED_BY_SENDER = "cancelled by sender";
/** The reason of a held message the target pane's owner dropped (M62 spec 03). */
export const DROPPED_BY_OWNER = "dropped by the pane's owner";

/**
 * How one take-back of one logged message ended (M62 spec 03). `taken`: the hold ended now, and the
 * receipt is `inbox-only` with the reason given. `repeat`: it had ended as `inbox-only` already, so
 * nothing changed. `already typed`: the message went into the pane (`delivered`), may have (`unknown`),
 * or is going out this moment, so the Send Protocol did not confirm the cancel; the receipt stands.
 * `not held`: the receipt is `accepted` with no held reason (queued, not held yet), `refused` or
 * `expired`, none of which a take-back touches. `elsewhere`: the message is held on another machine,
 * whose own bridge must take it back.
 */
export interface TakeBack {
  readonly target: string;
  readonly result: "taken" | "repeat" | "already typed" | "not held" | "elsewhere";
  readonly receipt: WalkyReceipt;
}

/** One pane of this bridge, as walky talky sees it. */
export interface WalkyPane {
  readonly session: string;
  readonly paneId: string;
  /**
   * The pane's instance token (instances.ts): the session that holds this pane id now. An address
   * with a token reaches this pane only while the token matches.
   */
  readonly instance: string;
  /** False for a bare shell: it never receives a message. */
  readonly agent: boolean;
  readonly harness: string | null;
  readonly label: string;
  /** The pane's status word, as the snapshot gives it. */
  readonly state: string;
  /** False when the session has no Send Protocol (no screen, or COLLIE_SEND_PROTOCOL=0). */
  readonly terminal: boolean;
}

/**
 * A Send Protocol outcome and reason, as the request store holds them. On `held`, the reason is what
 * holds the send now: `draft_present`, or `turn_running` (or none, which reads as a turn).
 */
export interface SendResult {
  readonly outcome: string;
  readonly reason?: string;
}

/** How a walky send asks to be held (M62 spec 02): over a draft too, until its one clock runs out. */
export interface WalkyHold {
  readonly draftHolds: true;
  /** Epoch ms: the message's acceptance plus {@link HELD_LIMIT_MS}. */
  readonly holdUntil: number;
}

/** What delivery needs of the bridge. index.ts builds it from the session registry. */
export interface WalkyHost {
  /** Every pane of every session, in registry order (the primary first). */
  panes(): readonly WalkyPane[];
  /** Run one send through the pane's Send Protocol, marked to be held over a draft until `hold.holdUntil`. */
  send(pane: WalkyPane, sendId: string, text: string, hold?: WalkyHold): Promise<SendResult>;
  /** The stored outcome of a send request, or null when the protocol never took it. */
  sendState(sendId: string): SendResult | null;
  /** Take back a held send. */
  cancelHeld(session: string, paneId: string, sendId: string): void;
}

/**
 * THE CREW SEAM. Spec 03 fills it: hand a message to the crew for one other member (`memberId`) or
 * for every other member (`"all"`), and answer the receipts the crew wrote. Absent, an address on
 * another member is refused `crew routing not built`, and `all` reaches this machine's panes only.
 * `panes` (M75): a scope's panes on that one member, as the lead's expansion named them, one leg each.
 */
export type RouteRemote = (message: WalkyMessage, members: string, panes?: readonly string[]) => Promise<readonly WalkyReceipt[]>;

/** The folder a scope names, or why it names none (deliver.ts `scopeOf`). */
type ScopeOf = { readonly ok: true; readonly scope: WalkyScope } | { readonly ok: false; readonly reason: string };

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
  /**
   * On a member, the pane id the lead's route named (`/crew/v1/pane/<pane>/walky`). Read for a scope
   * only (M75): it is the one pane the lead's expansion picked here, and this member checks its label.
   */
  readonly pane?: string;
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

/** Whether a target names a fan-out (`all`, `<member>/all`, or a scope a member handed its lead whole), not one pane. */
export function isFanOut(target: string): boolean {
  return target === "all" || target.endsWith("/all") || isScopeAddress(parseAddress(target));
}

/**
 * The receipts with every `<member>/all` leg left out once a pane on that member has a receipt of its
 * own: the panes answer for the leg (a slow member's report, crew.ts `mergeReport`). A leg with no
 * pane receipt stays, whatever its state.
 */
export function withoutAnsweredLegs<T extends Pick<WalkyReceipt, "target">>(receipts: readonly T[]): T[] {
  const answered = new Set<string>();
  for (const receipt of receipts) {
    const address = parseAddress(receipt.target);
    if (address?.kind === "pane") answered.add(address.memberId);
  }
  return receipts.filter((receipt) => {
    const address = parseAddress(receipt.target);
    return address?.kind !== "member-all" || !answered.has(address.memberId);
  });
}

/** Who sent a message, as delivery needs it: the pane it came from, if any. */
export interface SenderPane {
  readonly session: string;
  readonly paneId: string;
  /** The sender pane's instance token; null for a reply pinned by a log line from before instances. */
  readonly instance: string | null;
}

/** Whether a pane is the sender's: the same session and pane id, and the same instance when it is known. */
function isPaneOf(pane: WalkyPane, sender: SenderPane): boolean {
  return pane.session === sender.session && pane.paneId === sender.paneId && (sender.instance === null || pane.instance === sender.instance);
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
  /**
   * THE CREW SEAM FOR `who`. Spec 03 fills it: the targets the lead knows on other members. Absent,
   * `who` lists this machine's panes only. A scope send (M75) expands over the same list.
   */
  readonly remoteTargets?: () => readonly WalkyTarget[];
  /**
   * True on a crew member that is not the lead. Such a bridge hands a message for another machine to
   * its lead, and learns how it ended there only when the lead pushes the outcome back (CREW_PROTOCOL
   * §21). Until then `status` names those targets, and `who` says the other machines are the lead's
   * to list. A scope (M75) goes to the lead whole: the lead expands it.
   */
  readonly outcomesOnLead?: boolean;
  /** Every member id of the crew this bridge knows, read per message: a bare word that names one is no scope (M75). */
  readonly knownMembers?: () => readonly string[];
  /** The dedupe file, `<stateDir>/walky/seen.json`. Absent: in memory, for a test. */
  readonly seen?: WalkySeen;
  /** The refusal counter, `<stateDir>/walky/refusals.json`. Absent: in memory. */
  readonly refusals?: RefusalCounter;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** {@link LANE_WAIT_MS}, for a test. A real timer: the wait is for another send, not for the clock. */
  readonly laneWaitMs?: number;
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
  if (result.reason === "busy") return "pane busy";
  if (result.reason === "not_free") return "box not free";
  if (result.reason === "pane_gone") return "no such pane";
  return (result.reason ?? "refused").replace(/_/gu, " ");
}

/** What holds a send, in the receipt's words: `draft present`, or `turn running` for anything else. */
export function heldReason(result: SendResult): "draft present" | "turn running" {
  return result.reason === "draft_present" ? "draft present" : "turn running";
}

export class WalkyDeliverer {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rate: RateLimiter;
  private readonly pairs: RateLimiter;
  private readonly members: RateLimiter;
  private readonly seen: WalkySeen;
  private readonly refusals: RefusalCounter;
  private readonly running = new Set<Promise<void>>();
  /**
   * Per pane, the promise of the newest walky send this bridge started there: it resolves once the Send
   * Protocol answered that send (typed, refused, or `held`). A second message waits for it, so two
   * quick messages are typed one after the other, never into each other, and the second is not
   * refused `busy` by the first's own typing. A `held` answer releases the pane: the Send Protocol's
   * hold queue then keeps the order.
   */
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(private readonly deps: DelivererDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rate = deps.rate ?? new RateLimiter();
    this.pairs = deps.pairs ?? new RateLimiter(PAIR_LIMIT);
    this.members = deps.members ?? new RateLimiter(MEMBER_LIMIT);
    this.seen = deps.seen ?? new WalkySeen(null, this.now);
    this.refusals = deps.refusals ?? new RefusalCounter(null, this.now);
  }

  /** The `by` of every receipt this bridge writes. */
  get by(): string {
    return this.deps.memberId ?? "solo";
  }

  /** Every receipt this bridge writes. Its target never carries an instance token (address.ts `bareAddress`). */
  private receipt(id: string, target: string, state: WalkyReceiptState, extra: ReceiptExtra = {}): WalkyReceipt {
    const base: WalkyReceipt = { id, target: bareAddress(target), state, verified: extra.verified ?? "local", at: this.now(), by: this.by };
    // Cleaned to the form every reader keeps (types.ts `receiptReason`): an error text can be anything.
    const reason = receiptReason(extra.reason);
    const withReason = reason === undefined ? base : { ...base, reason };
    return extra.sendId === undefined ? withReason : { ...withReason, sendId: extra.sendId };
  }

  /** A refusal written by this bridge: nothing typed, nothing logged but the count (M62 hardening I). */
  refusal(id: string, target: string, reason: string, verified: WalkyVerified = "local"): WalkyReceipt {
    this.refusals.count(reason);
    return this.receipt(id, target, "refused", { reason, verified });
  }

  /** Count a refusal that wrote no receipt. */
  noteRefusal(reason: string): void {
    this.refusals.count(reason);
  }

  /** How many messages this bridge refused, per reason. */
  refusalCounts(): RefusalCounts {
    return this.refusals.current();
  }

  /** A newer receipt for a logged record: same id, target and verification, a new state. */
  private next(record: LogRecord, state: WalkyReceiptState, reason?: string, sendId?: string): WalkyReceipt {
    return this.receipt(record.message.id, record.target, state, { reason, sendId, verified: record.receipt.verified });
  }

  /** Resolves when every delivery started so far has settled. For tests and a clean stop. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all(this.running);
  }

  /** An address as this bridge spells it: `local/…` on a crew member is its own member id. The token stays. */
  private normal(raw: string): string {
    const address = parseAddress(raw);
    if (address === null || address.kind === "all" || address.kind === "workspace" || address.kind === "here") return raw;
    const member = isSelf(address.memberId, this.deps.memberId) ? (this.deps.memberId ?? LOCAL_MEMBER) : address.memberId;
    return address.kind === "pane" ? paneAddress(member, address.paneId, address.instance) : `${member}/all`;
  }

  /**
   * Whether `to` names the sender's own pane: the same member and pane id, and the same instance
   * unless one of the two names none. A message a crew hop brought has no sender pane here, so this
   * is the check that holds for it whatever spelling the sender chose.
   */
  private ownPane(from: string, to: string): boolean {
    const a = parseAddress(this.normal(from));
    const b = parseAddress(this.normal(to));
    if (a?.kind !== "pane" || b?.kind !== "pane") return false;
    return a.memberId === b.memberId && a.paneId === b.paneId && (a.instance === null || b.instance === null || a.instance === b.instance);
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
   *   `ambiguous pane`                  more than one session has a pane with the target's id (and token)
   *   `pane replaced`                   the address names a token, and the pane id is held by another instance
   *   `sender gone`                     a reply's pane is gone, now in another session, or another instance
   *   `not an agent pane`               the target is a shell
   *   `rate limit` / `pair limit`       a cap is full: the sender's, the lead's per member, or the pair's
   */
  async deliver(message: WalkyMessage, sender: SenderPane | null, options: DeliverOptions = {}): Promise<WalkyReceipt[]> {
    const verified = options.verified ?? "local";
    const refuse = (reason: string): WalkyReceipt[] => [this.refusal(message.id, message.to, reason, verified)];
    const address = parseAddress(message.to);
    if (address === null) return refuse("no such pane");
    if (isScopeAddress(address)) return this.deliverScope(message, address, sender, options);
    // The same id again: the receipts of the targets it already has. One pane, or another machine,
    // ends here; a fan-out goes on and finishes the targets it lacks (a crashed fan-out resumes).
    const done = this.prior(message, verified);
    if (done === null) return refuse("id reused");
    if (done.size > 0 && address.kind === "pane") return [...done.values()];
    if (address.kind !== "pane" && message.kind === "agent") return refuse("only the operator may broadcast");
    const remote = address.kind !== "all" && !isSelf(address.memberId, this.deps.memberId);
    if (remote && options.localOnly === true) return refuse("no such pane");
    if (message.from.address !== null && this.ownPane(message.from.address, message.to)) return refuse("that is your own pane");
    if (this.threadDepth(message) > THREAD_DEPTH_MAX) return refuse("thread depth");
    if (remote) return this.capped(message, 1, options) ?? this.remote(message, address.memberId, sender);
    if (!this.deps.enabled()) return refuse("off");
    const panes = this.deps.host.panes();
    const isSender = (pane: WalkyPane): boolean => sender !== null && isPaneOf(pane, sender);
    const self = this.deps.memberId ?? LOCAL_MEMBER;
    const refusedTargets: WalkyReceipt[] = [];
    let targets: WalkyPane[];
    if (address.kind === "pane") {
      let pane: WalkyPane | undefined;
      const pin = this.replyPin(message);
      if (pin !== null) {
        // The stored sender pane, and the instance that sent, when the log knows it.
        pane = panes.find((candidate) => isPaneOf(candidate, pin));
        if (pane === undefined || pane.paneId !== address.paneId) return refuse("sender gone");
        if (address.instance !== null && pane.instance !== address.instance) return refuse("sender gone");
      } else {
        const named = panes.filter((candidate) => candidate.paneId === address.paneId);
        // A token names one instance: the pane id held by another is a pane that closed and gave its id away.
        const meant = address.instance === null ? named : named.filter((candidate) => candidate.instance === address.instance);
        if (meant.length === 0 && named.length > 0) return refuse("pane replaced");
        if (meant.length > 1) return refuse("ambiguous pane");
        pane = meant[0];
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
    const fresh = targets.filter((pane) => !done.has(`${self}/${pane.paneId}`));
    const routes = address.kind === "all" && this.deps.routeRemote !== undefined && options.localOnly !== true;
    const routesOn = routes && !done.has("all");
    if (done.size > 0 && fresh.length === 0 && !routesOn) return withoutAnsweredLegs([...done.values()]);
    const capped = this.capped(message, fresh.length + (routesOn ? 1 : 0), options);
    if (capped !== null) return capped;
    const receipts: WalkyReceipt[] = [...refusedTargets];
    for (const pane of targets) {
      const target = `${self}/${pane.paneId}`;
      const held = done.get(target);
      if (held !== undefined) {
        receipts.push(held);
        continue;
      }
      receipts.push(this.place(message, target, pane, sender, verified));
    }
    // The crew leg: routed now, or (on a repeat) the receipts its first run wrote.
    if (routesOn) receipts.push(...(await this.remote(message, "all", sender)));
    else if (routes) receipts.push(...[...done].filter(([target]) => !targets.some((pane) => `${self}/${pane.paneId}` === target)).map(([, receipt]) => receipt));
    return withoutAnsweredLegs(receipts);
  }

  /**
   * Log one message for one pane of this bridge and start typing it: seen first, then logged, then
   * typed, so a crash between any two never types twice. Answers the `accepted` receipt.
   */
  private place(message: WalkyMessage, target: string, pane: WalkyPane, sender: SenderPane | null, verified: WalkyVerified): WalkyReceipt {
    const accepted = this.receipt(message.id, target, "accepted", { verified });
    this.seen.add(message, target);
    const record = this.deps.log.record(message, target, { session: pane.session, paneId: pane.paneId, instance: pane.instance }, accepted, sender);
    this.deps.log.inboxAdd(pane.session, pane.paneId, pane.instance, message);
    this.track(this.inLane(record, pane));
    return accepted;
  }

  /** Whether a bare word names a member: `local`, this bridge, or any member the crew lists. */
  private isMemberWord(word: string): boolean {
    if (isSelf(word, this.deps.memberId)) return true;
    if ((this.deps.knownMembers?.() ?? []).includes(word)) return true;
    return (this.deps.remoteTargets?.() ?? []).some((target) => target.memberId === word);
  }

  /**
   * The folder a scope names: the address's own for `<repo>` and `<repo>#<branch>`; for `here`, the
   * repo of the sender's pane label (any branch). A refusal's reason when there is none: a phone has
   * no pane, and a label that is the bare pane id names no folder.
   */
  private scopeOf(message: WalkyMessage, address: Extract<WalkyAddress, { kind: "workspace" | "here" }>): ScopeOf {
    if (address.kind === "workspace") return { ok: true, scope: { repo: address.repo, branch: address.branch } };
    const from = message.from.address === null ? null : parseAddress(message.from.address);
    if (message.kind === "operator" || from?.kind !== "pane") return { ok: false, reason: HERE_FROM_PHONE };
    const own = labelScope(message.from.label, from.paneId);
    return own === null ? { ok: false, reason: hereWithoutFolder(message.from.label) } : { ok: true, scope: { repo: own.repo, branch: null } };
  }

  /**
   * A scope (M75): `<repo>`, `<repo>#<branch>` or `here`. THE EXPANSION RUNS HERE, on the lead (or a solo
   * install), once, when the send arrives: from a local pane, from the phone, or over the crew hop from
   * a member. It reads the merged `who` list (this machine's agent panes and `remoteTargets`), keeps the
   * panes whose label sits in the scope, drops the sender's own pane, and makes one delivery per pane:
   * this machine's through the same log-then-type step as a fan-out, another member's through the crew
   * seam, one leg per pane. Every delivery has its own receipt under the message id, which is the
   * group's one parent id. A member the lead cannot reach gets one `<member>/all` line, `refused:
   * unreachable`, and no delivery. A member hands the scope to its lead whole; a member the lead dialled
   * checks the one pane the route names ({@link scopeDelivery}).
   */
  private async deliverScope(
    message: WalkyMessage,
    address: Extract<WalkyAddress, { kind: "workspace" | "here" }>,
    sender: SenderPane | null,
    options: DeliverOptions,
  ): Promise<WalkyReceipt[]> {
    const verified = options.verified ?? "local";
    const refuse = (reason: string): WalkyReceipt[] => [this.refusal(message.id, message.to, reason, verified)];
    const done = this.prior(message, verified);
    if (done === null) return refuse("id reused");
    if (options.localOnly === true) return this.scopeDelivery(message, address, options, done);
    // The same id again: what it already holds. A scope is expanded once.
    if (done.size > 0) return withoutAnsweredLegs([...done.values()]);
    const resolved = this.scopeOf(message, address);
    if (!resolved.ok) return refuse(resolved.reason);
    const { scope } = resolved;
    if (address.kind === "workspace" && address.branch === null && this.isMemberWord(address.repo)) return refuse(scopeIsMember(address.repo));
    if (this.threadDepth(message) > THREAD_DEPTH_MAX) return refuse("thread depth");
    // A member hands the scope to its lead whole: one token from the sender's bucket, and the lead expands it.
    if (this.deps.outcomesOnLead === true && this.deps.routeRemote !== undefined) {
      const caps = this.scopeCaps(message, [], options, true);
      if ("refused" in caps) return refuse(caps.refused);
      return this.remote(message, message.to, sender);
    }
    const self = this.deps.memberId ?? LOCAL_MEMBER;
    const from = message.from.address === null ? null : parseAddress(this.normal(message.from.address));
    const isFrom = (memberId: string, paneId: string): boolean => from?.kind === "pane" && from.memberId === memberId && from.paneId === paneId;
    const panes = this.deps.host.panes();
    const counts = new Map<string, number>();
    for (const pane of panes) counts.set(pane.paneId, (counts.get(pane.paneId) ?? 0) + 1);
    const local: WalkyPane[] = [];
    const ambiguous = new Set<string>();
    for (const pane of panes) {
      if (!pane.agent || (sender !== null && isPaneOf(pane, sender)) || isFrom(self, pane.paneId) || !inScope(pane.label, pane.paneId, scope)) continue;
      if ((counts.get(pane.paneId) ?? 0) > 1) ambiguous.add(`${self}/${pane.paneId}`);
      else local.push(pane);
    }
    // Every other member's panes, from the bodies the lead's sweep holds: no dial.
    const remote = new Map<string, string[]>();
    const unreachable = new Set<string>();
    for (const target of this.deps.remoteTargets?.() ?? []) {
      const at = parseAddress(target.address);
      if (at?.kind !== "pane" || at.memberId === self || isFrom(at.memberId, at.paneId) || !inScope(target.label, at.paneId, scope)) continue;
      if (target.state === "unreachable") {
        unreachable.add(at.memberId);
        continue;
      }
      const list = remote.get(at.memberId) ?? [];
      if (!list.includes(at.paneId)) list.push(at.paneId);
      remote.set(at.memberId, list);
    }
    const targets = [...local.map((pane) => `${self}/${pane.paneId}`), ...[...remote].flatMap(([memberId, ids]) => ids.map((paneId) => `${memberId}/${paneId}`))];
    if (targets.length === 0 && unreachable.size === 0 && ambiguous.size === 0) return refuse(scopeEmpty(message.to.trim()));
    if (targets.length > WALKY_LEG_PANES_MAX) return refuse(scopeTooWide(targets.length, WALKY_LEG_PANES_MAX));
    if (!this.deps.enabled()) return refuse("off");
    const caps = this.scopeCaps(message, targets, options, true);
    if ("refused" in caps) return refuse(caps.refused);
    const receipts: WalkyReceipt[] = [...ambiguous].map((target) => this.refusal(message.id, target, "ambiguous pane", verified));
    for (const target of caps.full) receipts.push(this.refusal(message.id, target, "pair limit", verified));
    for (const pane of local) {
      const target = `${self}/${pane.paneId}`;
      if (!caps.full.has(target)) receipts.push(this.place(message, target, pane, sender, verified));
    }
    for (const memberId of unreachable) receipts.push(this.unreachableLine(message, memberId, sender, verified));
    const legs = await Promise.all([...remote].map(([memberId, ids]) => this.remoteScope(message, memberId, ids.filter((paneId) => !caps.full.has(`${memberId}/${paneId}`)), sender)));
    receipts.push(...legs.flat());
    return receipts;
  }

  /**
   * On a member, one pane of a scope its lead routed here (M75). The member does not trust the lead's
   * list: it reads the label of the pane the route names NOW and delivers only while that label sits in
   * the scope the signed `to` names (for `here`, the repo of the sender's label), so a pane outside it
   * cannot ride a scope. The lead counted the sender's token; this member counts the pair's.
   */
  private scopeDelivery(
    message: WalkyMessage,
    address: Extract<WalkyAddress, { kind: "workspace" | "here" }>,
    options: DeliverOptions,
    done: ReadonlyMap<string, WalkyReceipt>,
  ): WalkyReceipt[] {
    const verified = options.verified ?? "local";
    if (options.pane === undefined) return [this.refusal(message.id, message.to, "no such pane", verified)];
    const target = `${this.deps.memberId ?? LOCAL_MEMBER}/${options.pane}`;
    const refuse = (reason: string): WalkyReceipt[] => [this.refusal(message.id, target, reason, verified)];
    const held = done.get(target);
    if (held !== undefined) return [held];
    const resolved = this.scopeOf(message, address);
    if (!resolved.ok) return refuse(resolved.reason);
    if (this.threadDepth(message) > THREAD_DEPTH_MAX) return refuse("thread depth");
    if (!this.deps.enabled()) return refuse("off");
    const named = this.deps.host.panes().filter((pane) => pane.paneId === options.pane);
    if (named.length > 1) return refuse("ambiguous pane");
    const pane = named[0];
    if (pane === undefined) return refuse("no such pane");
    if (!pane.agent) return refuse("not an agent pane");
    if (message.from.address !== null && this.ownPane(message.from.address, target)) return refuse("that is your own pane");
    if (!inScope(pane.label, pane.paneId, resolved.scope)) return refuse(OUT_OF_SCOPE);
    const caps = this.scopeCaps(message, [target], options, false);
    if ("refused" in caps) return refuse(caps.refused);
    if (caps.full.has(target)) return refuse("pair limit");
    return [this.place(message, target, pane, null, verified)];
  }

  /**
   * The caps of a scope (M75), checked together and taken together: one token from the sender's bucket
   * for the whole send (`sender` false on a member the lead dialled: the lead counted it), one per
   * delivery from the dialling member's bucket on a lead, and one per delivery from each pair's. A full
   * sender or member bucket refuses the send; a full pair refuses that delivery only.
   */
  private scopeCaps(message: WalkyMessage, targets: readonly string[], options: DeliverOptions, sender: boolean): { readonly refused: string } | { readonly full: ReadonlySet<string> } {
    const now = this.now();
    const key = senderKey(message.kind, message.from.memberId, message.from.address === null ? null : bareAddress(message.from.address));
    const from = message.from.address === null ? null : bareAddress(this.normal(message.from.address));
    if (sender && !this.rate.room(key, now)) return { refused: "rate limit" };
    if (options.via !== undefined && targets.length > 0 && !this.members.room(options.via, now, targets.length)) return { refused: "rate limit" };
    const full = new Set(from === null ? [] : targets.filter((target) => !this.pairs.room(pairKey(from, target), now)));
    const taken = targets.filter((target) => !full.has(target));
    if (sender) this.rate.take(key, now);
    if (options.via !== undefined && taken.length > 0) this.members.take(options.via, now, taken.length);
    if (from !== null) for (const target of taken) this.pairs.take(pairKey(from, target), now);
    return { full };
  }

  /** The line of a member the lead cannot reach (M75): `<member>/all`, `refused: unreachable`, logged, no delivery and no retry. */
  private unreachableLine(message: WalkyMessage, memberId: string, sender: SenderPane | null, verified: WalkyVerified): WalkyReceipt {
    const line = this.receipt(message.id, `${memberId}/all`, "refused", { reason: MEMBER_UNREACHABLE, verified });
    this.deps.log.record(message, line.target, { session: null, paneId: null, instance: null }, line, sender);
    return line;
  }

  /**
   * A scope's panes on one other member (M75): one `accepted` line per pane, logged before the dial,
   * then one leg per pane through the crew seam. The member's answer replaces a line only while it is
   * `accepted`; a dial that failed leaves each pane `unknown`, never sent again.
   */
  private async remoteScope(message: WalkyMessage, memberId: string, paneIds: readonly string[], sender: SenderPane | null): Promise<WalkyReceipt[]> {
    if (paneIds.length === 0) return [];
    const targets = paneIds.map((paneId) => `${memberId}/${paneId}`);
    const route = this.deps.routeRemote;
    if (route === undefined) return targets.map((target) => this.refusal(message.id, target, "crew routing not built"));
    const placement: Placement = { session: null, paneId: null, instance: null };
    const accepted = targets.map((target) => {
      const receipt = this.receipt(message.id, target, "accepted");
      this.seen.add(message, target);
      this.deps.log.record(message, target, placement, receipt, sender);
      return receipt;
    });
    try {
      const answered = (await route(message, memberId, paneIds)).filter((receipt) => receipt.id === message.id);
      for (const receipt of answered) this.logAnswer(message, receipt, placement, sender);
      return accepted.map((line) => answered.find((receipt) => receipt.target === line.target) ?? line);
    } catch (err) {
      return accepted.map((line) => {
        const failed = this.receipt(message.id, line.target, "unknown", { reason: `crew: ${err instanceof Error ? err.message : String(err)}` });
        if (this.deps.log.get(message.id, line.target)?.receipt.state === "accepted") this.deps.log.update(failed);
        return failed;
      });
    }
  }

  /**
   * One receipt the crew answered, into this bridge's log: a target of its own when the log holds none
   * for it, else over an `accepted` only (CREW_PROTOCOL §21). A receipt for a pane placed on this
   * bridge is its own delivery's word and is left alone: a scope the lead routed back to the sender's
   * own machine (M75) answers it twice.
   */
  private logAnswer(message: WalkyMessage, receipt: WalkyReceipt, placement: Placement, sender: SenderPane | null): void {
    // A refusal the routing side wrote itself (an older member, a bad signature) counts here too.
    if (receipt.state === "refused" && receipt.reason !== undefined && receipt.by === this.by) this.refusals.count(receipt.reason);
    const held = this.deps.log.get(message.id, receipt.target);
    if (held === null) this.deps.log.record(message, receipt.target, placement, receipt, sender);
    // The answer of this dial replaces only `accepted`: while it was on its way, a member's report or
    // the lead's push may have written the real outcome, and a slow leg's `unknown` or a late
    // `accepted` must not go over it.
    else if (held.session === null && held.receipt.state === "accepted") this.deps.log.update(receipt);
  }

  /**
   * What this bridge already holds for a message id, by target: the log's receipts, and a seen entry
   * the log lost answers `unknown` (it may have been typed; it is never typed again). Null when the
   * id belongs to another message.
   */
  private prior(message: WalkyMessage, verified: WalkyVerified): Map<string, WalkyReceipt> | null {
    const records = this.deps.log.all(message.id);
    if (records.length > 0 && !sameMessage(records[0]!.message, message)) return null;
    const entries = this.seen.of(message.id);
    const hash = entries.length === 0 ? null : seenHash(message);
    if (entries.some((entry) => entry.hash !== hash)) return null;
    const out = new Map<string, WalkyReceipt>();
    for (const record of records) out.set(record.target, record.receipt);
    for (const entry of entries) if (!out.has(entry.target)) out.set(entry.target, this.receipt(message.id, entry.target, "unknown", { reason: "no log record", verified }));
    return out;
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
    const { session, paneId, instance } = parent.sender;
    return session === null || paneId === null ? null : { session, paneId, instance };
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
    // A sender and a pair are counted by pane id, the token left out, so a new spelling never opens a new bucket.
    const key = senderKey(message.kind, message.from.memberId, message.from.address === null ? null : bareAddress(message.from.address));
    const pair = message.from.address === null ? null : pairKey(bareAddress(this.normal(message.from.address)), bareAddress(this.normal(message.to)));
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
    if (route === undefined) return [this.refusal(message.id, message.to, "crew routing not built")];
    const placement: Placement = { session: null, paneId: null, instance: null };
    const accepted = this.receipt(message.id, members === "all" ? "all" : message.to, "accepted");
    this.seen.add(message, accepted.target);
    this.deps.log.record(message, accepted.target, placement, accepted, sender);
    try {
      const receipts = [...(await route(message, members))];
      // A fan-out comes back as one receipt per pane on the far side: each is logged as a target of
      // its own, so `status` and the outcome report (crew.ts) can find it by id and target.
      for (const receipt of receipts) if (receipt.id === message.id) this.logAnswer(message, receipt, placement, sender);
      return receipts.length === 0 ? [accepted] : receipts;
    } catch (err) {
      const failed = this.receipt(message.id, accepted.target, "unknown", { reason: `crew: ${err instanceof Error ? err.message : String(err)}` });
      if (this.deps.log.get(message.id, accepted.target)?.receipt.state === "accepted") this.deps.log.update(failed);
      return [failed];
    }
  }

  private track(work: Promise<void>): void {
    const tracked = work.catch((err: Error) => this.deps.warn?.(`[walky] delivery failed: ${err.message}`)).finally(() => this.running.delete(tracked));
    this.running.add(tracked);
  }

  /**
   * Type one logged message once the pane's earlier walky send was answered. The first message to a
   * free pane starts at once, in this same tick, so its send id is on disk before any await. The
   * receipt stays `accepted` while it waits, as a hold does.
   */
  private async inLane(record: LogRecord, pane: WalkyPane): Promise<void> {
    const key = `${pane.session}\u0000${pane.paneId}`;
    const before = this.lanes.get(key) ?? null;
    const { promise: mine, resolve: release } = Promise.withResolvers<void>();
    this.lanes.set(key, mine);
    const done = (): void => {
      release();
      if (this.lanes.get(key) === mine) this.lanes.delete(key);
    };
    try {
      if (before !== null && !(await this.waited(before))) {
        this.deps.log.update(this.next(record, "inbox-only", PANE_BUSY));
        return;
      }
      await this.type(record, pane, done);
    } finally {
      done();
    }
  }

  /** Whether `before` resolved inside {@link LANE_WAIT_MS}. */
  private async waited(before: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.deps.laneWaitMs ?? LANE_WAIT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([before.then(() => true), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Type one logged message into its pane, and write how it ended. `answered`: the Send Protocol answered. */
  private async type(record: LogRecord, pane: WalkyPane, answered: () => void = () => undefined): Promise<void> {
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
      result = await this.deps.host.send(pane, sendId, formatEnvelope(message), { draftHolds: true, holdUntil: record.acceptedAt + HELD_LIMIT_MS });
    } catch (err) {
      result = { outcome: "unknown", reason: err instanceof Error ? err.message : String(err) };
    }
    answered();
    await this.settle(record, pane.session, pane.paneId, pane.instance, sendId, result);
  }

  /**
   * Write the receipt an outcome stands for. A held send is watched until it ends or its one clock runs
   * out, {@link HELD_LIMIT_MS} from the acceptance (`acceptedAt`, never a newer receipt's time, so a
   * restart never extends it). While held, the receipt stays `accepted` with what holds it.
   */
  private async settle(record: LogRecord, session: string, paneId: string, instance: string | null, sendId: string, first: SendResult): Promise<void> {
    const { message } = record;
    let result = first;
    if (result.outcome === "held") {
      const until = record.acceptedAt + HELD_LIMIT_MS;
      // The reason already on the receipt (a restart reads it back), so a repeat writes no line.
      let said = record.receipt.state === "accepted" ? record.receipt.reason : undefined;
      while (result.outcome === "held" && this.now() < until) {
        const why = heldReason(result);
        if (why !== said) {
          this.deps.log.update(this.next(record, "accepted", why, sendId));
          said = why;
        }
        await this.sleep(HELD_POLL_MS);
        // A person took the message back meanwhile (`takeBack`): its receipt is written, and the Send
        // Protocol's `cancelled` is that take-back, not a new outcome to write over it.
        if (this.ended(record)) return;
        result = this.deps.host.sendState(sendId) ?? result;
      }
      if (this.ended(record)) return;
      if (result.outcome === "held") {
        // Take it back, then read what the Send Protocol says now: it may have gone out at the last
        // moment, and a hold the cancel did not reach may still go out. Only a cancel it confirmed
        // means nothing was typed.
        this.deps.host.cancelHeld(session, paneId, sendId);
        const after = this.deps.host.sendState(sendId);
        if (after?.outcome === "cancelled" || after?.outcome === "expired") {
          this.deps.log.update(this.next(record, "inbox-only", HELD_PAST, sendId));
          return;
        }
        if (after === null || after.outcome === "held") {
          this.deps.log.update(this.next(record, "unknown", `${HELD_PAST}, still pending`, sendId));
          return;
        }
        result = after;
      }
      // The Send Protocol's hold ends at the same moment as this clock: its `expired` is this clock's
      // end. The ended row goes too, so the phone offers no Resend of a walky envelope.
      if (result.outcome === "expired" && this.now() >= until) {
        this.deps.host.cancelHeld(session, paneId, sendId);
        this.deps.log.update(this.next(record, "inbox-only", HELD_PAST, sendId));
        return;
      }
      // The release found another instance at the pane (`stillMeant`): the message stays in the inbox.
      if (result.outcome === "refused" && result.reason === "pane_gone" && this.replaced(record)) {
        this.deps.log.update(this.next(record, "inbox-only", "pane replaced", sendId));
        return;
      }
    }
    if (result.outcome === "sent" || result.outcome === "effective") {
      this.deps.log.update(this.next(record, "delivered", undefined, sendId));
      // The operator's body was typed: read. An agent's was not: it waits for `inbox <id>`.
      // A record from before instances names no inbox this log still writes: nothing to ack.
      if (message.kind === "operator" && instance !== null) this.deps.log.ack(session, paneId, instance, [message.id]);
      return;
    }
    if (result.outcome === "unknown") {
      this.deps.log.update(this.next(record, "unknown", result.reason?.replace(/_/gu, " "), sendId));
      return;
    }
    this.deps.log.update(this.next(record, "inbox-only", reasonOf(result), sendId));
  }

  /** Whether the log's newest receipt for this record has left `accepted`: someone else settled it. */
  private ended(record: LogRecord): boolean {
    const now = this.deps.log.get(record.message.id, record.target);
    return now !== null && now.receipt.state !== "accepted";
  }

  /**
   * Take one held message back (M62 spec 03), for its sender (`reason` {@link CANCELLED_BY_SENDER}) or
   * for the owner of the pane it waits for ({@link DROPPED_BY_OWNER}). Only a send that is `accepted`
   * with a held reason, and placed on a pane of this bridge, is touched: the Send Protocol's cancel
   * is asked, and only a cancel it confirmed (`cancelled`, or `expired` on the same clock) ends the
   * send as `inbox-only` with the reason. The hold watcher (`settle`) reads that receipt and stops,
   * so one send id types at most once and the reason stays the person's. A message that typed, may
   * have typed, or is going out now keeps its receipt (`already typed`), as does one not held
   * (`not held`); a repeat answers the stored `inbox-only` receipt and changes nothing. A message
   * held on another machine (no pane here) is `elsewhere`. The caller decided who may ask.
   */
  takeBack(record: LogRecord, reason: typeof CANCELLED_BY_SENDER | typeof DROPPED_BY_OWNER): TakeBack {
    const { receipt, target } = record;
    const answer = (result: TakeBack["result"], newer: WalkyReceipt = receipt): TakeBack => ({ target, result, receipt: newer });
    if (receipt.state === "inbox-only") return answer("repeat");
    if (receipt.state === "delivered" || receipt.state === "unknown") return answer("already typed");
    if (receipt.state !== "accepted" || receipt.reason === undefined) return answer("not held");
    if (record.session === null || record.paneId === null) return answer("elsewhere");
    const sendId = receipt.sendId ?? sendIdOf(record.message.id, target);
    this.deps.host.cancelHeld(record.session, record.paneId, sendId);
    const after = this.deps.host.sendState(sendId);
    if (after !== null && after.outcome !== "cancelled" && after.outcome !== "expired") return answer("already typed");
    const written = this.next(record, "inbox-only", reason, sendId);
    this.deps.log.update(written);
    return answer("taken", this.deps.log.get(record.message.id, target)?.receipt ?? written);
  }

  /** Whether the record's pane id is held by another instance now. A record from before instances never is. */
  private replaced(record: LogRecord): boolean {
    if (record.instance === null || record.session === null || record.paneId === null) return false;
    const now = this.deps.host.panes().find((pane) => pane.session === record.session && pane.paneId === record.paneId);
    return now !== undefined && now.instance !== record.instance;
  }

  /**
   * The Send Protocol's last check before a held send goes out (its `releaseCheck`, M62 spec 02): false
   * when the send is a walky message of this log whose pane is gone or holds another instance now, so a
   * replaced pane never takes it. A request this log does not know, or a record from before instances,
   * goes ahead.
   */
  stillMeant(sendId: string, session: string, paneId: string): boolean {
    if (!SEND_ID.test(sendId)) return true;
    const id = sendId.slice(0, sendId.lastIndexOf("-"));
    const record = this.deps.log.all(id).find((candidate) => candidate.session === session && candidate.paneId === paneId && sendIdOf(candidate.message.id, candidate.target) === sendId);
    if (record === undefined || record.instance === null) return true;
    const pane = this.deps.host.panes().find((candidate) => candidate.session === session && candidate.paneId === paneId);
    return pane !== undefined && pane.instance === record.instance;
  }

  /**
   * After a restart: every receipt still `accepted` is settled from what the Send Protocol stored.
   * The send id is DERIVED from the message id and the target (`sendIdOf`), never read from the
   * receipt: a crash between logging and writing the send id must not hide a send that went out. A
   * send id the protocol never took means no key went out: `inbox-only`. A held send is watched again
   * from where it stood, on the same clock: it counts from the acceptance, so a restart never extends
   * it. Nothing here sends.
   */
  recover(): number {
    let count = 0;
    for (const record of this.deps.log.pending()) {
      const { session, paneId } = record;
      if (session === null || paneId === null) continue;
      count += 1;
      const sendId = sendIdOf(record.message.id, record.target);
      const state = this.deps.host.sendState(sendId);
      if (state === null) {
        this.deps.log.update(this.next(record, "inbox-only", "bridge restarted"));
        continue;
      }
      this.track(this.settle(record, session, paneId, record.instance, sendId, state));
    }
    return count;
  }
}
