// The host dimension, as data. lib/scope.ts owns ADDRESSING (what goes in the URL and on the wire);
// this module owns everything derived from the snapshot's `servers` array: is this even a pack, who
// leads it, what is a host called, and how do you key something per host.
//
// **The whole module answers "no pack" for a solo snapshot.** `servers` is optional-and-absent
// (PACK_PROTOCOL.md §11), so `isMultiHost(undefined)` is false, `hostKey({})` is `""`, and every
// host-qualified key degrades to a pure prefix of what shipped. That is what lets a solo install
// render byte-identically without a single `if (pack)` in a component — the hide rule is data, not a
// mode flag.
//
// React-free on purpose (same reason as lib/scope.ts): the pieces that need React live in
// components/pack-provider.tsx.

import type { Scope } from "./scope";
import type { AgentView, ServerSummary } from "./types";

// NUL-joined, exactly as lib/scope.ts joins its cache keys: a member id and a workspace id are both
// opaque strings, and a separator either of them could contain would make two different pairs share
// a key.
const KEY_SEP = "\u0000";

/** The grouping-key component for a host: the member id, or `""` for "untagged" (i.e. solo). */
export function hostKey(v: { host?: string } | undefined): string {
  return v?.host ?? "";
}

/**
 * The key for anything scoped to one space on one machine. Herdr workspace ids (`w1`) are only
 * unique WITHIN one host, so two machines that both expose `w1` would otherwise merge their triage
 * dots and their last-seen times into one space row — silently, and only on a pack.
 */
export function spaceKey(host: string | undefined, workspaceId: string): string {
  return `${host ?? ""}${KEY_SEP}${workspaceId}`;
}

/** The same key, read off a pane. */
export function paneSpaceKey(pane: { host?: string; workspaceId: string }): string {
  return spaceKey(pane.host, pane.workspaceId);
}

/**
 * True when the snapshot describes more than one machine — the ONE predicate that decides whether
 * any host chrome renders at all. Absent `servers` (solo, i.e. every install today) is false; so is
 * a one-entry array, which a lead with zero live peers can legitimately report.
 */
export function isMultiHost(servers: readonly ServerSummary[] | undefined): boolean {
  return (servers?.length ?? 0) > 1;
}

/** The pack's lead — the machine the phone is actually connected to. Undefined when solo. */
export function leadHost(servers: readonly ServerSummary[] | undefined): string | undefined {
  return servers?.find((s) => s.isLead)?.id;
}

/**
 * The `ServerSummary` a host id refers to. An absent id means the lead (`?h=` absent = the lead,
 * lib/scope.ts), so this resolves it the same way the bridge does.
 */
export function serverFor(
  servers: readonly ServerSummary[] | undefined,
  host: string | undefined,
): ServerSummary | undefined {
  if (!servers) return undefined;
  return host === undefined ? servers.find((s) => s.isLead) : servers.find((s) => s.id === host);
}

/**
 * The operator-facing name for a host id. Falls back to the id itself for a host the snapshot does
 * not list — a departed member must render as itself, never be silently relabelled or dropped
 * (lib/scope.ts's `normalizeHost` refuses the same rewrite for the same reason).
 */
export function hostName(
  servers: readonly ServerSummary[] | undefined,
  host: string | undefined,
): string | undefined {
  const found = serverFor(servers, host);
  if (found) return found.name || found.id;
  return host;
}

/**
 * The host a surface addressed by the AMBIENT scope is actually writing to: the scope's host, or —
 * on a pack — the lead, which is what an absent `?h=` means. Used by the write surfaces whose
 * subject carries no host of its own (a tab, a new space): they act on the machine you are pointed
 * at, and on a pack that machine has to be named.
 */
export function ambientHost(
  servers: readonly ServerSummary[] | undefined,
  host: string | undefined,
): string | undefined {
  return host ?? leadHost(servers);
}

/**
 * The scope to OPEN a pane with: the pane's own host, never the ambient one.
 *
 * This is the milestone's unforgivable-failure guard in one function. A pane id is unique only
 * within one machine, so opening a peer's row while the URL still says "lead" would point every
 * read, every key press and every reply at the lead's identically-named pane. The lead's own id
 * normalises back to `undefined` so a lead pane keeps producing today's bare URL.
 */
export function paneScope<S extends { host?: string; session?: string }>(
  scope: S,
  pane: { host?: string } | undefined,
  servers: readonly ServerSummary[] | undefined,
): Scope {
  const host = pane?.host;
  if (host === undefined) return scope;
  return { host: host === leadHost(servers) ? undefined : host, session: scope.session };
}

/**
 * The {@link hostKey} the CURRENT scope resolves to: its `?h=`, or the lead's id when absent. This
 * is the value a pane's own `host` has to equal for the pane to be the one you are addressing.
 */
export function scopeHostKey(
  scope: { host?: string },
  servers: readonly ServerSummary[] | undefined,
): string {
  return scope.host ?? leadHost(servers) ?? "";
}

/**
 * Find a pane by id WITHIN the scope's host. `w1:p1` exists on every machine in the pack, so a
 * lookup by id alone over the merged list can return another machine's pane — and the pane view
 * would then render that pane's space, tab and cwd while typing into this one's terminal.
 *
 * Untagged panes (solo) match any scope, which is what keeps today's lookup exactly today's.
 */
export function findPane<T extends { paneId: string; host?: string }>(
  panes: readonly T[],
  paneId: string,
  scope: { host?: string },
  servers: readonly ServerSummary[] | undefined,
): T | undefined {
  const want = scopeHostKey(scope, servers);
  return panes.find((p) => p.paneId === paneId && (p.host === undefined || hostKey(p) === want));
}

/**
 * The sessions belonging to the scope's host — what the session switcher lists.
 *
 * Sessions are a PER-HOST registry, so a merged snapshot can hold two "default"s. A flat list would
 * offer the same name twice with nothing to tell them apart, and picking the wrong one would move
 * you to another machine through a control that says it changes sessions. Two dimensions, two
 * switchers, each listing only what it owns.
 */
export function sessionsOnHost<T extends { host?: string }>(
  sessions: readonly T[],
  scope: { host?: string },
  servers: readonly ServerSummary[] | undefined,
): T[] {
  const want = scopeHostKey(scope, servers);
  return sessions.filter((s) => s.host === undefined || hostKey(s) === want);
}

/** Per-host agent counts, derived from the merged snapshot (a `ServerSummary` carries none). */
export interface HostCounts {
  agents: number;
  working: number;
  blocked: number;
}

const ZERO: HostCounts = { agents: 0, working: 0, blocked: 0 };

/**
 * Count agents per host in ONE pass, keyed by {@link hostKey}. Derived from the rows on screen
 * rather than reported per host, so an unreachable member's last-good panes still count (§10.2: a
 * peer's panes never vanish) instead of the switcher claiming it holds nothing.
 */
export function hostCounts(agents: readonly AgentView[]): Map<string, HostCounts> {
  const byHost = new Map<string, HostCounts>();
  for (const a of agents) {
    const key = hostKey(a);
    const held = byHost.get(key) ?? { ...ZERO };
    held.agents += 1;
    if (a.status === "working") held.working += 1;
    if (a.status === "blocked") held.blocked += 1;
    byHost.set(key, held);
  }
  return byHost;
}

/** Counts for one server, zeroed when it holds nothing. */
export function countsFor(counts: Map<string, HostCounts>, host: string): HostCounts {
  return counts.get(host) ?? ZERO;
}
