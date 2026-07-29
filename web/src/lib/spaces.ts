// Helpers for the space/tab navigator: shape the flat snapshot (agents + shell panes + tabs) into
// the per-space, per-tab tree the home space view renders.
import { bucketOf, TRIAGE_ORDER, type TriageKey } from "./triage";
import type { AgentView, TabView, WorkspaceView } from "./types";

export interface TabGroup {
  tabId: string;
  label: string;
  panes: AgentView[];
}

/**
 * Group a workspace's panes (agents + shells) by tab, in tab order. Panes whose tab isn't in the
 * tab list yet (a brief poll race after a create) fall into a trailing group so they're never lost.
 */
export function groupPanesByTab(
  workspaceId: string,
  tabs: TabView[],
  agents: AgentView[],
  shellPanes: AgentView[],
): TabGroup[] {
  const panes = [...agents, ...shellPanes].filter((p) => p.workspaceId === workspaceId);
  const wsTabs = tabs.filter((t) => t.workspaceId === workspaceId);

  const groups: TabGroup[] = wsTabs.map((t) => ({
    tabId: t.tabId,
    label: t.label,
    panes: panes.filter((p) => p.tabId === t.tabId),
  }));

  const known = new Set(wsTabs.map((t) => t.tabId));
  const orphans = panes.filter((p) => !known.has(p.tabId));
  if (orphans.length) groups.push({ tabId: `${workspaceId}:other`, label: "…", panes: orphans });

  return groups;
}

/**
 * The most urgent bucket in each workspace, in ONE pass over the agents.
 *
 * Routes through {@link bucketOf}, the same classifier the herd list and the tab/space chips use —
 * this replaces a pair of helpers that ranked by STATUS_RANK instead, so a space row and its chip
 * could disagree about what a colour meant (a space holding one `working` agent and one unseen
 * `done` one showed "working" on the dashboard and "ready" on the chip). One classifier, one answer.
 *
 * A missing entry means the space holds no agent at all, which is deliberately NOT the same as
 * idle: an empty space has nothing to report, and a resting dot would claim otherwise.
 *
 * One pass rather than per-space filtering because the dashboard re-renders on every poll and used
 * to derive this per space AND again per row — spaces x agents, three times over (45 x 59 on a real
 * herd).
 */
export function spaceTriageMap(agents: readonly AgentView[]): Map<string, TriageKey> {
  const worst = new Map<string, TriageKey>();
  for (const a of agents) {
    const bucket = bucketOf(a);
    const held = worst.get(a.workspaceId);
    if (held === undefined || TRIAGE_ORDER.indexOf(bucket) < TRIAGE_ORDER.indexOf(held)) {
      worst.set(a.workspaceId, bucket);
    }
  }
  return worst;
}

/**
 * Last-used time for EVERY space in one pass over the panes. The dashboard needs this per space and
 * again per rendered row, and it re-renders on every poll; deriving it per space would be
 * spaces × panes each time (45 × 59 on a real herd, three times over). One pass, then map lookups.
 */
export function spaceLastSeenMap(panes: readonly AgentView[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const p of panes) {
    const at = p.lastSeenAt ?? 0;
    if (at > (seen.get(p.workspaceId) ?? 0)) seen.set(p.workspaceId, at);
  }
  return seen;
}

/**
 * Most-recently-used spaces first. Never-used spaces (and every space on an older bridge) tie at 0
 * and therefore keep Herdr's own workspace order behind the ones you actually touch — `sort` is
 * stable, so no timestamps means no reordering at all.
 *
 * Pass a prebuilt {@link spaceLastSeenMap} when the caller already has one.
 */
export function sortSpacesByRecency(
  workspaces: readonly WorkspaceView[],
  panes: readonly AgentView[],
  seen: Map<string, number> = spaceLastSeenMap(panes),
): WorkspaceView[] {
  return [...workspaces].sort(
    (a, b) => (seen.get(b.workspaceId) ?? 0) - (seen.get(a.workspaceId) ?? 0),
  );
}

/**
 * Case-insensitive substring match on the space label. An empty/whitespace query returns the input
 * untouched, so the filter box costs nothing until you type in it.
 */
export function filterSpaces(
  workspaces: readonly WorkspaceView[],
  query: string,
): WorkspaceView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...workspaces];
  return workspaces.filter((w) => w.label.toLowerCase().includes(q));
}
