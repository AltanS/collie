// The hill's two seams into WalkyTalky (M96), read-only over bridge/walky/: which live session a walky
// address names now (the "is this address live" probe), and the operator send that types an answer.
// Nothing here opens a path into a pane of its own: the send is `WalkyService.send` with
// `{ kind: "operator", label }`, as `POST /api/walky` calls it.

import { maskTerminalTitle } from "../answer-mask.ts";
import { paneName, type NameableP } from "../pane-name.ts";
import { realAgentPanes } from "../tricks/panes.ts";
import { isSelf, LOCAL_MEMBER, parseAddress } from "../walky/address.ts";
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
    const answer = await walky.send({ id, to, body, replyTo: null }, { kind: "operator", label: by }, options.budget === undefined ? {} : { budget: options.budget });
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
