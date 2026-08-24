import type { MuxAdapter, MuxPane } from "./mux/types.ts";
import {
  type AgentStatus,
  type AgentView,
  type BridgeStatus,
  STATUS_RANK,
  type TabView,
  type WorkspaceView,
} from "./types.ts";

// Polls the multiplexer on an interval, builds the snapshot (agents + shell panes + spaces/tabs),
// and emits transition events. Polling (vs the per-pane event subscription) keeps this resync-free:
// a failed poll just retries next tick, and reconnection needs no special handling.
//
// It talks the mux port (mux/types.ts) and no multiplexer's own vocabulary: every Herdr-shaped
// derivation this file used to do inline — the workspace join, the meaningful tab label, the
// terminal-title strip, the agent-session ownership check, the session.snapshot fallback — moved
// into the adapter, where the multiplexer that knows those facts lives (bridge/mux/herdr/adapter.ts).

// How many lines to read per claude pane when sniffing its `/rename` session name. Claude's input
// box (and the named rule above it) sits at the very tail, so a small window is plenty and keeps the
// extra per-poll reads cheap.
//
// The scope MUST stay `viewport`. A `recent` text read asking for more rows than the pane currently
// shows makes Herdr harvest the pages above the viewport, and on a full-screen agent (Claude runs on
// the alternate screen, which has no host scrollback) the only way to reach them is to drive the
// agent's own mouse-scroll interface: Herdr scrolls the pane up page by page, then restores it. The
// operator watches their terminal jump and snap back — once per poll, per idle claude pane.
// `viewport` cannot do that whatever this count is: it is the rendered screen, clamped to it. Which
// is also why this number is free to stay generous — the run below the ❯ prompt is a statusline of
// unknown height ([ADR 0004](../.adr/0004-the-statusline-run-is-bounded.md)), so headroom is worth
// more here than a smaller read. See HERDR_API.md → `pane.read`.
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
 * Pull Claude's own session name (set via `/rename`) out of a pane's visible text, or `undefined` when
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

/**
 * The name the port gives a pane holding no agent. A pane reads as a bare shell exactly when its
 * adapter says so — never by this file inspecting a process name (see MuxPane.agent).
 */
const SHELL = "shell";

/**
 * The interactive shells whose presence in a pane's foreground means "nothing is running here".
 *
 * A closed list of program names, matched on the base name only. It decides ONE thing — whether a
 * terminal title has outlived the program that printed it — and it may decide nothing else: it is
 * not an agent check, not a status, and it never reaches `agent` (mux/types.ts § MuxPane.agent,
 * which is the whole reason this list is allowed to be a guess).
 */
const INTERACTIVE_SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "fish", "sh", "dash", "nu", "pwsh"]);

/**
 * Is this pane's terminal title left over from a program that has already exited?
 *
 * A multiplexer keeps a pane's title after the program that set it is gone — live-observed on tmux, a
 * bare `bash` still advertising a finished agent's task ("✳ waiting for soak time…"). Two raw facts
 * the adapter already reports say so together: an interactive SHELL in the foreground, and a title
 * that is not that shell's own name. Neither alone means anything, and the pair is evidence rather
 * than proof — which is exactly why the answer is a rendering hint and never a deletion: the title
 * stays on the wire, and the phone shows it quietly instead of as the pane's name.
 *
 * A pane whose adapter reports no foreground command at all (Herdr) is never stale: there is nothing
 * to read the emptiness as.
 *
 * Pure + exported so the rule is unit-tested and lives in ONE place.
 */
export function terminalTitleIsStale(pane: MuxPane): boolean {
  const title = pane.terminalTitle?.trim() ?? "";
  if (title.length === 0) return false;
  const argv0 = pane.foregroundCommand?.trim().split(/\s+/)[0] ?? "";
  const command = (argv0.split("/").pop() ?? "").toLowerCase();
  if (command.length === 0 || !INTERACTIVE_SHELLS.has(command)) return false;
  // A shell that titles the pane after itself is describing the present, not the past.
  return title.toLowerCase() !== command;
}

/**
 * One pane the multiplexer reported, as the view Collie's clients read.
 *
 * Almost a rename, and that is the point: the port already carries everything a pane IS, so this
 * only re-labels the fields the wire has always used (`workspaceId`, not `spaceId` — nothing
 * phone-visible renames) and adds the two things the multiplexer cannot know. `kind` is one
 * (Collie's split of the herd into agents and bare shells); `sessionName` is the other, filled in
 * afterwards from the pane's own text (see {@link StateEngine.enrichSessionNames}).
 */
