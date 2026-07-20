// Helpers for the space/tab navigator: shape the flat snapshot (agents + shell panes + tabs) into
// the per-space, per-tab tree the home space view renders.
import { STATUS_RANK, type AgentStatus, type AgentView, type TabView } from "./types";

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
