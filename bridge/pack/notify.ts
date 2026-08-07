import {
  makeNotifySink,
  NotificationCoordinator,
  type MuteGate,
  type NotifyClock,
  type PushSender,
} from "../notifications.ts";
import type { AgentStatus, AgentView, PackMode, PaneWire } from "../types.ts";
import type { PeerSnapshotBody } from "./merge.ts";
import { packHerdTagFor } from "./tags.ts";

// Push convergence: ONE phone registration, on the lead (PACK_PROTOCOL.md §5, §10.1).
//
// ── THE SHAPE, AND WHY IT IS THIS ONE ────────────────────────────────────────
// Notifications for a peer's panes are derived ON THE LEAD, from the snapshots the lead already
// sweeps, through the SAME `NotificationCoordinator` a local session drives. Nothing new decides
// what is alert-worthy, what debouncing means, or how a herd collapses into one summary — a peer's
// alerts are the local machinery pointed at a body that arrived over HTTP.
//
// That follows from the protocol rather than from taste:
//   • §5 keeps `subscribe`, `snooze` and `notifications/prefs` OFF the pack surface — "push
//     subscriptions live on the lead; notification policy is one pack-wide setting the lead owns".
//     A peer therefore has nothing to fan a policy TO, and no phone to fan an alert to. The lead
//     being the only sender is what makes its snooze and its prefs pack-wide *by construction*
//     instead of by a fan-out that has to survive an unreachable peer.
//   • §10.1 makes the sweep part of the existing poll. This module arms no timer of its own; its
//     only entry point is {@link PeerNotifier.observe}, called from `PackLead.sweep` with a body
//     that just landed.
//
// ── ONE COORDINATOR PER HOST, NOT ONE WIDER MAP ──────────────────────────────
// `NotificationCoordinator`'s `pending`/`outstanding` key on a bare pane id; which session (and now
// which host) an alert belongs to is implicit in WHICH INSTANCE holds it. So the host dimension is
// more instances, exactly as multi-session was — the maps inside the coordinator are untouched, and
// each host gets its own notification slot (`bridge/pack/tags.ts`) so a peer's pane can never
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
 * restart would replay the whole pack's current state onto the lock screen.
 *
 * **Dedupe across sweeps falls out of this being a diff.** The lead sweeps every poll (~1.5 s) and a
 * peer that has not changed answers the same statuses, which produce zero transitions — so a pane
 * that blocks once is announced once, no matter how many sweeps see it blocked afterwards.
 *
 * **Only fresh bodies reach here.** `PackLead` calls the notifier only when a poll parsed a new
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
  /** The LEAD's snooze. Pack-wide by construction: the lead is the only thing that sends (§5). */
  readonly mute: MuteGate;
  readonly delayMs: number;
  /** The LEAD's notify prefs, read live — same reason, same construction. */
  readonly isNotifiable: (status: AgentStatus) => boolean;
}

/**
 * The lead's notification coordinators for its peers: one per host, created on that host's first
 * swept body and torn down when the host leaves the pack.
 *
 * Built only in `lead` mode. A solo instance never constructs one, so it holds no map, arms no timer
 * and adds no tag (§11).
 */
export class PeerNotifier<H = unknown> {
  private readonly hosts = new Map<
    string,
    { readonly coordinator: NotificationCoordinator<H>; statuses: ReadonlyMap<string, AgentStatus> }
  >();

  constructor(private readonly deps: PeerNotifierDeps<H>) {}

  /**
   * Feed one peer's freshly-swept body through its coordinator. Called from `PackLead.sweep`, on the
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
    for (const t of diff.transitions) {
      // `PaneWire` is `AgentView` minus the server-only session ref, so it is exactly what the
      // coordinator reads (agent, workspaceLabel, cwd, paneId) — no re-hydration, no second shape.
      entry.coordinator.onTransition(t.pane as AgentView, t.from, t.to);
    }
    for (const id of diff.removed) entry.coordinator.onRemove(id);
  }

  /**
   * A member left the pack (`leave`, revocation, rotation): retract everything outstanding for it and
   * forget it. `SessionRegistry.dispose()`'s `notifications.clearAll()` is the precedent — an alert
   * whose machine is no longer in the pack has nothing behind it and must not sit on the lock screen
   * waiting for a resolution that can never arrive.
   */
  forget(host: string): void {
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
    return [...this.hosts.keys()].map((host) => packHerdTagFor(host, true, ""));
  }

  private create(host: string): { coordinator: NotificationCoordinator<H>; statuses: ReadonlyMap<string, AgentStatus> } {
    // A peer's sweep reads its `/pack/v1/snapshot` with no `?session=`, i.e. its PRIMARY session
    // (§5's "absent → primary"), and a merged pane carries no session of its own — so a host has
    // exactly one slot today. When per-session sweeping lands, this is where the key grows.
    const sink = makeNotifySink(this.deps.push, this.deps.mute, packHerdTagFor(host, true, ""), { host });
    const entry = {
      coordinator: new NotificationCoordinator<H>(
        this.deps.clock,
        sink,
        this.deps.delayMs,
        this.deps.isNotifiable,
      ),
      statuses: new Map<string, AgentStatus>(),
    };
    this.hosts.set(host, entry);
    return entry;
  }
}

/**
 * The mute gate a collie's OWN sessions notify through, given its pack mode.
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
 * literally zero tax when there is no pack.
 */
export function herdPushGate(mode: PackMode, mute: MuteGate): MuteGate {
  if (mode !== "peer") return mute;
  return { isMuted: () => true };
}
