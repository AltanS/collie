import {
  makeNotifySink,
  NotificationCoordinator,
  type MuteGate,
  type NotifyClock,
  type PushSender,
} from "../notifications.ts";
import { askFloodMessage, AskPush } from "../durable/ask-push.ts";
import { DEFAULT_GUARD_SESSION } from "../durable/guard.ts";
import type { AgentStatus, AgentView, CrewMode, PaneWire } from "../types.ts";
import type { PeerSnapshotBody } from "./merge.ts";
import { crewHerdTagFor } from "./tags.ts";

// Push convergence: ONE phone registration, on the lead (CREW_PROTOCOL.md §5, §10.1).
//
// ── THE SHAPE, AND WHY IT IS THIS ONE ────────────────────────────────────────
// Notifications for a peer's panes are derived ON THE LEAD, from the snapshots the lead already
// sweeps, through the SAME `NotificationCoordinator` a local session drives. Nothing new decides
// what is alert-worthy, what debouncing means, or how a herd collapses into one summary — a peer's
// alerts are the local machinery pointed at a body that arrived over HTTP.
//
// That follows from the protocol rather than from taste:
//   • §5 keeps `subscribe`, `snooze` and `notifications/prefs` OFF the crew surface — "push
//     subscriptions live on the lead; notification policy is one crew-wide setting the lead owns".
//     A peer therefore has nothing to fan a policy TO, and no phone to fan an alert to. The lead
//     being the only sender is what makes its snooze and its prefs crew-wide *by construction*
//     instead of by a fan-out that has to survive an unreachable peer.
//   • §10.1 makes the sweep part of the existing poll. This module arms no timer of its own; its
//     only entry point is {@link PeerNotifier.observe}, called from `CrewLead.sweep` with a body
//     that just landed.
//
// ── ONE COORDINATOR PER HOST, NOT ONE WIDER MAP ──────────────────────────────
// `NotificationCoordinator`'s `pending`/`outstanding` key on a bare pane id; which session (and now
// which host) an alert belongs to is implicit in WHICH INSTANCE holds it. So the host dimension is
// more instances, exactly as multi-session was — the maps inside the coordinator are untouched, and
// each host gets its own notification slot (`bridge/crew/tags.ts`) so a peer's pane can never
// overwrite a local pane's summary.
//
// ── AND WHAT A PEER DOES WITH ITS OWN PUSH ───────────────────────────────────
// See {@link herdPushGate}: in peer mode the herd path is MUTED, not deleted.

/** What changed on one peer between two swept bodies. Pure data — the fold below owns it. */
export interface PeerAgentDiff {
  /** The status of every agent pane in the fresh body: the next call's `prev`. */
  readonly statuses: Map<string, AgentStatus>;
  /** Panes whose status moved. First sightings are deliberately absent — see {@link diffPeerAgents}. */
  readonly transitions: readonly { readonly pane: PaneWire; readonly from: AgentStatus; readonly to: AgentStatus }[];
  /** Previously-seen panes missing from the fresh body — closed or exited. */
  readonly removed: readonly string[];
}

/**
 * Derive transitions + removals for one peer by comparing a fresh body against the last one.
 *
 * **`bridge/state-engine.ts`'s poll loop, verbatim, over a body that arrived by HTTP** — including
 * the rule that a *first sighting never fires a transition*. Without that, enrolling a peer whose
 * agent has been blocked for an hour would buzz the phone about an hour-old block, and every lead
 * restart would replay the whole crew's current state onto the lock screen.
 *
 * **Dedupe across sweeps falls out of this being a diff.** The lead sweeps every poll (~1.5 s) and a
 * peer that has not changed answers the same statuses, which produce zero transitions — so a pane
 * that blocks once is announced once, no matter how many sweeps see it blocked afterwards.
 *
 * **Only fresh bodies reach here.** `CrewLead` calls the notifier only when a poll parsed a new
 * body; an unreachable or incompatible peer keeps its last-good body (§10.2) and produces no diff, so
 * a peer going down never retracts its alerts and never re-raises them when it comes back.
 */
