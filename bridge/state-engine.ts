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

// How many recent lines to read per claude pane when sniffing its `/rename` session name. Claude's
// input box (and the named rule above it) sits at the very tail, so a small window is plenty and
// keeps the extra per-poll reads cheap.
const SESSION_NAME_READ_LINES = 40;

// Claude renders its input box as a horizontal rule, the ❯ prompt line, then a closing rule. After
// `/rename <name>` the TOP rule carries the session name inside it: "────────── my-name ──". This
// matches that named rule. `\S` also matches box-drawing chars, but a *plain* rule has no embedded
// space-delimited text, so it can't match — and the ❯-prompt anchor (below) rules out any decorative
// rule elsewhere in the output. Rule chars: ─ (U+2500, light) and ━ (U+2501, heavy).
const NAMED_RULE = /^[─━]{2,}[ \t]+(\S.*?\S|\S)[ \t]+[─━]+[ \t]*$/;
// Claude's input prompt marker, anchored at column 0. Its menu/selection cursors render as " ❯"
// (leading space), so the column-0 anchor discriminates the real input prompt from a selected row.
const PROMPT_LINE = /^❯/;

/**
 * Pull Claude's own session name (set via `/rename`) out of a pane's recent text, or `undefined` when
 * the session is unnamed (a plain rule) or the pane isn't showing its input box (a dialog, a working
 * spinner). Claude draws the name INTO the horizontal rule directly above the ❯ prompt, e.g.
 * `────────── my-name ──`; we accept that rule ONLY when the very next line is the ❯ prompt, so a
 * decorative rule anywhere else in the output can never be mistaken for it (no false positives).
 * Derived from Claude's UI grammar — claude-only; other harnesses never call this. Pure + exported so
 * it's unit-tested against the pane fixtures without standing up the socket client.
 */
export function extractClaudeSessionName(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  // Only the BOTTOMMOST ❯ counts — that's the live input prompt; anything above it is scrollback.
  // The rule directly above it decides, and a plain rule means "unnamed", full stop. Scanning past it
  // for older named-rule-above-❯ pairs (as this once did) let a scrollback line that merely starts
  // with ❯ — an echoed shell prompt, pasted text — sit under a decorative rule and pin a bogus name
  // on an unnamed session (the caller's sticky cache only overwrites on truthy matches).
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!PROMPT_LINE.test(lines[i]!)) continue;
    const m = NAMED_RULE.exec(lines[i - 1]!);
    return m ? m[1]!.trim() || undefined : undefined;
  }
  return undefined;
}

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
  // Last-known claude `/rename` session name per pane. Kept sticky so the name doesn't flicker away
  // when a pane momentarily hides its input box (a dialog / working spinner) — only cleared when the
  // pane itself vanishes (see the removal loop). Enriched from pane text each poll (see enrichSessionNames).
  private readonly sessionNames = new Map<string, string>();
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
          // A user-set pane label (herdr pane.rename); omitted when unset so "absent stays absent".
          ...(typeof p.label === "string" && p.label.length > 0 ? { paneLabel: p.label } : {}),
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
        this.sessionNames.delete(id); // drop the cached name so a reused pane id starts clean
        for (const fn of this.removeListeners) fn(id);
      }

      // Enrich claude panes with their own `/rename` session name (read from pane text). Best-effort:
      // a failed read keeps the last-known name and never fails the poll.
      await this.enrichSessionNames(agents);

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

  /**
   * Read each claude pane's recent text and attach its `/rename` session name (see
   * {@link extractClaudeSessionName}) to the view, exactly parallel to `paneLabel`. The name lives
   * only in the pane's rendered text — Herdr's pane metadata doesn't carry it — so this is the one
   * place all panes can pick it up (the web app only holds text for the open pane). Reads run in
   * parallel and are individually best-effort: a read that fails or times out keeps the last-known
   * name (sticky cache) and never fails the poll. Claude-only; other harnesses never set it. A
   * herdr client without `readPane` (the unit-test fake) short-circuits, so it's a no-op there.
   */
  private async enrichSessionNames(agents: AgentView[]): Promise<void> {
    if (typeof this.herdr.readPane !== "function") return;
    const claude = agents.filter((a) => a.agent === "claude");
    if (claude.length === 0) return;
    await Promise.all(
      claude.map(async (a) => {
        try {
          const read = await this.herdr.readPane(a.paneId, "recent", SESSION_NAME_READ_LINES, "text");
          const name = extractClaudeSessionName(read.text);
          if (name) this.sessionNames.set(a.paneId, name);
        } catch {
          // Keep whatever's cached (if anything) — a transient read failure must not blank the name.
        }
      }),
    );
    for (const a of agents) {
      const name = this.sessionNames.get(a.paneId);
      if (name) a.sessionName = name;
    }
  }
}
