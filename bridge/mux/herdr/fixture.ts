// HERDR'S CONFORMANCE FIXTURE — what lets the reference adapter be proved with no Herdr on the box.
//
// NOT a production module and not imported by one. `bridge/index.ts` builds `HerdrMux` over a real
// `HerdrClient`; this file builds the same adapter over a fake of the same shape (`HerdrRpc`), so the
// conformance engine (../conformance.ts) drives the WHOLE translation layer — the wire joins, the key
// spelling, the event split, the refusal mapping — without a socket.
//
// WHY A HAND-WRITTEN FAKE AND NOT `bridge/pack/fake-herdr.ts`. That one is a real unix-socket daemon,
// because its subject is the pack TRANSPORT: two Collie processes and a live connection between them.
// Conformance's subject is the adapter, and the five things it has to simulate — a reconnect, a
// multiplexer restart, an out-of-band rename, changed pane content, a pane dying — are state
// transitions, not bytes. Doing them in memory keeps the pure layer deterministic and keeps it
// runnable where a unix socket is not.
//
// WHAT IT MODELS, AND WHY EACH DETAIL IS THERE. Every answer below is Herdr's documented behaviour
// (HERDR_API.md), because a fake that is kinder than the real server proves nothing:
//   • an unknown id answers `pane_not_found` / `tab_not_found` / `workspace_not_found` — the codes the
//     adapter turns into the contract's `gone`;
//   • `pane.read` never sets `truncated` (it is always false on the real server, which is why
//     `readableLines` exists at all) and `visible` vs `recent` really do return different depths;
//   • `format:"ansi"` carries SGR and `format:"text"` carries none, so the contract's `styling`
//     request is a real branch rather than a field nobody reads;
//   • ids are the session's, so they survive a restart — that is the Herdr promise identity rule 2
//     rests on, and the fake would be lying if it minted fresh ones.

import type { AgentStatus } from "../../types.ts";
import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { HerdrMux } from "./adapter.ts";
import type {
  CreatedShell,
  EventStream,
  HerdrRpc,
  PaneRead,
  SubscribeOptions,
  WirePane,
  WireSnapshot,
  WireTab,
  WireWorkspace,
} from "./client.ts";

const IDLE: AgentStatus = "idle";

// SGR only — a colour on and a reset off. `pane.read format:"ansi"` carries exactly this much and no
// cursor sequence, which is the whole reason Collie can render the grid without an emulator.
const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";

/** One live subscriber of the fake's event stream. */
interface Subscriber {
  readonly opts: SubscribeOptions;
  down: boolean;
}

/** A pane's rendered text, split the way Herdr's two read sources split it. */
interface FakeScreen {
  /** Lines that have scrolled off the viewport — what only a `recent` read reaches. */
  history: string[];
  /** Lines on screen now — what a `visible` read returns. */
  viewport: string[];
}

/** The error a Herdr server answers with for an id it does not know. `client.ts` folds it into this. */
function notFound(method: string, code: string, id: string): Error {
  return new Error(`herdr ${method}: ${code}: ${id} not found`);
}

/**
 * A Herdr control socket, in memory, behaving as the documented one does.
 *
 * Implements {@link HerdrRpc} — the narrow shape `HerdrMux` depends on — so the adapter under test is
 * the real one, unmodified.
 */
export class FakeHerdr implements HerdrRpc {
  private workspaces: WireWorkspace[] = [];
  private tabs: WireTab[] = [];
  private panes: WirePane[] = [];
  private readonly screens = new Map<string, FakeScreen>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly recorded: MuxWrite[] = [];
  /** Never decreases, and never reused — so a fresh pane can never land on a dead pane's id. */
  private minted = 0;
  /** False while the adapter's connection is down: every RPC rejects, as a closed socket does. */
  private connected = true;

  constructor() {
    this.seed();
  }

  // ── What the fixture drives ────────────────────────────────────────────────

  writes(): readonly MuxWrite[] {
    return this.recorded;
  }

