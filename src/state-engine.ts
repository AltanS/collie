import type { HerdrClient } from "./herdr-client.ts";
import {
  type AgentStatus,
  type AgentView,
  type BridgeStatus,
  STATUS_RANK,
  type TabView,
  type WorkspaceView,
} from "./types.ts";

// Polls Herdr on an interval, builds the snapshot (agents + shell panes + spaces/tabs), and emits
// transition events. Polling (vs the per-pane event subscription) keeps this resync-free: a failed
// poll just retries next tick, and reconnection needs no special handling. See HERDR_API.md.

export interface EngineSnapshot {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  bridge: BridgeStatus;
}

type SnapshotListener = (snap: EngineSnapshot) => void;
type TransitionListener = (agent: AgentView, from: AgentStatus, to: AgentStatus) => void;

export class StateEngine {
  private agents: AgentView[] = [];
  private shellPanes: AgentView[] = [];
  private workspaces: WorkspaceView[] = [];
  private tabs: TabView[] = [];
  private bridge: BridgeStatus = "disconnected";
  private readonly prevStatus = new Map<string, AgentStatus>();
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly transitionListeners = new Set<TransitionListener>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly pollMs: number,
  ) {}

  onSnapshot(fn: SnapshotListener): () => void {
    this.snapshotListeners.add(fn);
    return () => this.snapshotListeners.delete(fn);
  }

  onTransition(fn: TransitionListener): () => void {
    this.transitionListeners.add(fn);
    return () => this.transitionListeners.delete(fn);
  }

  current(): EngineSnapshot {
    return {
      agents: this.agents,
      shellPanes: this.shellPanes,
      workspaces: this.workspaces,
      tabs: this.tabs,
      bridge: this.bridge,
    };
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    try {
      const [workspaces, panes, tabs] = await Promise.all([
        this.herdr.listWorkspaces(),
        this.herdr.listPanes(),
        this.herdr.listTabs(),
      ]);
      const wsById = new Map(workspaces.map((w) => [w.workspace_id, w]));

      const toView = (p: (typeof panes)[number], kind: "agent" | "shell"): AgentView => {
        const ws = wsById.get(p.workspace_id);
        return {
          paneId: p.pane_id,
          workspaceId: p.workspace_id,
          workspaceLabel: ws?.label ?? p.workspace_id,
          workspaceNumber: ws?.number ?? 0,
          tabId: p.tab_id,
          agent: kind === "agent" ? (p.agent as string) : "shell",
          status: p.agent_status,
          cwd: p.cwd,
          focused: p.focused,
          kind,
        };
      };

      const agents: AgentView[] = panes
        .filter((p) => Boolean(p.agent))
        .map((p) => toView(p, "agent"))
        .sort(
          (a, b) =>
            STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
            a.workspaceNumber - b.workspaceNumber ||
            a.paneId.localeCompare(b.paneId),
        );

      // Bare shell panes (no agent), ordered by space then pane so a space's panes read top-down.
      const shellPanes: AgentView[] = panes
        .filter((p) => !p.agent)
        .map((p) => toView(p, "shell"))
        .sort((a, b) => a.workspaceNumber - b.workspaceNumber || a.paneId.localeCompare(b.paneId));

      const workspaceViews: WorkspaceView[] = workspaces
        .map((w) => ({
          workspaceId: w.workspace_id,
          number: w.number,
          label: w.label,
          focused: w.focused,
          activeTabId: w.active_tab_id,
          tabCount: w.tab_count,
          paneCount: w.pane_count,
        }))
        .sort((a, b) => a.number - b.number);

      const tabViews: TabView[] = tabs
        .map((t) => ({
          tabId: t.tab_id,
          workspaceId: t.workspace_id,
          number: t.number,
          label: t.label,
          focused: t.focused,
          paneCount: t.pane_count,
        }))
        .sort((a, b) => a.number - b.number);

      // Detect transitions against the previous poll. First sighting of a pane never fires a
      // transition (so we don't notify for agents already blocked when the bridge starts).
      for (const a of agents) {
        const prev = this.prevStatus.get(a.paneId);
        if (prev !== undefined && prev !== a.status) {
          for (const fn of this.transitionListeners) fn(a, prev, a.status);
        }
        this.prevStatus.set(a.paneId, a.status);
      }
      const live = new Set(agents.map((a) => a.paneId));
      for (const id of [...this.prevStatus.keys()]) {
        if (!live.has(id)) this.prevStatus.delete(id);
      }

      this.agents = agents;
      this.shellPanes = shellPanes;
      this.workspaces = workspaceViews;
      this.tabs = tabViews;
      this.bridge = "connected";
    } catch (err) {
      if (this.bridge === "connected") {
        console.warn(`[state] poll failed, marking disconnected: ${(err as Error).message}`);
      }
      this.bridge = "disconnected";
    }
    for (const fn of this.snapshotListeners) fn(this.current());
  }
}

/**
 * Heuristic "what is the agent asking?" extraction from a recent-scrollback read.
 * Not structured parsing (the poll model has no status-change payload) — just the last
 * meaningful lines, which is what a human glances at. The full text is shown for context.
 */
export function extractAsking(text: string, maxLines = 6): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const meaningful = lines.filter((l) => l.trim() && !/^[\s─━–—_=*.]+$/.test(l.trim()));
  return meaningful.slice(-maxLines).join("\n").trim();
}
