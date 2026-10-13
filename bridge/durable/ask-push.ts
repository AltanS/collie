// WHERE THE ASK GUARD MEETS THE PUSH PATH (ADR 0100, rule 5).
//
// Every other pane pushes on its way INTO `blocked`: the state engine (or, on a lead, the diff of a
// peer's swept body) hands the transition to the `NotificationCoordinator`, which debounces it and
// renders the one herd summary. A pane that carries asks as data does not: its way into `blocked`
// is held back, and the guard decides instead, once per ask, keyed on `(host, session, toolCallId)`. When the
// guard says `push` for any ask of a pane, the pane is handed to the coordinator as blocked, and the
// coordinator does what it does for every pane (debounce, summary, retract when it resolves).
//
// Only the way into `blocked` is held. Every other transition (a resolve, a finished turn) reaches
// the coordinator as before, so an answered ask still clears the lock screen. A pane without an
// `asks` field is untouched, which is every pane of every other adapter, and every pane from a peer
// that predates the field.
//
// Two callers, one rule: a collie's own sessions (`bridge/index.ts`, host `""`, this machine) and a
// lead's peers (`bridge/crew/notify.ts`, host = the member id). The guard runs WHERE THE PUSH IS
// SENT: a peer's herd pushes are muted (CREW_PROTOCOL.md §5), so a peer runs no guard and the lead
// runs it over the swept body. A solo collie runs it over its own panes.
//
// WHAT A PUSH SAYS. The pane goes to the coordinator with the cause `ask`, and its one-pane push reads
// "Permission needed in <pane>" (`push-titles.ts`, `ask.permission`), where <pane> is the push name
// (`pushName`: the operator's label, never the program's title). Never the ask's title, its reason or
// its tool line. A program MAY choose the words of its own push, though: an ask's `push.title` and
// `push.line` (WIRE.md section 6) replace the headline and the body, each only when present. They are
// cleaned and cut again HERE (`pushTextOf`), because a lead gets them from a member over the wire. The
// push name still leads the headline ("<pane>: <title>"), so a push always says where it comes from,
// and the guard decides whether it is sent at all: the words change, the caps do not. When a host's hourly breaker trips, the caller sends ONE summary push built by
// {@link askFloodMessage}, and nothing more for that host for the hour.

import type { PushMessage } from "../push.ts";
import { pushTitle } from "../push-titles.ts";
import type { AgentStatus, Ask, AskPushText } from "../types.ts";
import { DEFAULT_GUARD_SESSION, type AskGuardStore, type GuardPane } from "./guard.ts";
import { keyableAsks, pushTextOf } from "./parse.ts";

/** The host key for this collie's own panes. A peer's panes are keyed by its member id. */
export const LOCAL_ASK_HOST = "";

/** What the push path reads of a pane: its id, and its asks when it carries them. */
export interface AskPushPane {
  readonly paneId: string;
  readonly asks?: readonly Ask[] | undefined;
}

export class AskPush {
  constructor(
    private readonly guard: AskGuardStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** True for a pane that carries asks as data on its way into `blocked`: the guard decides that push. */
  static holds(pane: { readonly asks?: readonly Ask[] | undefined }, to: AgentStatus): boolean {
    return to === "blocked" && Array.isArray(pane.asks);
  }

  /**
   * Run the guard over one session's panes on one host, as seen now, and call `raise` once for each pane
   * with at least one `push` verdict. `text` is the push words of the first such ask that has any,
   * cleaned; absent when none has. Panes without an `asks` field are not the guard's. `flood` is called
   * once, on the observation that trips this session's hourly breaker. `session` is the registry name
   * of the session the panes are in (M55); absent reads as `default`.
   */
  observe<P extends AskPushPane>(
    host: string,
    panes: readonly P[],
    raise: (pane: P, text?: AskPushText) => void,
    flood?: () => void,
    session: string = DEFAULT_GUARD_SESSION,
  ): void {
    const carrying: { pane: P; guarded: GuardPane }[] = [];
    for (const pane of panes) {
      if (!Array.isArray(pane.asks)) continue;
      carrying.push({ pane, guarded: { paneId: pane.paneId, asks: keyableAsks(pane.asks) } });
    }
    const observed = this.guard.observe(host, carrying.map((entry) => entry.guarded), this.now(), session);
    for (const { pane } of carrying) {
      const pushed = (observed.verdicts.get(pane.paneId) ?? []).filter((verdict) => verdict.decision === "push");
      if (pushed.length === 0) continue;
      raise(pane, pushTextFor(pane, pushed.map((verdict) => verdict.ask.id)));
    }
    if (observed.flood) flood?.();
  }

  /** A host left the crew: what it had open closes now (`bridge/crew/notify.ts`, `forget`). */
  forget(host: string): void {
    this.guard.forgetHost(host, this.now());
  }
}

/** The push words of the first of `askIds` (in the pane's order of verdicts) that carries any, cleaned. */
function pushTextFor(pane: AskPushPane, askIds: readonly string[]): AskPushText | undefined {
  for (const id of askIds) {
    const text = pushTextOf((pane.asks ?? []).find((candidate) => candidate?.id === id));
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * The notification slot of one session's flood summary on one host: its own, so it never replaces the
 * herd summary, and one per (host, session), because each program has its own breaker (M55). The
 * `default` session keeps the slot it had before sessions were part of the key.
 */
export function askFloodTag(host: string, session: string = DEFAULT_GUARD_SESSION): string {
  const base = host === LOCAL_ASK_HOST ? "collie:asks" : `collie:asks:${host}`;
  return session === DEFAULT_GUARD_SESSION ? base : `${base}/${session}`;
}

/**
 * The one summary push a session gets when its ask breaker trips. `hostName` is what the operator calls
 * the machine (the member id on a lead, this machine's name for its own panes), with the session's name
 * beside it when there is more than one. It names the host and nothing a program wrote.
 */
export function askFloodMessage(host: string, hostName: string, session: string = DEFAULT_GUARD_SESSION): PushMessage {
  const msg: PushMessage = { ...pushTitle("ask.flood", { host: hostName }), body: "", tag: askFloodTag(host, session), renotify: true };
  if (host !== LOCAL_ASK_HOST) msg.host = host;
  if (session !== DEFAULT_GUARD_SESSION) msg.session = session;
  return msg;
}
