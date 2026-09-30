// TUIOS'S CONFORMANCE FIXTURE — what lets the adapter be proved with no tuios daemon on the box.
//
// NOT a production module. `bridge/index.ts` builds `TuiosMux` over a real `TuiosClient`; this file
// builds the same adapter over a fake of the same shape (`TuiosRpc`), so the conformance engine
// (../conformance.ts) drives the whole translation layer — the session lookups, the key spelling,
// the event routing, the refusal mapping — without a socket.
//
// EVERY ANSWER BELOW IS ONE THE REAL DAEMON GAVE, probed on 2026-10-01 against a tuios daemon built
// from main (`c24cbc80`) in its own runtime, state and config directories. A fake kinder than the
// daemon proves nothing, so the unkind parts are copied on purpose:
//
//  • an unknown window answers `window_not_found` and an unknown session `session_not_found`;
//  • a styled capture pads every row to the pane's width with spaces, and carries SGR and no other
//    escape; a plain capture carries neither;
//  • a bare comma in the keys string splits it, so it sends nothing;
//  • a daemon restart keeps every window id and every session id, changes the boot id, and counts
//    every pane's `revision` from 0 again, which is what `restartMux` does;
//  • `list-agents` keeps a pane's harness and conversation id after its agent exits, and names
//    harnesses by tuios's own ids (`claude-code`).

import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { TuiosMux } from "./adapter.ts";
import {
  TuiosError,
  type CaptureRequest,
  type EventStream,
  type SubscribeOptions,
  type TuiosRpc,
  type WireAgent,
  type WireCreatedSession,
  type WireCapture,
  type WireCreatedWindow,
  type WireHello,
  type WireSession,
  type WireWindowList,
  type WireWorkspace,
} from "./client.ts";

const GREEN = "\u001b[32m";
const RESET = "\u001b[m";

/** Columns every fake pane is wide. A styled capture pads each row to it, as the daemon does. */
const WIDTH = 80;

/** How many workspaces a session has — tuios's default. */
const WORKSPACES = 9;

interface FakeSession {
  id: string;
  name: string;
  attached: boolean;
  lastActive: number;
  currentWorkspace: number;
  focusedWindowId: string;
  readonly workspaceNames: Map<number, string>;
}

interface FakeWindow {
  readonly windowId: string;
  sessionId: string;
  title: string;
  customName: string;
  workspace: number;
  readonly cwd: string;
}

interface FakeAgent {
  state: string;
  readonly harnessId: string;
  readonly agentSessionId: string;
}

interface FakeScreen {
  readonly history: string[];
  readonly viewport: string[];
  /** The daemon's content revision for the pane. Counts from 0 on every daemon start. */
  revision: number;
}

interface Subscriber {
  readonly opts: SubscribeOptions;
  down: boolean;
}

function failure(verb: string, code: string, detail: string): TuiosError {
  return new TuiosError(code, `tuios ${verb}: ${code}: ${detail}`);
}

/** A tuios daemon's verb socket, in memory, answering as the real one does. */
export class FakeTuios implements TuiosRpc {
  private sessions: FakeSession[] = [];
  private windows: FakeWindow[] = [];
  private readonly agents = new Map<string, FakeAgent>();
  private readonly screens = new Map<string, FakeScreen>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly recorded: MuxWrite[] = [];
  /** Never decreases, never reused — so a new window can never land on a dead window's id. */
  private minted = 0;
  private seq = 0;
  private bootId = "b00710000000001";
  private connected = true;

  constructor() {
    this.seed();
  }

  // ── What the fixture drives ────────────────────────────────────────────────

  writes(): readonly MuxWrite[] {
    return this.recorded;
  }

