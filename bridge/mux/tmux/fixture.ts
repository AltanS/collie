// TMUX'S CONFORMANCE FIXTURE — what lets the tmux adapter be proved on a box with no tmux.
//
// NOT a production module and not imported by one. `registry.ts` builds `TmuxMux` over a
// {@link SpawnTmuxExec}; this file builds the SAME adapter over a fake of the same shape, so the
// conformance engine (../conformance.ts) drives the whole translation — every argv the adapter
// composes, every `-F` format it asks for, the key table, the refusal mapping, the control-mode
// parsing — without a subprocess.
//
// THE FAKE IS ARGV-DRIVEN, AND THAT IS THE POINT. It does not stub the adapter's methods; it reads
// the command line the adapter actually built, splits it on tmux's `;` exactly as tmux does, and
// renders `-F` formats by interpreting the format string it was handed. So a field the adapter stops
// asking for stops arriving, and a format token nobody teaches this file renders empty — which is
// what the real binary does for an unknown `#{…}`.
//
// A FAKE THAT IS KINDER THAN THE REAL BINARY PROVES NOTHING, so every answer below was probed on
// tmux 3.6b (M10/04):
//   • an unknown target answers `can't find pane: %999` on stderr with exit 1 — the sentence the
//     adapter turns into the contract's `gone`;
//   • a duplicate session name answers `duplicate session: <name>` — a `refused`, not a `gone`;
//   • `capture-pane -e` carries SGR and nothing else, and without `-e` carries none, so the
//     contract's `styling` request is a real branch;
//   • `-S -N` reaches behind the viewport and a plain capture does not;
//   • pane ids are `%N` from a counter that only ever climbs, so a dead pane's id is never reused —
//     the tmux promise identity rule 4 rests on, and the fake would be lying if it recycled them.

import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { TmuxMux } from "./adapter.ts";
import type { TmuxControlClient, TmuxControlHandlers, TmuxExec, TmuxRunResult } from "./exec.ts";

// SGR only — a colour on and a reset off, which is all `capture-pane -e` emits and the whole reason
// Collie can render tmux's grid with no terminal emulator (ADR 0008).
const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";

/** The host name tmux seeds every `pane_title` with, until somebody sets one. */
const HOST = "fixture-host";

/**
 * The socket this fake server answers `#{socket_path}` with.
 *
 * Shaped like the real thing (`/tmp/tmux-<uid>/<name>`) because it is what a beacon's `scope` is
 * compared against at the join (markers.ts) — probed: `$TMUX`'s first field and `#{socket_path}` are
 * the same string.
 */
export const FAKE_TMUX_SOCKET = "/tmp/tmux-1000/fixture";

/** One session in the fake server. */
interface FakeSession {
  id: string;
  name: string;
  activity: number;
}

/** One window in the fake server. */
interface FakeWindow {
  id: string;
  sessionId: string;
  index: number;
  active: boolean;
  autoNamed: boolean;
  name: string;
}

/** One pane in the fake server, screen included. */
interface FakePane {
  id: string;
  windowId: string;
  sessionId: string;
  dead: boolean;
  active: boolean;
  height: number;
  cwd: string;
  title: string;
  /** Lines that have scrolled off — what only a `-S -N` capture reaches. */
  history: string[];
  /** Lines on screen now. */
  viewport: string[];
}

/** One live control-mode client of the fake server. */
interface FakeControlClient {
  readonly handlers: TmuxControlHandlers;
  ended: boolean;
}

/** tmux's answer for a target it does not know. Verbatim from the probe. */
function missing(kind: string, id: string): TmuxRunResult {
  return { code: 1, stdout: "", stderr: `can't find ${kind}: ${id}\n` };
}

/** A successful command that printed something (or nothing). */
function said(stdout: string): TmuxRunResult {
  return { code: 0, stdout, stderr: "" };
}

/**
 * A tmux server, in memory, behaving as the real binary does.
 *
 * Implements {@link TmuxExec} — the narrow shape `TmuxMux` depends on — so the adapter under test is
 * the real one, unmodified.
 */
