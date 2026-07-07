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

type TransitionListener = (agent: AgentView, from: AgentStatus, to: AgentStatus) => void;
type RemoveListener = (paneId: string) => void;
type UpdateListener = (snap: EngineSnapshot) => void;

export class StateEngine {
  private agents: AgentView[] = [];
  private shellPanes: AgentView[] = [];
  private workspaces: WorkspaceView[] = [];
  private tabs: TabView[] = [];
  private bridge: BridgeStatus = "disconnected";
  private readonly prevStatus = new Map<string, AgentStatus>();
  private readonly transitionListeners = new Set<TransitionListener>();
  private readonly removeListeners = new Set<RemoveListener>();
  private readonly updateListeners = new Set<UpdateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private polling = false;
  // One follow-up poll queued when pokeNow lands mid-poll: an event may describe state the
  // in-flight poll already read past, so we must re-poll once it settles.
  private queuedPoll = false;
  // Current interval cadence; setCadence swaps it (relaxed while the event stream is healthy).
  private cadenceMs: number;
  // session.snapshot is the fast path; flipped off PERMANENTLY once a server proves it predates the
  // method (see poll()), after which every tick uses the legacy three-call path.
  private supportsSnapshot = true;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly pollMs: number,
  ) {
    this.cadenceMs = pollMs;
  }

  onTransition(fn: TransitionListener): () => void {
    this.transitionListeners.add(fn);
    return () => this.transitionListeners.delete(fn);
  }

  /** Fires when a previously-seen agent pane vanishes (closed/exited) — used to retract its push. */
  onRemove(fn: RemoveListener): () => void {
    this.removeListeners.add(fn);
    return () => this.removeListeners.delete(fn);
  }

  /** Fires after every successful poll (post-transition bookkeeping) with the fresh snapshot. */
  onUpdate(fn: UpdateListener): () => void {
    this.updateListeners.add(fn);
    return () => this.updateListeners.delete(fn);
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
    if (this.started) return;
    this.started = true;
    this.cadenceMs = this.pollMs;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.cadenceMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Poll right now (event-poked). If a poll is already in flight, queue exactly one follow-up to run
   * when it finishes — the event that poked us may describe state that poll already read past.
   * No-op once stopped.
   */
  pokeNow(): void {
    if (!this.started) return;
    if (this.polling) {
      this.queuedPoll = true;
      return;
    }
    void this.poll();
  }

  /** Re-arm the interval at a new cadence (relaxed while events are healthy). No-op if unchanged or stopped. */
  setCadence(ms: number): void {
    if (!this.started || ms === this.cadenceMs) return;
    this.cadenceMs = ms;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), ms);
  }

  /**
   * Fetch the herd, preferring the single `session.snapshot` round-trip. Only an "unknown variant"
   * error (the server predates the method) trips a PERMANENT fallback — and we fall through to the
   * legacy three list calls in the SAME tick so there's no missed poll. Any other failure (timeout,
   * closed socket) is transient: it propagates so the tick fails as before, snapshot mode intact.
   */
  private async fetchWire() {
    if (this.supportsSnapshot) {
      try {
        const snap = await this.herdr.sessionSnapshot();
        return { workspaces: snap.workspaces, panes: snap.panes, tabs: snap.tabs };
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("unknown variant"))) throw err;
        this.supportsSnapshot = false;
        console.log("[state] herdr predates session.snapshot — using list-call polling");
      }
    }
    const [workspaces, panes, tabs] = await Promise.all([
      this.herdr.listWorkspaces(),
      this.herdr.listPanes(),
      this.herdr.listTabs(),
    ]);
    return { workspaces, panes, tabs };
  }

  private async poll(): Promise<void> {
    // Skip the tick if the previous poll is still running — against a slow Herdr, back-to-back
    // ticks would otherwise stack overlapping in-flight polls.
    if (this.polling) return;
    this.polling = true;
    try {
      const { workspaces, panes, tabs } = await this.fetchWire();
      const wsById = new Map(workspaces.map((w) => [w.workspace_id, w]));

      const toView = (
        p: (typeof panes)[number],
        agent: string,
        kind: "agent" | "shell",
      ): AgentView => {
        const ws = wsById.get(p.workspace_id);
        return {
          paneId: p.pane_id,
          workspaceId: p.workspace_id,
          workspaceLabel: ws?.label ?? p.workspace_id,
          workspaceNumber: ws?.number ?? 0,
          tabId: p.tab_id,
          agent,
          status: p.agent_status,
          cwd: p.cwd,
          focused: p.focused,
          kind,
        };
      };

      // Narrowing predicate so the agent name is `string` (not `string | null | undefined`) at the
      // map site below — no cast needed.
      const hasAgent = (p: (typeof panes)[number]): p is (typeof panes)[number] & { agent: string } =>
        typeof p.agent === "string" && p.agent.length > 0;

      const agents: AgentView[] = panes
        .filter(hasAgent)
        .map((p) => toView(p, p.agent, "agent"))
        .sort(
          (a, b) =>
            STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
            a.workspaceNumber - b.workspaceNumber ||
            a.paneId.localeCompare(b.paneId),
        );

      // Bare shell panes (no agent), ordered by space then pane so a space's panes read top-down.
      const shellPanes: AgentView[] = panes
        .filter((p) => !p.agent)
        .map((p) => toView(p, "shell", "shell"))
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
        if (live.has(id)) continue;
        this.prevStatus.delete(id);
        for (const fn of this.removeListeners) fn(id);
      }

      this.agents = agents;
      this.shellPanes = shellPanes;
      this.workspaces = workspaceViews;
      this.tabs = tabViews;
      this.bridge = "connected";

      // After all transition/removal bookkeeping so listeners see a consistent, current snapshot.
      const snap = this.current();
      for (const fn of this.updateListeners) fn(snap);
    } catch (err) {
      if (this.bridge === "connected") {
        console.warn(`[state] poll failed, marking disconnected: ${(err as Error).message}`);
      }
      this.bridge = "disconnected";
    } finally {
      this.polling = false;
      // Run the single follow-up an event-poke asked for while this poll was in flight.
      if (this.queuedPoll) {
        this.queuedPoll = false;
        if (this.started) void this.poll();
      }
    }
  }
}