  /** The connection drops and comes back. Every request opens its own connection, as in client.ts. */
  async reconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
    this.connected = true;
  }

  /**
   * The daemon restarts and restores its sessions. Windows and sessions keep their ids, every record
   * is rebuilt as a fresh object, the boot id changes, and every revision starts again from 0.
   * Every stream goes down.
   */
  async restartMux(): Promise<void> {
    this.sessions = this.sessions.map((session) => ({ ...session, workspaceNames: new Map(session.workspaceNames) }));
    this.windows = this.windows.map((window) => ({ ...window }));
    for (const screen of this.screens.values()) screen.revision = 0;
    this.minted += 1;
    this.bootId = `b0071000000000${String(this.minted)}`;
    this.seq = 0;
    for (const subscriber of this.subscribers) this.fireDown(subscriber, "connection closed");
    await Promise.resolve();
  }

  /** Someone renames a window in tuios's own UI. It raises `window-retitled`, as the daemon does. */
  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const window = this.windows.find((candidate) => candidate.windowId === paneId);
    if (window !== undefined) {
      window.customName = label;
      this.emit("window-retitled", paneId);
    }
    await Promise.resolve();
  }

  /** The shell in a pane sets its title with an OSC sequence. tuios keeps it apart from the name. */
  async setProgramTitle(paneId: string, title: string): Promise<void> {
    const window = this.windows.find((candidate) => candidate.windowId === paneId);
    if (window !== undefined) window.title = title;
    await Promise.resolve();
  }

  /** The operator moves the focus in tuios's own UI. */
  async focusOutOfBand(paneId: string): Promise<void> {
    const window = this.windows.find((candidate) => candidate.windowId === paneId);
    if (window !== undefined) this.focus(window);
    await Promise.resolve();
  }

  /** The pane prints another line. */
  async changePane(paneId: string): Promise<void> {
    const screen = this.screens.get(paneId);
    if (screen !== undefined) {
      screen.viewport.push(`● changed ${String(this.minted)}`);
      screen.revision += 1;
      this.minted += 1;
    }
    await Promise.resolve();
  }

  /** The pane's shell exits; the daemon removes the window. */
  async endPane(paneId: string): Promise<void> {
    this.removeWindow(paneId);
    await Promise.resolve();
  }

  /**
   * A workspace is renamed in tuios's own UI, and the stream says nothing. tuios main does announce
   * it (`workspace-renamed`); the knob asks for silence so that `refresh()` is what is tested.
   */
  async pokeTopologyOutOfBand(): Promise<void> {
    const session = this.sessions[0];
    if (session !== undefined) session.workspaceNames.set(1, `out-of-band-${String(this.minted)}`);
    this.minted += 1;
    await Promise.resolve();
  }

  /** Announce a structure change on the stream. */
  pokeTopology(): void {
    this.emit("window-created", this.windows[0]?.windowId ?? "");
  }

  /** Announce one pane's change on the stream. */
  pokePane(paneId: string): void {
    this.emit("agent-state", paneId);
  }

  shutdown(): void {
    for (const subscriber of this.subscribers) this.fireDown(subscriber, "closed");
    this.subscribers.clear();
  }

  // ── The verbs (TuiosRpc) ───────────────────────────────────────────────────

  async hello(): Promise<WireHello> {
    this.assertConnected("hello");
    return { protocol: 1, minProtocol: 1, version: "fake", instance: this.bootId };
  }

  async subscribeTypes(): Promise<string[]> {
    this.assertConnected("list-verbs");
    return ["window-created", "window-closed", "workspace-renamed", "agent-state", "gap"];
  }

  async listSessions(): Promise<WireSession[]> {
    this.assertConnected("list-sessions");
    return this.sessions.map((session) => ({
      name: session.name,
      id: session.id,
      attached: session.attached,
      lastActive: session.lastActive,
      currentWorkspace: session.currentWorkspace,
      windowIds: this.windowsOf(session).map((window) => window.windowId),
    }));
  }

  async listWindows(sessionName: string): Promise<WireWindowList> {
    const session = this.session("list-windows", sessionName);
    return {
      currentWorkspace: session.currentWorkspace,
      focusedWindowId: session.focusedWindowId,
      windows: this.windowsOf(session).map((window) => ({
        windowId: window.windowId,
        title: window.title,
        customName: window.customName,
        workspace: window.workspace,
        focused: window.windowId === session.focusedWindowId,
        height: 24,
        historyRows: this.screens.get(window.windowId)?.history.length ?? 0,
        cwd: window.cwd,
        host: "",
      })),
    };
  }

  async listWorkspaces(sessionName: string): Promise<WireWorkspace[]> {
    const session = this.session("list-workspaces", sessionName);
    return Array.from({ length: WORKSPACES }, (_, i) => {
      const workspace = i + 1;
      return {
        workspace,
        name: session.workspaceNames.get(workspace) ?? "",
        windowCount: this.windowsOf(session).filter((window) => window.workspace === workspace).length,
        current: workspace === session.currentWorkspace,
      };
    });
  }

  async listAgents(): Promise<WireAgent[]> {
    this.assertConnected("list-agents");
    const listed: WireAgent[] = [];
    for (const window of this.windows) {
      const agent = this.agents.get(window.windowId);
      const session = this.sessions.find((candidate) => candidate.id === window.sessionId);
      if (agent === undefined || session === undefined) continue;
      listed.push({
        session: session.name,
        windowId: window.windowId,
        state: agent.state,
        harnessId: agent.harnessId,
        agentSessionId: agent.agentSessionId,
      });
    }
    return listed;
  }

  async capturePane(sessionName: string, windowId: string, request: CaptureRequest): Promise<WireCapture> {
    this.window("capture-pane", sessionName, windowId);
    const screen = this.screens.get(windowId) ?? { history: [], viewport: [], revision: 0 };
    const all = request.source === "visible" ? screen.viewport : [...screen.history, ...screen.viewport];
    const shown = all.slice(Math.max(0, all.length - request.lines));
    const content = request.styled
      ? shown.map((line) => `${GREEN}${line}${RESET}`.padEnd(WIDTH + GREEN.length + RESET.length, " ")).join("\n")
      : shown.join("\n");
    return { content, revision: screen.revision, bootId: this.bootId };
  }

  async sendText(sessionName: string, windowId: string, text: string): Promise<void> {
    this.window("send-text", sessionName, windowId);
    this.recorded.push({ paneId: windowId, kind: "text", payload: [text] });
  }

  async sendKeys(sessionName: string, windowId: string, keys: string): Promise<void> {
    this.window("send-keys", sessionName, windowId);
    const tokens = keys.split(/[ ,]+/u).filter((token) => token !== "");
    // The daemon parses every token before sending any; a bare separator has no token at all.
    if (tokens.length === 0) throw failure("send-keys", "invalid_params", "no keys to send");
    this.recorded.push({ paneId: windowId, kind: "keys", payload: tokens });
  }

  async renameWindow(sessionName: string, windowId: string, name: string): Promise<void> {
    const window = this.window("set-window", sessionName, windowId);
    window.customName = name;
    this.emit("window-retitled", windowId);
  }

  async closeWindow(sessionName: string, windowId: string): Promise<void> {
    this.window("close-window", sessionName, windowId);
    this.removeWindow(windowId);
  }

  async focusWindow(sessionName: string, windowId: string): Promise<void> {
    this.focus(this.window("focus-window", sessionName, windowId));
  }

  async newWindow(sessionName: string, workspace: number, cwd: string | undefined): Promise<WireCreatedWindow> {
    const session = this.session("new-window", sessionName);
    const window = this.addWindow(session, workspace, cwd ?? "/tmp");
    this.emit("window-created", window.windowId);
    return { windowId: window.windowId, workspace };
  }

  async nameWorkspace(sessionName: string, workspace: number, name: string): Promise<void> {
    const session = this.session("set-workspace-name", sessionName);
    if (name === "") session.workspaceNames.delete(workspace);
    else session.workspaceNames.set(workspace, name);
  }

  async newSession(name: string | undefined, cwd: string | undefined): Promise<WireCreatedSession> {
    this.assertConnected("new-session");
    const chosen = name ?? `session-${String(this.minted)}`;
    if (this.sessions.some((session) => session.name === chosen)) {
      throw failure("new-session", "session_exists", `session ${chosen} already exists`);
    }
    const session = this.addSession(chosen);
    const window = this.addWindow(session, 1, cwd ?? "/tmp");
    session.focusedWindowId = window.windowId;
    this.emit("session-created", "");
    return { session: session.name, sessionId: session.id, windowId: window.windowId };
  }

  subscribe(opts: SubscribeOptions): EventStream {
    const subscriber: Subscriber = { opts, down: false };
    this.subscribers.add(subscriber);
    // The real daemon acks on a round trip, so `up` is never synchronous with the call.
    queueMicrotask(() => {
      if (!subscriber.down) opts.onUp({ seq: this.seq, bootId: this.bootId });
    });
    return { close: () => this.fireDown(subscriber, "closed") };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private assertConnected(verb: string): void {
    if (!this.connected) throw new Error(`tuios ${verb}: connection closed before reply`);
  }

  private session(verb: string, name: string): FakeSession {
    this.assertConnected(verb);
    const session = this.sessions.find((candidate) => candidate.name === name);
    if (session === undefined) throw failure(verb, "session_not_found", `session ${name} not found`);
    return session;
  }

  private window(verb: string, sessionName: string, windowId: string): FakeWindow {
    const session = this.session(verb, sessionName);
    const window = this.windows.find((candidate) => candidate.windowId === windowId && candidate.sessionId === session.id);
    if (window === undefined) throw failure(verb, "window_not_found", `no window found matching "${windowId}"`);
    return window;
  }

  private windowsOf(session: FakeSession): FakeWindow[] {
    return this.windows.filter((window) => window.sessionId === session.id);
  }

  private focus(window: FakeWindow): void {
    const session = this.sessions.find((candidate) => candidate.id === window.sessionId);
    if (session === undefined) return;
    session.focusedWindowId = window.windowId;
    session.currentWorkspace = window.workspace;
    this.emit("window-focused", window.windowId);
  }

  private removeWindow(windowId: string): void {
    const gone = this.windows.find((window) => window.windowId === windowId);
    this.windows = this.windows.filter((window) => window.windowId !== windowId);
    this.screens.delete(windowId);
    this.agents.delete(windowId);
    if (gone !== undefined) this.emit("window-closed", windowId);
  }

  private emit(type: string, window: string): void {
    this.seq += 1;
    for (const subscriber of this.subscribers) {
      if (!subscriber.down) subscriber.opts.onEvent({ seq: this.seq, bootId: this.bootId, type, window });
    }
  }

  private fireDown(subscriber: Subscriber, reason: string): void {
    if (subscriber.down) return;
    subscriber.down = true;
    subscriber.opts.onDown(reason);
  }

  /** A UUID-shaped id, as the daemon mints. Deterministic, and never the same twice. */
  private mintId(): string {
    this.minted += 1;
    return `00000000-0000-4000-8000-${String(this.minted).padStart(12, "0")}`;
  }

  private addSession(name: string): FakeSession {
    const session: FakeSession = {
      id: this.mintId(),
      name,
      attached: false,
      lastActive: this.minted,
      currentWorkspace: 1,
      focusedWindowId: "",
      workspaceNames: new Map(),
    };
    this.sessions.push(session);
    return session;
  }

  private addWindow(session: FakeSession, workspace: number, cwd: string): FakeWindow {
    const window: FakeWindow = {
      windowId: this.mintId(),
      sessionId: session.id,
      title: `user@host:${cwd}`,
      customName: "",
      workspace,
      cwd,
    };
    this.windows.push(window);
    this.screens.set(window.windowId, {
      history: Array.from({ length: 30 }, (_, i) => `scrollback line ${String(i)} of ${window.windowId}`),
      viewport: [`$ shell in ${cwd}`, `pane ${window.windowId} on screen`],
      revision: 0,
    });
    return window;
  }

  /**
   * Three live panes across two spaces and two tabs, one of them an agent pane blocked on an
   * approval with a conversation id — the same state the probe drove with `set-agent-state`.
   */
  private seed(): void {
    const first = this.addSession("collie");
    first.workspaceNames.set(1, "agents");
    const agentPane = this.addWindow(first, 1, "/home/dev/collie");
    agentPane.title = "✳ Writing the conformance suite";
    this.agents.set(agentPane.windowId, {
      state: "needs_input",
      harnessId: "claude-code",
      agentSessionId: "0a1b2c3d-1111-4222-8333-444455556666",
    });
    this.addWindow(first, 1, "/home/dev/collie");
    first.focusedWindowId = agentPane.windowId;

    const second = this.addSession("scratch");
    const shell = this.addWindow(second, 1, "/tmp");
    second.focusedWindowId = shell.windowId;
  }
}

/**
 * The world for one conformance run: the real {@link TuiosMux} over a {@link FakeTuios}.
 * Exported for tests that need the fake alongside the adapter.
 */
export function tuiosWorld(fake: FakeTuios): MuxConformanceWorld {
  return {
    adapter: new TuiosMux(fake),
    writes: () => fake.writes(),
    reconnect: () => fake.reconnect(),
    restartMux: () => fake.restartMux(),
    renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
    setProgramTitle: (paneId, title) => fake.setProgramTitle(paneId, title),
    focusOutOfBand: (paneId) => fake.focusOutOfBand(paneId),
    changePane: (paneId) => fake.changePane(paneId),
    endPane: (paneId) => fake.endPane(paneId),
    pokeTopologyOutOfBand: () => fake.pokeTopologyOutOfBand(),
    pokeTopology: () => fake.pokeTopology(),
    pokePane: (paneId) => fake.pokePane(paneId),
    close: () => {
      fake.shutdown();
      return Promise.resolve();
    },
  };
}

/** tuios's entry in the fixture registry (../fixtures.ts). */
export const tuiosConformanceFixture: MuxConformanceFixture = {
  mux: "tuios",
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(tuiosWorld(new FakeTuios()));
  },
};
