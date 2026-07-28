// Helpers for the space/tab navigator: shape the flat snapshot (agents + shell panes + tabs) into
// the per-space, per-tab tree the home space view renders.
import {
  STATUS_RANK,
  type AgentStatus,
  type AgentView,
  type TabView,
  type WorkspaceView,
} from "./types";

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

/** Agents needing attention (blocked) in a workspace — drives the space chip's alert dot. */
export function blockedCount(workspaceId: string, agents: AgentView[]): number {
  return agents.filter((a) => a.workspaceId === workspaceId && a.status === "blocked").length;
}

/**
 * The most-urgent agent status in a workspace (blocked > working > … > done), or null if the space
 * has no agents at all (only shells, or empty). Drives the status dot beside each space row.
 */
export function worstSpaceStatus(workspaceId: string, agents: AgentView[]): AgentStatus | null {
  const inWs = agents.filter((a) => a.workspaceId === workspaceId);
  if (inWs.length === 0) return null;
  return inWs.reduce<AgentStatus>(
    (worst, a) => (STATUS_RANK[a.status] < STATUS_RANK[worst] ? a.status : worst),
    inWs[0]!.status,
  );
}

/**
 * When you last used a space = the most recent `lastSeenAt` across its panes (agents AND shells).
 * 0 for a space you've never opened, or on a bridge that doesn't report the timestamps.
 */
export function spaceLastSeen(workspaceId: string, panes: readonly AgentView[]): number {
  let latest = 0;
  for (const p of panes) {
    if (p.workspaceId !== workspaceId) continue;
    if ((p.lastSeenAt ?? 0) > latest) latest = p.lastSeenAt ?? 0;
  }
  return latest;
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
