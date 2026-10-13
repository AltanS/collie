// WHERE THE ASK GUARD MEETS THE PUSH PATH (ADR 0100, rule 5).
//
// Every other pane pushes on its way INTO `blocked`: the state engine (or, on a lead, the diff of a
// peer's swept body) hands the transition to the `NotificationCoordinator`, which debounces it and
// renders the one herd summary. A pane that carries asks as data does not: its way into `blocked`
// is held back, and the guard decides instead, once per ask, keyed on `(host, toolCallId)`. When the
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
// its tool line. When a host's hourly breaker trips, the caller sends ONE summary push built by
// {@link askFloodMessage}, and nothing more for that host for the hour.

import type { PushMessage } from "../push.ts";
import { pushTitle } from "../push-titles.ts";
import type { AgentStatus, Ask } from "../types.ts";
import type { AskGuardStore, GuardPane } from "./guard.ts";
import { keyableAsks } from "./parse.ts";

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
   * Run the guard over one host's panes, as seen now, and call `raise` once for each pane with at
   * least one `push` verdict. Panes without an `asks` field are not the guard's. `flood` is called
   * once, on the observation that trips the host's hourly breaker.
   */
  observe<P extends AskPushPane>(host: string, panes: readonly P[], raise: (pane: P) => void, flood?: () => void): void {
    const carrying: { pane: P; guarded: GuardPane }[] = [];
    for (const pane of panes) {
      if (!Array.isArray(pane.asks)) continue;
      carrying.push({ pane, guarded: { paneId: pane.paneId, asks: keyableAsks(pane.asks) } });
    }
    const observed = this.guard.observe(host, carrying.map((entry) => entry.guarded), this.now());
    for (const { pane } of carrying) {
      if ((observed.verdicts.get(pane.paneId) ?? []).some((verdict) => verdict.decision === "push")) raise(pane);
    }
    if (observed.flood) flood?.();
  }

  /** A host left the crew: what it had open closes now (`bridge/crew/notify.ts`, `forget`). */
  forget(host: string): void {
    this.guard.forgetHost(host, this.now());
  }
}

/** The notification slot of a host's flood summary: its own, so it never replaces the herd summary. */
export function askFloodTag(host: string): string {
  return host === LOCAL_ASK_HOST ? "collie:asks" : `collie:asks:${host}`;
}

/**
 * The one summary push a host gets when its ask breaker trips. `hostName` is what the operator calls
 * the machine (the member id on a lead, this machine's name for its own panes). It names the host and
 * nothing a program wrote.
 */
export function askFloodMessage(host: string, hostName: string): PushMessage {
  const msg: PushMessage = { ...pushTitle("ask.flood", { host: hostName }), body: "", tag: askFloodTag(host), renotify: true };
  if (host !== LOCAL_ASK_HOST) msg.host = host;
  return msg;
}
