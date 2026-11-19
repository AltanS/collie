import type { AgentStatus, AgentView, ServerSummary, SnapshotResponse, TabView, WorkspaceView } from "@/lib/types";
import { fixtureCrewSessions, fixtureServers, fixtureSnapshot } from "@/test/handlers";

// A HERD FOR THE LARGE-SCREEN DASHBOARD (ADR 0158): `spaces` Spaces of two or three sessions each, with a
// choice of which sessions wait on the person. The shape is the bridge's own: a workspace, one tab, a pane
// per session, a bare shell in every third Space. `crew` splits the Spaces over two machines.

export interface WideHerdOptions {
  /** How many Spaces. */
  spaces: number;
  /** Pane ids (`w3:p1`) that need the person: blocked, with a question on the card. */
  blocked?: readonly string[];
  /** Pane ids that finished and nobody opened: done, moved after the person last looked. */
  unseen?: readonly string[];
  /** Two machines, the first half of the Spaces on the lead. */
  crew?: boolean;
}

const NOW = 1_700_000_000_000;
const MIN = 60_000;

export function wideSnapshot({ spaces, blocked = [], unseen = [], crew = false }: WideHerdOptions): SnapshotResponse {
  const agents: AgentView[] = [];
  const shellPanes: AgentView[] = [];
  const workspaces: WorkspaceView[] = [];
  const tabs: TabView[] = [];
  for (let i = 1; i <= spaces; i += 1) {
    const ws = `w${i}`;
    const host = crew ? (i <= Math.ceil(spaces / 2) ? "lodge" : "workshop") : undefined;
    const label = `space-${String(i).padStart(2, "0")}`;
    const seats = i % 3 === 0 ? 3 : 2;
    const space: WorkspaceView = { workspaceId: ws, number: i, label, focused: i === 1, activeTabId: `${ws}:t1`, tabCount: 1, paneCount: seats };
    const tab: TabView = { tabId: `${ws}:t1`, workspaceId: ws, number: 1, label: "main", focused: i === 1, paneCount: seats };
    if (host !== undefined) {
      space.host = host;
      tab.host = host;
    }
    workspaces.push(space);
    tabs.push(tab);
    for (let p = 1; p <= seats; p += 1) {
      const id = `${ws}:p${p}`;
      const isShell = p === 3;
      const status: AgentStatus = isShell ? "unknown" : blocked.includes(id) ? "blocked" : unseen.includes(id) ? "done" : p === 1 ? "working" : "idle";
      const pane: AgentView = {
        paneId: id,
        workspaceId: ws,
        workspaceLabel: label,
        workspaceNumber: i,
        tabId: `${ws}:t1`,
        tabLabel: "main",
        agent: isShell ? "shell" : p === 1 ? "claude" : "codex",
        status,
        cwd: `/home/you/${label}`,
        focused: false,
        lastActiveAt: NOW - 5 * MIN,
        lastSeenAt: status === "done" ? NOW - 60 * MIN : NOW - MIN,
      };
      if (host !== undefined) pane.host = host;
      if (status === "blocked") pane.hint = `waiting on you in ${label}: approve the next step`;
      if (isShell) {
        shellPanes.push({ ...pane, kind: "shell", paneLabel: "shell" });
        continue;
      }
      pane.terminalTitle = `work in ${label}`;
      agents.push(pane);
    }
  }
  const snapshot: SnapshotResponse = { ...fixtureSnapshot, agents, shellPanes, workspaces, tabs, sessions: crew ? fixtureCrewSessions : fixtureSnapshot.sessions, ts: NOW };
  if (crew) snapshot.servers = fixtureServers.slice(0, 2).map((s): ServerSummary => Object.assign({}, s, { lastSeenAt: NOW }));
  return snapshot;
}