export function diffPeerAgents(
  prev: ReadonlyMap<string, AgentStatus>,
  agents: readonly PaneWire[],
): PeerAgentDiff {
  const statuses = new Map<string, AgentStatus>();
  const transitions: { pane: PaneWire; from: AgentStatus; to: AgentStatus }[] = [];
  for (const pane of agents) {
    const before = prev.get(pane.paneId);
    if (before !== undefined && before !== pane.status) {
      transitions.push({ pane, from: before, to: pane.status });
    }
    statuses.set(pane.paneId, pane.status);
  }
  const removed = [...prev.keys()].filter((id) => !statuses.has(id));
  return { statuses, transitions, removed };
}

export interface PeerNotifierDeps<H> {
  readonly clock: NotifyClock<H>;
  readonly push: PushSender;
  /** The LEAD's snooze. Crew-wide by construction: the lead is the only thing that sends (§5). */
  readonly mute: MuteGate;
  readonly delayMs: number;
  /** The LEAD's notify prefs, read live — same reason, same construction. */
  readonly isNotifiable: (status: AgentStatus) => boolean;
  /**
   * The push guard for panes that carry asks as data (ADR 0100), keyed on `(member id, toolCallId)`.
   * Absent: every pane pushes on its way into `blocked`, as before.
   */
  readonly asks?: AskPush;
}

/**
 * The lead's notification coordinators for its peers: one per host, created on that host's first
 * swept body and torn down when the host leaves the crew.
 *
 * Built only in `lead` mode. A solo instance never constructs one, so it holds no map, arms no timer
 * and adds no tag (§11).
 */
/** One host's slot: its own debounce coordinator plus the statuses the last sweep left behind. */
type HostEntry<H> = {
  readonly coordinator: NotificationCoordinator<H>;
  statuses: ReadonlyMap<string, AgentStatus>;
};

export class PeerNotifier<H = unknown> {
  private readonly hosts = new Map<string, HostEntry<H>>();

  constructor(private readonly deps: PeerNotifierDeps<H>) {}

  /**
   * Feed one peer's freshly-swept body through its coordinator. Called from `CrewLead.sweep`, on the
   * lead's existing poll tick — never on a timer of this class's own.
   *
   * Every transition in one body is applied synchronously here, so simultaneous blocks on the same
   * machine share one debounce window and collapse into that host's single summary — the existing
   * "one summary, not three races" behaviour, unchanged, because it is the same coordinator doing it.
   */
  observe(host: string, body: PeerSnapshotBody): void {
    const entry = this.hosts.get(host) ?? this.create(host);
    const diff = diffPeerAgents(entry.statuses, body.agents);
    entry.statuses = diff.statuses;
    const asks = this.deps.asks;
    for (const t of diff.transitions) {
      // A pane that carries asks as data does not push on its way into `blocked`: the guard below
      // decides that, once per ask (ADR 0100). Every other transition reaches the coordinator.
      if (asks !== undefined && AskPush.holds(t.pane, t.to)) continue;
      // `PaneWire` is `AgentView` minus the server-only session fields, so it is exactly what the
      // coordinator reads (agent, workspaceLabel, cwd, paneId) — no re-hydration, no second shape.
      // SAFETY: `PaneWire` IS `AgentView` minus `agentSession` and `sessionAgent`, both server-only,
      // and the coordinator reads only agent/workspaceLabel/cwd/paneId — every one of them present
      // and typed on both.
      entry.coordinator.onTransition(t.pane as AgentView, t.from, t.to);
    }
    for (const id of diff.removed) entry.coordinator.onRemove(id);
    // The ask guard runs HERE, on the lead, because the lead is the one that pushes for a peer's
    // panes (§5); the peer's own herd path is muted and runs no guard. A guarded push goes through
    // the coordinator with the cause `ask`, so it reads "Permission needed in <pane>" and nothing of
    // the ask itself. When the host's hourly breaker trips, one summary push, then silence.
    // One observation per session the member's panes are in (M55): each program on that machine is its
    // own scope, so one program's asks never close another's. A pane with no session tag is `default`.
    if (asks === undefined) return;
    // Every session the member listed is observed, an empty one too, so a program whose last pane went
    // away closes what it had open, as one observation of the whole host used to.
    const bySession = new Map<string, PaneWire[]>([[DEFAULT_GUARD_SESSION, []], ...body.sessions.map((s): [string, PaneWire[]] => [s.name, []])]);
    for (const pane of body.agents) {
      const session = pane.session ?? DEFAULT_GUARD_SESSION;
      bySession.set(session, [...(bySession.get(session) ?? []), pane]);
    }
    for (const [session, panes] of bySession) {
      asks.observe(
        host,
        panes,
        // SAFETY: as above, `PaneWire` IS `AgentView` minus the two server-only session fields.
        (pane, text) => entry.coordinator.onTransition(pane as AgentView, pane.status, "blocked", "ask", text),
        () => {
          const named = session === DEFAULT_GUARD_SESSION ? host : `${host} (${session})`;
          if (!this.deps.mute.isMuted() && this.deps.isNotifiable("blocked")) this.deps.push.send(askFloodMessage(host, named, session));
        },
        session,
      );
    }
  }