  /**
   * The connection drops and comes back.
   *
   * Invisible to a caller by construction, and that is the Herdr truth rather than a shortcut: RPC is
   * one-shot, so every call already opens its own connection (HERDR_API.md § Transport). What the
   * conformance check is really asking is whether the adapter mints ids per-connection — it must not,
   * and this proves it does not.
   */
  async reconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
    this.connected = true;
  }

  /**
   * The multiplexer process restarts with its session intact.
   *
   * Every record is REBUILT as a fresh object carrying the same ids and the same values, which is
   * what makes the identity check meaningful: an adapter caching object identity, or deriving an id
   * from anything ephemeral, fails here and nowhere else.
   */
  async restartMux(): Promise<void> {
    this.workspaces = this.workspaces.map((workspace) => ({ ...workspace }));
    this.tabs = this.tabs.map((tab) => ({ ...tab }));
    this.panes = this.panes.map((pane) => ({ ...pane }));
    for (const subscriber of this.subscribers) this.fireDown(subscriber, "connection closed");
    await Promise.resolve();
  }

  /** The operator renames a pane in Herdr's own TUI. Collie learns it on the next poll. */
  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const pane = this.panes.find((candidate) => candidate.pane_id === paneId);
    if (pane !== undefined) pane.label = label;
    await Promise.resolve();
  }

  /** The pane paints another line. What a keystroke landing would have done. */
  async changePane(paneId: string): Promise<void> {
    const pane = this.panes.find((candidate) => candidate.pane_id === paneId);
    const screen = this.screens.get(paneId);
    if (pane !== undefined && screen !== undefined) {
      screen.viewport.push(`● changed at ${String(pane.revision + 1)}`);
      pane.revision += 1;
    }
    await Promise.resolve();
  }

  /** The pane's process ends; Herdr drops it from `pane.list` and answers `pane_not_found` after. */
  async endPane(paneId: string): Promise<void> {
    this.panes = this.panes.filter((pane) => pane.pane_id !== paneId);
    this.screens.delete(paneId);
    await Promise.resolve();
  }

  /** Announce a herd-structure change on the event stream. */
  pokeTopology(): void {
    this.emit("pane_created", { pane_id: "" });
  }

  /** Announce one pane's change on the event stream. */
  pokePane(paneId: string): void {
    this.emit("pane_agent_status_changed", { pane_id: paneId });
  }

  /** Bring every stream down and forget them. Idempotent. */
  shutdown(): void {
    for (const subscriber of this.subscribers) this.fireDown(subscriber, "closed");
    this.subscribers.clear();
  }

  // ── The RPCs (HerdrRpc) ────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    return this.connected;
  }

  async sessionSnapshot(): Promise<WireSnapshot> {
    this.assertConnected("session.snapshot");
    return {
      version: "0.7.5",
      protocol: 16,
      workspaces: this.workspaces,
      tabs: this.tabs,
      panes: this.panes,
    };
  }

  async listWorkspaces(): Promise<WireWorkspace[]> {
    this.assertConnected("workspace.list");
    return this.workspaces;
  }

  async listPanes(): Promise<WirePane[]> {
    this.assertConnected("pane.list");
    return this.panes;
  }

  async listTabs(): Promise<WireTab[]> {
    this.assertConnected("tab.list");
    return this.tabs;
  }

  async readPane(paneId: string, source: string, lines: number, format = "text"): Promise<PaneRead> {
    const pane = this.pane("pane.read", paneId);
    const screen = this.screens.get(paneId) ?? { history: [], viewport: [] };
    const all = source === "visible" ? screen.viewport : [...screen.history, ...screen.viewport];
    const shown = all.slice(Math.max(0, all.length - lines));
    // SGR only, and only in `ansi` — colour and weight, never a cursor move (ADR 0008).
    const paint = (line: string) => (format === "ansi" ? `${GREEN}${line}${RESET}` : line);
    return {
      pane_id: paneId,
      text: shown.map(paint).join("\n"),
      // Herdr's own flag is ALWAYS false, even when a read demonstrably cut scrollback off. A fake
      // that set it would let an adapter gate on a signal the real server never raises.
      truncated: false,
      revision: pane.revision,
    };
  }

  async sendPaneText(paneId: string, text: string): Promise<void> {
    this.pane("pane.send_text", paneId);
    this.recorded.push({ paneId, kind: "text", payload: [text] });
  }

  async sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    this.pane("pane.send_keys", paneId);
    this.recorded.push({ paneId, kind: "keys", payload: [...keys] });
  }

  async renamePane(paneId: string, label: string | null): Promise<void> {
    const pane = this.pane("pane.rename", paneId);
    if (label === null) delete pane.label;
    else pane.label = label;
  }

  async closePane(paneId: string): Promise<void> {
    this.pane("pane.close", paneId);
    await this.endPane(paneId);
  }

  async createTab(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<CreatedShell> {
    const workspace = this.workspace("tab.create", workspaceId);
    const tab = this.newTab(workspace, opts.label ?? String(workspace.tab_count + 1));
    const pane = this.newPane(tab, opts.cwd ?? "/tmp");
    return { paneId: pane.pane_id, workspaceId: workspace.workspace_id, tabId: tab.tab_id, cwd: pane.cwd };
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    this.tab("tab.rename", tabId).label = label;
  }

  async closeTab(tabId: string): Promise<void> {
    this.tab("tab.close", tabId);
    // A tab close is a bulk pane close — live-verified against the real server.
    for (const pane of this.panes.filter((candidate) => candidate.tab_id === tabId)) {
      this.screens.delete(pane.pane_id);
    }
    this.panes = this.panes.filter((pane) => pane.tab_id !== tabId);
    this.tabs = this.tabs.filter((tab) => tab.tab_id !== tabId);
  }

  async createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell> {
    const workspace = this.newWorkspace(opts.label ?? `space ${String(this.workspaces.length + 1)}`);
    const tab = this.newTab(workspace, "1");
    const pane = this.newPane(tab, opts.cwd);
    return {
      paneId: pane.pane_id,
      workspaceId: workspace.workspace_id,
      workspaceLabel: workspace.label,
      tabId: tab.tab_id,
      cwd: pane.cwd,
    };
  }

  subscribeEvents(opts: SubscribeOptions): EventStream {
    const subscriber: Subscriber = { opts, down: false };
    this.subscribers.add(subscriber);
    // The real client acks on a round trip, so `up` is never synchronous with the call.
    queueMicrotask(() => {
      if (!subscriber.down) opts.onUp();
    });
    return { close: () => this.fireDown(subscriber, "closed") };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private assertConnected(method: string): void {
    if (!this.connected) throw new Error(`herdr ${method}: connection closed before reply`);
  }

  private pane(method: string, paneId: string): WirePane {
    this.assertConnected(method);
    const pane = this.panes.find((candidate) => candidate.pane_id === paneId);
    if (pane === undefined) throw notFound(method, "pane_not_found", paneId);
    return pane;
  }

  private tab(method: string, tabId: string): WireTab {
    this.assertConnected(method);
    const tab = this.tabs.find((candidate) => candidate.tab_id === tabId);
    if (tab === undefined) throw notFound(method, "tab_not_found", tabId);
    return tab;
  }

  private workspace(method: string, workspaceId: string): WireWorkspace {
    this.assertConnected(method);
    const workspace = this.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (workspace === undefined) throw notFound(method, "workspace_not_found", workspaceId);
    return workspace;
  }

  private emit(event: string, data: { pane_id: string }): void {
    for (const subscriber of this.subscribers) {
      if (!subscriber.down) subscriber.opts.onEvent(event, data);
    }
  }

  private fireDown(subscriber: Subscriber, reason: string): void {
    if (subscriber.down) return;
    subscriber.down = true;
    subscriber.opts.onDown(reason);
  }

  private newWorkspace(label: string): WireWorkspace {
    this.minted += 1;
    const workspace: WireWorkspace = {
      workspace_id: `w${String(this.minted)}`,
      number: this.workspaces.length + 1,
      label,
      focused: this.workspaces.length === 0,
      pane_count: 0,
      tab_count: 0,
      active_tab_id: "",
      agent_status: IDLE,
    };
    this.workspaces.push(workspace);
    return workspace;
  }

  private newTab(workspace: WireWorkspace, label: string): WireTab {
    this.minted += 1;
    const tab: WireTab = {
      tab_id: `t${String(this.minted)}`,
      workspace_id: workspace.workspace_id,
      number: workspace.tab_count + 1,
      label,
      focused: workspace.tab_count === 0,
      pane_count: 0,
      agent_status: IDLE,
    };
    workspace.tab_count += 1;
    if (workspace.active_tab_id === "") workspace.active_tab_id = tab.tab_id;
    this.tabs.push(tab);
    return tab;
  }

  private newPane(tab: WireTab, cwd: string, agent?: string): WirePane {
    this.minted += 1;
    const paneId = `${tab.workspace_id}:p${String(this.minted)}`;
    const pane: WirePane = {
      pane_id: paneId,
      terminal_id: `term${String(this.minted)}`,
      workspace_id: tab.workspace_id,
      tab_id: tab.tab_id,
      focused: false,
      cwd,
      agent_status: agent === undefined ? "unknown" : IDLE,
      revision: 1,
      scroll: { offset_from_bottom: 0, max_offset_from_bottom: 40, viewport_rows: 24 },
    };
    if (agent !== undefined) pane.agent = agent;
    this.panes.push(pane);
    tab.pane_count += 1;
    const workspace = this.workspaces.find((candidate) => candidate.workspace_id === tab.workspace_id);
    if (workspace !== undefined) workspace.pane_count += 1;
    this.screens.set(paneId, {
      history: Array.from({ length: 30 }, (_, i) => `scrollback line ${String(i)} of ${paneId}`),
      viewport: [`$ shell in ${cwd}`, `pane ${paneId} on screen`],
    });
    return pane;
  }

  /**
   * The world every conformance world starts in: three live panes across two spaces and two tabs,
   * one of them an agent pane that has named its session.
   *
   * The engine's world contract asks for exactly this, and the reason is that half the suite would
   * otherwise pass vacuously — a single bare shell proves nothing about `agentDetection`, about a
   * space join, or about an id staying unique across two spaces.
   */
  private seed(): void {
    const first = this.newWorkspace("collie");
    const firstTab = this.newTab(first, "agents");
    const agentPane = this.newPane(firstTab, "/home/dev/collie", "claude");
    agentPane.focused = true;
    agentPane.agent_session = { source: "claude", agent: "claude", kind: "id", value: "0a1b2c3d-session" };
    agentPane.terminal_title = "✳ Writing the conformance suite";
    this.newPane(firstTab, "/home/dev/collie");

    const second = this.newWorkspace("scratch");
    const secondTab = this.newTab(second, "shell");
    this.newPane(secondTab, "/tmp");
  }
}

/**
 * Herdr's entry in the fixture registry (../fixtures.ts).
 *
 * The world is the real {@link HerdrMux} over a {@link FakeHerdr} — the same adapter
 * `bridge/index.ts` builds, with only the socket replaced.
 */
export const herdrConformanceFixture: MuxConformanceFixture = {
  mux: "herdr",
  create(): Promise<MuxConformanceWorld> {
    const fake = new FakeHerdr();
    const adapter = new HerdrMux(fake);
    return Promise.resolve({
      adapter,
      writes: () => fake.writes(),
      reconnect: () => fake.reconnect(),
      restartMux: () => fake.restartMux(),
      renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
      changePane: (paneId) => fake.changePane(paneId),
      endPane: (paneId) => fake.endPane(paneId),
      pokeTopology: () => fake.pokeTopology(),
      pokePane: (paneId) => fake.pokePane(paneId),
      close: () => {
        fake.shutdown();
        return Promise.resolve();
      },
    });
  },
};