function toView(pane: MuxPane, kind: "agent" | "shell"): AgentView {
  const view: AgentView = {
    paneId: pane.paneId,
    workspaceId: pane.spaceId,
    workspaceLabel: pane.spaceLabel,
    workspaceNumber: pane.spaceNumber,
    tabId: pane.tabId,
    agent: pane.agent,
    status: pane.status,
    cwd: pane.cwd,
    focused: pane.focused,
    kind,
  };
  // Optional fields are ASSIGNED, never conditionally spread: absent stays absent, and each
  // condition below stays readable as the one rule it encodes.
  if (pane.paneLabel) view.paneLabel = pane.paneLabel;
  // Denormalised alongside workspaceLabel so no client has to join tabs[].
  if (pane.tabLabel) view.tabLabel = pane.tabLabel;
  if (pane.terminalTitle) view.terminalTitle = pane.terminalTitle;
  // The title is still on the wire; this only says the phone should read it quietly. Set only when
  // true, so every pane that was byte-identical before this field existed still is.
  if (terminalTitleIsStale(pane)) view.terminalTitleStale = true;
  // How the agent named its session — SERVER-SIDE ONLY (stripped by toPaneWire). Whether a ref is
  // meaningful is the journal adapter's call; absent simply means "no history for this pane".
  if (pane.agentSession) view.agentSession = pane.agentSession;
  if (pane.readableLines !== undefined) view.readableLines = pane.readableLines;
  // A finished sentence for the operator, composed server-side and carried through untouched. It is
  // presentation: nothing in this engine reads it, and it never reaches `agent` or `status` above.
  if (pane.hint) view.hint = pane.hint;
  return view;
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
type TickListener = () => void;

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
  private readonly tickListeners = new Set<TickListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private polling = false;
  // One follow-up poll queued when pokeNow lands mid-poll: an event may describe state the
  // in-flight poll already read past, so we must re-poll once it settles.
  private queuedPoll = false;
  // Current interval cadence; setCadence swaps it (relaxed while the event stream is healthy).
  private cadenceMs: number;
  constructor(
    private readonly mux: MuxAdapter,
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

  /**
   * Fires after every poll ATTEMPT — success or failure, no snapshot handed over.
   *
   * This is the hook the pack's peer sweep rides (PACK_PROTOCOL.md §10.1: "the peer sweep is a part
   * of the existing poll, not a second timer"), and it is deliberately not `onUpdate`: that one only
   * fires on success, so a lead whose own Herdr socket is down would freeze every peer's freshness
   * at the moment its local herd went away. A peer's reachability has nothing to do with the lead's
   * Herdr, and two machines' outages must not be able to mask each other.
   *
   * With no listener — i.e. on every solo instance — this costs one iteration of an empty Set per
   * poll and arms nothing (§11's "no second timer, no peer sweep").
   */
  onTick(fn: TickListener): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
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

  private async poll(): Promise<void> {
    // Skip the tick if the previous poll is still running — against a slow Herdr, back-to-back
    // ticks would otherwise stack overlapping in-flight polls.
    if (this.polling) return;
    this.polling = true;
    try {
      const { panes, spaces, tabs } = await this.mux.snapshot();

      const agents: AgentView[] = panes
        .filter((p) => p.agent !== SHELL)
        .map((p) => toView(p, "agent"))
        .toSorted(
          (a, b) =>
            STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
            a.workspaceNumber - b.workspaceNumber ||
            a.paneId.localeCompare(b.paneId),
        );

      // Bare shell panes (no agent), ordered by space then pane so a space's panes read top-down.
      const shellPanes: AgentView[] = panes
        .filter((p) => p.agent === SHELL)
        .map((p) => toView(p, "shell"))
        .toSorted((a, b) => a.workspaceNumber - b.workspaceNumber || a.paneId.localeCompare(b.paneId));

      const workspaceViews: WorkspaceView[] = spaces
        .map((s) => ({
          workspaceId: s.spaceId,
          number: s.number,
          label: s.label,
          focused: s.focused,
          activeTabId: s.activeTabId,
          tabCount: s.tabCount,
          paneCount: s.paneCount,
        }))
        .toSorted((a, b) => a.number - b.number);

      const tabViews: TabView[] = tabs.map((t) => ({
        tabId: t.tabId,
        workspaceId: t.spaceId,
        number: t.number,
        label: t.label,
        focused: t.focused,
        paneCount: t.paneCount,
      }));

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
      for (const id of this.prevStatus.keys()) {
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
        console.warn(`[state] poll failed, marking disconnected: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.bridge = "disconnected";
    } finally {
      this.polling = false;
      // Every poll attempt, however it went (see onTick). Listener throws are contained: a tick
      // subscriber must never be able to break the poll loop that hosts it.
      for (const fn of this.tickListeners) {
        try {
          fn();
        } catch (err) {
          console.warn(`[state] tick listener failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Run the single follow-up an event-poke asked for while this poll was in flight.
      if (this.queuedPoll) {
        this.queuedPoll = false;
        if (this.started) void this.poll();
      }
    }
  }

  /**
   * Read each claude pane's visible text and attach its `/rename` session name (see
   * {@link extractClaudeSessionName}) to the view, exactly parallel to `paneLabel`. The name lives
   * only in the pane's rendered text — Herdr's pane metadata doesn't carry it — so this is the one
   * place all panes can pick it up (the web app only holds text for the open pane). Reads run in
   * parallel and are individually best-effort: a read that fails or times out keeps the last-known
   * name (sticky cache) and never fails the poll. Claude-only; other harnesses never set it. A
   * multiplexer that cannot hand over a rendered grid declines the read, which reads here as
   * "keep whatever's cached" — exactly like a read that failed.
   */
  private async enrichSessionNames(agents: AgentView[]): Promise<void> {
    const claude = agents.filter((a) => a.agent === "claude");
    if (claude.length === 0) return;
    await Promise.all(
      claude.map(async (a) => {
        try {
          // `viewport` — never `recent`; see SESSION_NAME_READ_LINES for what a `recent` read does
          // to the operator's screen. The viewport is also strictly safer to parse: `recent` hands
          // back transcript scrollback, where Claude echoes past user messages as `❯ …` lines that
          // the prompt anchor would have to discriminate against. `strip` because this wants words:
          // colour escapes would only have to be undone before the rules below could match.
          const read = await this.mux.readGrid(a.paneId, {
            scope: "viewport",
            lines: SESSION_NAME_READ_LINES,
            styling: "strip",
          });
          if (!read.ok) return;
          const name = extractClaudeSessionName(read.value.text);
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
