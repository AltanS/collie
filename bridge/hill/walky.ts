// The hill's two seams into WalkyTalky (M96), read-only over bridge/walky/: which live session a walky
// address names now (the "is this address live" probe), and the operator send that types an answer.
// Nothing here opens a path into a pane of its own: the send is `WalkyService.send` with
// `{ kind: "operator", label }`, as `POST /api/walky` calls it.

import { neutraliseViewHeads } from "../../web/src/lib/agent-view/wire.ts";
import { maskTerminalTitle } from "../answer-mask.ts";
import { paneName, type NameableP } from "../pane-name.ts";
import { realAgentPanes } from "../tricks/panes.ts";
import { isSelf, LOCAL_MEMBER, parseAddress } from "../walky/address.ts";
import type { TrustStoreData } from "../crew/trust-store.ts";
import type { WalkyService } from "../walky/service.ts";
import { mintWalkyId, type WalkyReceipt } from "../walky/types.ts";
import type { HillPlace, HillSendResult } from "./service.ts";

/** How long the answer waits for walky's receipt to leave a bare `accepted`, as `collie walky send` does. */
export const HILL_SEND_WAIT_MS = 15_000;
/** How often it looks while it waits. */
export const HILL_SEND_POLL_MS = 250;

/**
 * One read of a source per pass. Outside `within`, `read` reads the source every time. Inside it, the
 * first `read` reads the source and every later one in the same pass answers that value, so a list of
 * decisions resolves every name against one `who` list instead of one per decision. Passes nest; the
 * value is let go when the outermost ends. Synchronous only: `fn` must not await.
 */
export class OneLook<T> {
  private held: { readonly value: T } | null = null;
  private depth = 0;

  constructor(private readonly source: () => T) {}

  readonly read = (): T => {
    if (this.depth === 0) return this.source();
    this.held ??= { value: this.source() };
    return this.held.value;
  };

  readonly within = <R>(fn: () => R): R => {
    this.depth += 1;
    try {
      return fn();
    } finally {
      this.depth -= 1;
      if (this.depth === 0) this.held = null;
    }
  };
}

/**
 * The probe: the one live agent session a walky pane address names now, as `who` lists it, with the
 * instance token it holds. An address with a token matches only that instance; one without, whatever
 * session holds the pane id now. Null for a scope, a shell pane, a pane that is gone, or two matches.
 * `memberId` is this bridge's (null: solo), so `local/...` and `<self>/...` name the same panes.
 */
export function walkyPlace(walky: Pick<WalkyService, "who">, memberId: string | null, unattended: (address: string) => boolean = () => false): (address: string) => HillPlace | null {
  const self = memberId ?? LOCAL_MEMBER;
  const member = (id: string): string => (isSelf(id, memberId) ? self : id);
  return (raw) => {
    const wanted = parseAddress(raw);
    if (wanted === null || wanted.kind !== "pane") return null;
    const hits = walky.who().filter((target) => {
      const listed = parseAddress(target.address);
      if (listed === null || listed.kind !== "pane") return false;
      return member(listed.memberId) === member(wanted.memberId) && listed.paneId === wanted.paneId && (wanted.instance === null || listed.instance === wanted.instance);
    });
    if (hits.length !== 1) return null;
    const hit = hits[0]!;
    const place = { address: hit.address, label: hit.label, host: hit.machine, unattended: unattended(hit.address) };
    // §22: a member the lead's sweep cannot reach now. Its Decisions wait; an answer to one is refused.
    return hit.state === "unreachable" ? { ...place, reachable: false } : place;
  };
}

/** One crew member as the lead's sweep holds it, as far as the census reads it. */
export interface HillCensusMember {
  readonly memberId: string;
  /** The lead's sweep reached it at its last try. */
  readonly reachable: boolean;
  /** Its sessions as its last good answer listed them (each with its own last read), or null with none. */
  readonly sessions: readonly { readonly reachable: boolean }[] | null;
}

/** At least one session, and the last read of every one answered. */
function goodCensus(sessions: readonly { readonly reachable: boolean }[] | null): boolean {
  return sessions !== null && sessions.length > 0 && sessions.every((session) => session.reachable);
}

/**
 * Whether the bridge holds a census of the machine a walky address is on that was read with success
 * (M96 spec 10), the Hill sweep's `censusKnown`. On this machine: it drives at least one session and the
 * last read of every one answered (the state engine's `connected`, which starts `disconnected` until the
 * first good read after boot, and keeps the last good panes when a read fails). On a crew member: the
 * lead's sweep reached it, it answered with at least one session, and that machine's own last read of
 * every one answered. Anything else is unknown, also an address that is not a pane's.
 */
export function hillCensus(opts: {
  readonly memberId: string | null;
  readonly local: () => readonly { readonly reachable: boolean }[];
  readonly members: () => readonly HillCensusMember[];
}): (address: string) => boolean {
  return (raw) => {
    const at = parseAddress(raw);
    if (at === null || at.kind !== "pane") return false;
    if (isSelf(at.memberId, opts.memberId)) return goodCensus(opts.local());
    const member = opts.members().find((candidate) => candidate.memberId === at.memberId);
    return member !== undefined && member.reachable && goodCensus(member.sessions);
  };
}

/**
 * Every member id a trust store lists, whatever the row's status: this machine, its lead and its peers.
 * What {@link hillLeftTheCrew} reads as the roster. A member id is the member's stable key: a re-join
 * under the same pinned certificate keeps it (crew/enrollment.ts `enrollPeer`), `crew rename` changes
 * only the crew's display name, and a takeover carries the old lead as a peer (crew/takeover.ts). So an
 * id leaves this list only when its row is deleted: `crew remove`, or the member's own `crew leave`.
 */