export class FakeTmux implements TmuxExec {
  private sessions: FakeSession[] = [];
  private windows: FakeWindow[] = [];
  private panes: FakePane[] = [];
  private readonly buffers = new Map<string, string>();
  private readonly controls = new Set<FakeControlClient>();
  private readonly recorded: MuxWrite[] = [];
  /** Only ever climbs, so no id is ever handed to a second pane, window or session. */
  private minted = 0;
  /** False while the "connection" is down — every command fails, as a dead socket does. */
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
   * Invisible to a caller by construction, and that is the tmux truth rather than a shortcut: the
   * adapter's transport is a subprocess, so every call already opens and closes its own connection.
   * What the conformance check is really asking is whether the adapter mints ids per-connection — it
   * must not, and this proves it does not.
   */
  async reconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
    this.connected = true;
  }

  /**
   * The tmux server restarts with the same sessions.
   *
   * Every record is REBUILT as a fresh object carrying the same ids and values, which is what makes
   * the identity check meaningful: an adapter caching object identity, or deriving an id from
   * anything ephemeral, fails here and nowhere else.
   */
  async restartMux(): Promise<void> {
    this.sessions = this.sessions.map((session) => ({ ...session }));
    this.windows = this.windows.map((window) => ({ ...window }));
    this.panes = this.panes.map((pane) => ({ ...pane, history: [...pane.history], viewport: [...pane.viewport] }));
    for (const client of this.controls) this.endControl(client, "%exit");
    await Promise.resolve();
  }

  /** Someone sets a pane's title in tmux itself — `select-pane -T` from the operator's own keyboard. */
  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const pane = this.panes.find((candidate) => candidate.id === paneId);
    if (pane !== undefined) pane.title = label;
    await Promise.resolve();
  }

  /** The pane paints another line. What a keystroke landing would have done. */
  async changePane(paneId: string): Promise<void> {
    const pane = this.panes.find((candidate) => candidate.id === paneId);
    if (pane !== undefined) pane.viewport.push(`changed at ${String(pane.viewport.length)}`);
    await Promise.resolve();
  }

  /**
   * The pane's process ends and tmux forgets it.
   *
   * Removed outright rather than left `pane_dead`, because that IS tmux's default: `remain-on-exit`
   * is off unless the operator turned it on, and every write afterwards answers `can't find pane`.
   */
  async endPane(paneId: string): Promise<void> {
    this.panes = this.panes.filter((pane) => pane.id !== paneId);
    await Promise.resolve();
  }

  /** Announce a herd-structure change on the control-mode stream. */
  pokeTopology(): void {
    this.emit("%window-add @999");
  }

  /** Announce one pane's output on the control-mode stream. */
  pokePane(paneId: string): void {
    this.emit(`%output ${paneId} \\033[32mhello\\033[0m`);
  }

  /** Bring every control client down and forget them. Idempotent. */
  shutdown(): void {
    for (const client of this.controls) this.endControl(client, "closed");
    this.controls.clear();
  }

  // ── The transport (TmuxExec) ───────────────────────────────────────────────

  /**
   * One tmux invocation, split on `;` into commands exactly as tmux's own lexer does.
   *
   * The split is what makes the adapter's compound calls — the three-section listing, the
   * load-buffer/paste-buffer pair — go through the same path here that they go through in tmux.
   */
  async run(args: readonly string[], stdin?: string): Promise<TmuxRunResult> {
    await Promise.resolve();
    if (!this.connected) return { code: 1, stdout: "", stderr: "error connecting to /fake/tmux-socket\n" };
    let stdout = "";
    for (const group of splitCommands(args)) {
      const result = this.command(group, stdin);
      if (result.code !== 0) return result;
      stdout += result.stdout;
    }
    return said(stdout);
  }

  control(args: readonly string[], handlers: TmuxControlHandlers): TmuxControlClient {
    const client: FakeControlClient = { handlers, ended: false };
    // A real control client answers its attach with a `%begin`/`%end` block before anything else.
    this.controls.add(client);
    queueMicrotask(() => {
      if (!client.ended) handlers.onLine("%begin 1 1 0");
      if (!client.ended) handlers.onLine("%end 1 1 0");
      if (!client.ended) handlers.onLine(`%session-changed ${flagValue(args, "-t") ?? "$0"} fixture`);
    });
    return {
      kill: () => this.endControl(client, "closed"),
    };
  }

  // ── The commands ───────────────────────────────────────────────────────────

  private command(group: readonly string[], stdin?: string): TmuxRunResult {
    const verb = group.at(0) ?? "";
    if (verb === "list-sessions") return this.listSessions(group);
    if (verb === "list-windows") return this.listWindows(group);
    if (verb === "list-panes") return this.listPanes(group);
    if (verb === "capture-pane") return this.capturePane(group);
    if (verb === "load-buffer") return this.loadBuffer(group, stdin ?? "");
    if (verb === "paste-buffer") return this.pasteBuffer(group);
    if (verb === "send-keys") return this.sendKeys(group);
    if (verb === "select-pane") return this.selectPane(group);
    if (verb === "kill-pane") return this.killPane(group);
    if (verb === "new-window") return this.newWindow(group);
    if (verb === "rename-window") return this.renameWindow(group);
    if (verb === "kill-window") return this.killWindow(group);
    if (verb === "new-session") return this.newSession(group);
    if (verb === "display-message") return this.displayMessage(group);
    return { code: 1, stdout: "", stderr: `unknown command: ${verb}\n` };
  }

  private listSessions(group: readonly string[]): TmuxRunResult {
    const format = flagValue(group, "-F") ?? "";
    return said(this.sessions.map((session) => `${render(format, this.sessionVars(session))}\n`).join(""));
  }

  private listWindows(group: readonly string[]): TmuxRunResult {
    const format = flagValue(group, "-F") ?? "";
    return said(this.windows.map((window) => `${render(format, this.windowVars(window))}\n`).join(""));
  }

  private listPanes(group: readonly string[]): TmuxRunResult {
    const format = flagValue(group, "-F") ?? "";
    return said(this.panes.map((pane) => `${render(format, this.paneVars(pane))}\n`).join(""));
  }

  /**
   * `capture-pane -p [-e] [-S -N] -t <pane>`.
   *
   * `-e` is the only thing that puts SGR on the wire, and `-S` is the only thing that reaches behind
   * the viewport. Both are probed behaviours, and the conformance suite reads both.
   */
  private capturePane(group: readonly string[]): TmuxRunResult {
    const paneId = flagValue(group, "-t") ?? "";
    const pane = this.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return missing("pane", paneId);
    const start = flagValue(group, "-S");
    const lines = start === undefined ? pane.viewport : [...pane.history, ...pane.viewport];
    const paint = (line: string): string => (group.includes("-e") ? `${GREEN}${line}${RESET}` : line);
    return said(`${lines.map(paint).join("\n")}\n`);
  }

  private loadBuffer(group: readonly string[], stdin: string): TmuxRunResult {
    this.buffers.set(flagValue(group, "-b") ?? "", stdin);
    return said("");
  }

  private pasteBuffer(group: readonly string[]): TmuxRunResult {
    const paneId = flagValue(group, "-t") ?? "";
    const name = flagValue(group, "-b") ?? "";
    const pane = this.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return missing("pane", paneId);
    const text = this.buffers.get(name);
    if (text === undefined) return { code: 1, stdout: "", stderr: `no buffer ${name}\n` };
    if (group.includes("-d")) this.buffers.delete(name);
    this.recorded.push({ paneId, kind: "text", payload: [text] });
    return said("");
  }

  /** `send-keys -t <pane> -- <key> …` — every argument after `--` is one key, in order. */
  private sendKeys(group: readonly string[]): TmuxRunResult {
    const paneId = flagValue(group, "-t") ?? "";
    const pane = this.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return missing("pane", paneId);
    const end = group.indexOf("--");
    const keys = end < 0 ? [] : group.slice(end + 1);
    this.recorded.push({ paneId, kind: "keys", payload: keys });
    return said("");
  }

  private selectPane(group: readonly string[]): TmuxRunResult {
    const paneId = flagValue(group, "-t") ?? "";
    const pane = this.panes.find((candidate) => candidate.id === paneId);
    if (pane === undefined) return missing("pane", paneId);
    pane.title = flagValue(group, "-T") ?? "";
    return said("");
  }

  private killPane(group: readonly string[]): TmuxRunResult {
    const paneId = flagValue(group, "-t") ?? "";
    if (!this.panes.some((pane) => pane.id === paneId)) return missing("pane", paneId);
    this.panes = this.panes.filter((pane) => pane.id !== paneId);
    return said("");
  }

  private newWindow(group: readonly string[]): TmuxRunResult {
    const sessionId = flagValue(group, "-t") ?? "";
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) return missing("session", sessionId);
    const window = this.newWindowIn(session, flagValue(group, "-n") ?? "bash", flagValue(group, "-n") === undefined);
    const pane = this.newPaneIn(window, flagValue(group, "-c") ?? "/tmp");
    return said(`${render(flagValue(group, "-F") ?? "", this.paneVars(pane))}\n`);
  }

  private renameWindow(group: readonly string[]): TmuxRunResult {
    const windowId = flagValue(group, "-t") ?? "";
    const window = this.windows.find((candidate) => candidate.id === windowId);
    if (window === undefined) return missing("window", windowId);
    const end = group.indexOf("--");
    window.name = (end < 0 ? group.at(-1) : group.at(end + 1)) ?? window.name;
    window.autoNamed = false;
    return said("");
  }

  private killWindow(group: readonly string[]): TmuxRunResult {
    const windowId = flagValue(group, "-t") ?? "";
    if (!this.windows.some((window) => window.id === windowId)) return missing("window", windowId);
    this.windows = this.windows.filter((window) => window.id !== windowId);
    this.panes = this.panes.filter((pane) => pane.windowId !== windowId);
    // tmux ends a session whose last window goes away, and the fake must too, or a snapshot would
    // carry a space with nothing in it that the real binary would never report.
    this.sessions = this.sessions.filter((session) => this.windows.some((window) => window.sessionId === session.id));
    return said("");
  }

  private newSession(group: readonly string[]): TmuxRunResult {
    const name = flagValue(group, "-s");
    if (name !== undefined && this.sessions.some((session) => session.name === name)) {
      return { code: 1, stdout: "", stderr: `duplicate session: ${name}\n` };
    }
    const session = this.newSessionNamed(name ?? String(this.sessions.length));
    const window = this.newWindowIn(session, "bash", true);
    const pane = this.newPaneIn(window, flagValue(group, "-c") ?? "/tmp");
    return said(`${render(flagValue(group, "-F") ?? "", this.paneVars(pane))}\n`);
  }

  /**
   * `display-message -p -F <format>` — the server answering a format about ITSELF.
   *
   * Rendered through the same `-F` interpreter every listing uses, so a token nobody taught this file
   * comes back empty exactly as the real binary's does. `socket_path` is the one the beacon join asks
   * for (probed on tmux 3.6b: it equals `$TMUX`'s first field).
   */
  private displayMessage(group: readonly string[]): TmuxRunResult {
    if (!group.includes("-p")) return said("");
    const vars = new Map([["socket_path", FAKE_TMUX_SOCKET]]);
    return said(`${render(flagValue(group, "-F") ?? "", vars)}\n`);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private emit(line: string): void {
    for (const client of this.controls) {
      if (!client.ended) client.handlers.onLine(line);
    }
  }

  private endControl(client: FakeControlClient, reason: string): void {
    if (client.ended) return;
    client.ended = true;
    this.controls.delete(client);
    client.handlers.onExit(reason);
  }

  private sessionVars(session: FakeSession): ReadonlyMap<string, string> {
    return new Map([
      ["session_id", session.id],
      ["session_name", session.name],
      ["session_activity", String(session.activity)],
      ["session_windows", String(this.windows.filter((window) => window.sessionId === session.id).length)],
    ]);
  }

  private windowVars(window: FakeWindow): ReadonlyMap<string, string> {
    return new Map([
      ["window_id", window.id],
      ["session_id", window.sessionId],
      ["window_index", String(window.index)],
      ["window_active", window.active ? "1" : "0"],
      ["window_panes", String(this.panes.filter((pane) => pane.windowId === window.id).length)],
      ["automatic-rename", window.autoNamed ? "1" : "0"],
      ["window_name", window.name],
    ]);
  }

  private paneVars(pane: FakePane): ReadonlyMap<string, string> {
    const window = this.windows.find((candidate) => candidate.id === pane.windowId);
    const session = this.sessions.find((candidate) => candidate.id === pane.sessionId);
    return new Map([
      ["pane_id", pane.id],
      ["window_id", pane.windowId],
      ["session_id", pane.sessionId],
      ["pane_dead", pane.dead ? "1" : "0"],
      ["pane_active", pane.active ? "1" : "0"],
      ["window_active", window?.active === true ? "1" : "0"],
      ["pane_height", String(pane.height)],
      ["history_size", String(pane.history.length)],
      ["host", HOST],
      ["pane_current_path", pane.cwd],
      ["pane_title", pane.title],
      ["window_name", window?.name ?? ""],
      ["session_name", session?.name ?? ""],
    ]);
  }

  private newSessionNamed(name: string): FakeSession {
    this.minted += 1;
    const session: FakeSession = { id: `$${String(this.minted)}`, name, activity: this.minted };
    this.sessions.push(session);
    return session;
  }

  private newWindowIn(session: FakeSession, name: string, autoNamed: boolean): FakeWindow {
    this.minted += 1;
    const index = this.windows.filter((window) => window.sessionId === session.id).length;
    const window: FakeWindow = {
      id: `@${String(this.minted)}`,
      sessionId: session.id,
      index,
      active: index === 0,
      autoNamed,
      name,
    };
    this.windows.push(window);
    return window;
  }

  private newPaneIn(window: FakeWindow, cwd: string): FakePane {
    this.minted += 1;
    const id = `%${String(this.minted)}`;
    const pane: FakePane = {
      id,
      windowId: window.id,
      sessionId: window.sessionId,
      dead: false,
      active: this.panes.filter((candidate) => candidate.windowId === window.id).length === 0,
      height: 24,
      cwd,
      // tmux's default title is the host name, and the adapter has to recognise it as "no label".
      title: HOST,
      history: Array.from({ length: 30 }, (_, i) => `scrollback line ${String(i)} of ${id}`),
      viewport: [`$ shell in ${cwd}`, `pane ${id} on screen`],
    };
    this.panes.push(pane);
    return pane;
  }

  /**
   * The world every conformance world starts in: three live panes across two sessions and two
   * windows, one of them carrying an operator-set title.
   *
   * The engine's world contract asks for exactly this. A single bare shell would let half the suite
   * pass vacuously — nothing about a space join, nothing about ids staying unique across two spaces.
   */
  private seed(): void {
    const first = this.newSessionNamed("collie");
    const firstTab = this.newWindowIn(first, "agents", false);
    const labelled = this.newPaneIn(firstTab, "/home/dev/collie");
    labelled.title = "the pane the operator named";
    this.newPaneIn(firstTab, "/home/dev/collie");

    const second = this.newSessionNamed("scratch");
    const secondTab = this.newWindowIn(second, "bash", true);
    this.newPaneIn(secondTab, "/tmp");
  }
}