  /**
   * A member left the crew (`leave`, revocation, rotation): retract everything outstanding for it and
   * forget it. `SessionRegistry.dispose()`'s `notifications.clearAll()` is the precedent — an alert
   * whose machine is no longer in the crew has nothing behind it and must not sit on the lock screen
   * waiting for a resolution that can never arrive.
   */
  forget(host: string): void {
    // The guard's keys for this host close now, and are forgotten a day later (ADR 0100).
    this.deps.asks?.forget(host);
    const entry = this.hosts.get(host);
    if (!entry) return;
    entry.coordinator.clearAll();
    this.hosts.delete(host);
  }

  /** Re-evaluate every peer's alerts after the lead's prefs changed — the `registry.all()` fan, for hosts. */
  applyPrefs(): void {
    for (const { coordinator } of this.hosts.values()) coordinator.applyPrefs();
  }

  /** Every peer slot currently live, for the snooze route's clear-what's-on-screen fan. */
  tags(): string[] {
    return [...this.hosts.keys()].map((host) => crewHerdTagFor(host, true, ""));
  }

  private create(host: string): HostEntry<H> {
    // A peer's sweep reads its `/crew/v1/snapshot` with no `?session=`, i.e. its PRIMARY session
    // (§5's "absent → primary"), and a merged pane carries no session of its own — so a host has
    // exactly one slot today. When per-session sweeping lands, this is where the key grows.
    const sink = makeNotifySink(this.deps.push, this.deps.mute, crewHerdTagFor(host, true, ""), { host });
    const entry = {
      coordinator: new NotificationCoordinator<H>(
        this.deps.clock,
        sink,
        this.deps.delayMs,
        this.deps.isNotifiable,
      ),
      statuses: new Map<string, AgentStatus>(),
    } satisfies HostEntry<H>;
    this.hosts.set(host, entry);
    return entry;
  }
}

/**
 * The mute gate a collie's OWN sessions notify through, given its crew mode.
 *
 * **In peer mode the herd path is muted, not deleted.** §5 puts one phone on the lead and the lead
 * derives a peer's alerts itself, so a peer that also pushed would deliver every alert twice, from
 * two origins, under two tags. Muting rather than deleting is what keeps the peer's own operator
 * from being silently dispossessed: `push-subscriptions.json` is left exactly as it was, its
 * `/api/subscribe` still works for whoever uses that machine directly, and the moment `collie leave`
 * empties the trust store the same subscriptions start alerting again — nothing to re-register.
 *
 * Update pushes are unaffected on purpose: update checking is per-machine and "the operator's
 * business on each" (§5), and they never ride the herd sink.
 *
 * Solo and lead return the passed gate **by identity** — no wrapper, no extra call — so this is
 * literally zero tax when there is no crew.
 */
export function herdPushGate(mode: CrewMode, mute: MuteGate): MuteGate {
  if (mode !== "peer") return mute;
  return { isMuted: () => true };
}