export function hillRosterIds(data: Pick<TrustStoreData, "self" | "lead" | "peers"> | null): string[] | null {
  if (data === null) return null;
  return [data.self.memberId, ...(data.lead === null ? [] : [data.lead.memberId]), ...data.peers.map((member) => member.memberId)];
}

/**
 * Whether a walky address is on a crew machine that the roster no longer lists (M96 spec 10), the Hill
 * sweep's `removed`. `roster` answers every member id the trust store lists now, whatever its status (the
 * lead, the peers, this machine), or null when there is no roster this bridge read with success. An
 * address on this machine (`local`, this bridge's walky member, or one of `ownIds`, its bridge ids now
 * and before) is never removed; neither is anything when the roster is unknown.
 */
export function hillLeftTheCrew(opts: {
  readonly memberId: string | null;
  readonly ownIds: readonly (string | null)[];
  readonly roster: () => readonly string[] | null;
}): (address: string) => boolean {
  return (raw) => {
    const at = parseAddress(raw);
    if (at === null || at.kind !== "pane" || isSelf(at.memberId, opts.memberId) || opts.ownIds.includes(at.memberId)) return false;
    const roster = opts.roster();
    return roster !== null && !roster.includes(at.memberId);
  };
}

/** A pane as the snapshot holds it, as far as the Dashboard's name rule reads it. */
export type HillNameablePane = NameableP & { readonly paneId: string };

/**
 * The session's name as the Dashboard's row shows it, for the live pane a walky address names now, or
 * null. The same source and the same order as the row (`paneName`, mirrored in web/src/lib/pane-name.ts):
 * the pane's own label, then the harness's session name, then a named one-pane tab's label, then a
 * terminal title that is not stale, then the agent word. With COLLIE_REDACT on, the title is masked
 * first, as the snapshot masks it. Null for an address that is not live now (the instance token must
 * still match, through `place`), for a pane on another crew member (this machine has no view of it),
 * and for a pane id that no view, or more than one, holds. The caller then keeps the walky label.
 */
export function hillSessionName(opts: {
  readonly place: (address: string) => HillPlace | null;
  readonly views: () => readonly HillNameablePane[];
  readonly memberId: string | null;
  readonly redact: boolean;
}): (address: string) => string | null {
  return (raw) => {
    const placed = opts.place(raw);
    const at = placed === null ? null : parseAddress(placed.address);
    if (at === null || at.kind !== "pane" || !isSelf(at.memberId, opts.memberId)) return null;
    // A trick session is never a session a Decision names (its id is reserved, `trick:`); read past it anyway.
    const views = realAgentPanes(opts.views()).filter((view) => view.paneId === at.paneId);
    if (views.length !== 1) return null;
    const view = views[0]!;
    const name = paneName(opts.redact ? maskTerminalTitle(view) : view).trim();
    return name === "" ? null : name;
  };
}

/**
 * What walky's receipt says of a typed answer: typed, held by its hold rule, refused (walky typed nothing:
 * a rate limit, a pane that is gone, WalkyTalky off for that session), or not confirmed.
 */
export function deliveryOf(receipt: WalkyReceipt | undefined): HillSendResult {
  if (receipt === undefined) return "unknown";
  if (receipt.state === "delivered") return "typed";
  if (receipt.state === "refused") return "refused";
  if (receipt.state === "accepted" && receipt.reason !== undefined) return "held";
  // In the inbox (typed but not submitted, a dialog, a hold past its clock): known, and not lost.
  if (receipt.state === "inbox-only") return "inbox-only";
  return "unknown";
}

/** Whether a receipt will say no more for now: anything but a bare `accepted`. */
function settled(receipt: WalkyReceipt | undefined): boolean {
  return receipt === undefined || receipt.state !== "accepted" || receipt.reason !== undefined;
}

export interface WalkySendOptions {
  readonly mintId?: () => string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitMs?: number;
  /** The rate bucket the sends are counted in (walky/deliver.ts `DeliverOptions.budget`): `hill-tell` for a tell. */
  readonly budget?: "hill-tell";
}

/**
 * The send: one operator walky message to one address, under the device's label. It waits up to
 * {@link HILL_SEND_WAIT_MS} for walky's receipt to leave a bare `accepted`, then reports. A refusal (walky
 * typed nothing) is `refused`; an inbox-only or a receipt still bare at the bound is `unknown`. Nothing is
 * sent again.
 */
export function walkySend(walky: Pick<WalkyService, "send" | "status">, options: WalkySendOptions = {}): (to: string, body: string, by: string) => Promise<HillSendResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = options.waitMs ?? HILL_SEND_WAIT_MS;
  return async (to, body, by) => {
    const id = (options.mintId ?? mintWalkyId)();
    // Collie composes this text from stored words (an answer, a crew state): a line that would read as a
    // view's head is made harmless, never refused, so the receipt still goes (agent views SECURITY rule 2).
    const answer = await walky.send({ id, to, body: neutraliseViewHeads(body), replyTo: null }, { kind: "operator", label: by }, options.budget === undefined ? {} : { budget: options.budget });
    if (!answer.ok) return "refused";
    let receipt = answer.receipts[0];
    const until = now() + waitMs;
    while (!settled(receipt) && now() < until) {
      await sleep(HILL_SEND_POLL_MS);
      const target = receipt?.target;
      receipt = walky.status(id).receipts.find((held) => held.target === target) ?? receipt;
    }
    return deliveryOf(receipt);
  };
}