/** Split one invocation's argv on tmux's own command separator. */
function splitCommands(args: readonly string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  for (const arg of args) {
    if (arg === ";") {
      if (current.length > 0) groups.push(current);
      current = [];
      continue;
    }
    current.push(arg);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** The value of a flag in one command group, or undefined when it is not there. */
function flagValue(group: readonly string[], flag: string): string | undefined {
  const at = group.indexOf(flag);
  return at < 0 ? undefined : group.at(at + 1);
}

/** Render a tmux `-F` format against one record. An unknown `#{…}` renders empty, as tmux's does. */
function render(format: string, vars: ReadonlyMap<string, string>): string {
  return format.replaceAll(/#\{([^}]+)\}/gu, (_match, name: string) => vars.get(name) ?? "");
}

/**
 * tmux's entry in the fixture registry (../fixtures.ts).
 *
 * The world is the real {@link TmuxMux} over a {@link FakeTmux} — the same adapter `registry.ts`
 * builds, with only the subprocess replaced.
 */
export const tmuxConformanceFixture: MuxConformanceFixture = {
  mux: "tmux",
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(tmuxWorld(new FakeTmux()));
  },
};

/**
 * One world over a caller-supplied fake.
 *
 * Split out so the DECORATED variant (../fixtures.ts, M11/03) proves the same world through the same
 * adapter, with the beacon join added — it needs the fake in its hand to build the matcher against,
 * and a second copy of this wiring would be a second thing to keep in step.
 */
export function tmuxWorld(fake: FakeTmux): MuxConformanceWorld {
  const adapter = new TmuxMux(fake);
  return {
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
  };
}
