// TERN'S CONFORMANCE FIXTURE — proves the Tern adapter with an in-memory fake.

import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { TernMux } from "./adapter.ts";
import type { TernExec, TernRunResult, TernStreamClient, TernStreamHandlers } from "./exec.ts";
import type { TernBlock, TernLsResult, TernSession, TernTab } from "./protocol.ts";

const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";

interface FakePane {
  id: number;
  tabId: number;
  sessionId: number;
  title: string | null;
  cwd: string;
  program: string;
  args: string[];
  focused: boolean;
  live: boolean;
  history: string[];
  viewport: string[];
}

interface FakeTab {
  id: number;
  sessionId: number;
  number: number;
  name: string | null;
  shown: boolean;
  paneIds: number[];
}

interface FakeSession {
  id: number;
  name: string;
  shown: boolean;
  tabIds: number[];
}

interface FakeListener {
  handlers: TernStreamHandlers;
  ended: boolean;
}

export class FakeTern implements TernExec {
  private sessions = new Map<number, FakeSession>();
  private tabs = new Map<number, FakeTab>();
  private panes = new Map<number, FakePane>();
  private listeners = new Set<FakeListener>();
  private recorded: MuxWrite[] = [];
  private nextId = 1000;
  private connected = true;

  constructor() {
    this.seed();
  }

  private seed(): void {
    this.sessions.clear();
    this.tabs.clear();
    this.panes.clear();

    const s1: FakeSession = { id: 1, name: "Default", shown: true, tabIds: [11, 12] };
    const s2: FakeSession = { id: 2, name: "Work", shown: false, tabIds: [21] };
    this.sessions.set(s1.id, s1);
    this.sessions.set(s2.id, s2);

    const t1: FakeTab = { id: 11, sessionId: 1, number: 1, name: null, shown: true, paneIds: [101, 102] };
    const t2: FakeTab = { id: 12, sessionId: 1, number: 2, name: "docs", shown: false, paneIds: [103] };
    const t3: FakeTab = { id: 21, sessionId: 2, number: 1, name: "dev", shown: false, paneIds: [201] };
    this.tabs.set(t1.id, t1);
    this.tabs.set(t2.id, t2);
    this.tabs.set(t3.id, t3);

    const p1: FakePane = {
      id: 101,
      tabId: 11,
      sessionId: 1,
      title: "π - denis",
      cwd: "/home/denis",
      program: "/bin/zsh",
      args: ["-l"],
      focused: true,
      live: true,
      history: ["line 1", "line 2", "line 3"],
      viewport: ["screen row 1", "screen row 2"],
    };
    const p2: FakePane = {
      id: 102,
      tabId: 11,
      sessionId: 1,
      title: "bash",
      cwd: "/home/denis",
      program: "/bin/bash",
      args: [],
      focused: false,
      live: true,
      history: [],
      viewport: ["screen 102"],
    };
    const p3: FakePane = {
      id: 103,
      tabId: 12,
      sessionId: 1,
      title: "vim",
      cwd: "/home/denis/docs",
      program: "vim",
      args: [],
      // Tern remembers a focused block PER TAB, so a hidden tab reports one too (measured on 0.4.5).
      focused: true,
      live: true,
      history: [],
      viewport: ["screen 103"],
    };
    const p4: FakePane = {
      id: 201,
      tabId: 21,
      sessionId: 2,
      title: "cargo build",
      cwd: "/home/denis/work",
      program: "cargo",
      args: ["build"],
      focused: true,
      live: true,
      history: [],
      viewport: ["screen 201"],
    };

    this.panes.set(p1.id, p1);
    this.panes.set(p2.id, p2);
    this.panes.set(p3.id, p3);
    this.panes.set(p4.id, p4);
  }

  writes(): readonly MuxWrite[] {
    return this.recorded;
  }

  emit(event: string, pane?: number): void {
    const payload = pane !== undefined ? JSON.stringify({ event, pane }) : JSON.stringify({ event });
    for (const l of this.listeners) {
      if (!l.ended) l.handlers.onLine(payload);
    }
  }

  async run(args: readonly string[], stdin?: string): Promise<TernRunResult> {
    if (!this.connected) {
      return { code: 1, stdout: "", stderr: "the session daemon did not answer" };
    }
    const verb = args[0];

    if (verb === "ls") {
      return { code: 0, stdout: JSON.stringify(this.buildLsResult()), stderr: "" };
    }

    if (verb === "capture") {
      const paneId = Number(args[1]);
      const pane = this.panes.get(paneId);
      if (!pane || !pane.live) {
        return { code: 1, stdout: "", stderr: `tern capture: no block is called \`${String(paneId)}\`` };
      }
      const scrollback = args.includes("--scrollback");
      const ansi = args.includes("--ansi");
      const lines = scrollback ? [...pane.history, ...pane.viewport] : [...pane.viewport];
      const rendered = ansi ? lines.map((l) => `${GREEN}${l}${RESET}`).join("\n") : lines.join("\n");
      return { code: 0, stdout: rendered + "\n", stderr: "" };
    }

    if (verb === "send") {
      const paneId = Number(args[1]);
      const kind = args[2];
      const pane = this.panes.get(paneId);
      if (!pane || !pane.live) {
        return { code: 1, stdout: "", stderr: `tern send: no block is called \`${String(paneId)}\`` };
      }
      if (kind === "text" || kind === "paste") {
        const text = args.slice(3).join(" ") || (stdin ?? "");
        this.recorded.push({ paneId: String(paneId), kind: "text", payload: [text] });
        pane.viewport.push(text);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (kind === "keys") {
        const keys = args.slice(3);
        this.recorded.push({ paneId: String(paneId), kind: "keys", payload: keys });
        return { code: 0, stdout: "", stderr: "" };
      }
    }

    if (verb === "close") {
      const paneId = Number(args[1]);
      const pane = this.panes.get(paneId);
      if (!pane || !pane.live) {
        return { code: 1, stdout: "", stderr: `tern close: no block is called \`${String(paneId)}\`` };
      }
      pane.live = false;
      this.emit("pane_closed", paneId);
      return { code: 0, stdout: "", stderr: "" };
    }

    if (verb === "focus") {
      const paneId = Number(args[1]);
      const pane = this.panes.get(paneId);
      if (!pane || !pane.live) {
        return { code: 1, stdout: "", stderr: `tern focus: no block is called \`${String(paneId)}\`` };
      }
      // Per-tab focus, as Tern keeps it: only the target tab's blocks move.
      for (const p of this.panes.values()) if (p.tabId === pane.tabId) p.focused = p.id === pane.id;
      const tab = this.tabs.get(pane.tabId);
      if (tab) {
        for (const t of this.tabs.values()) if (t.sessionId === tab.sessionId) t.shown = false;
        tab.shown = true;
      }
      const session = this.sessions.get(pane.sessionId);
      if (session) {
        for (const s of this.sessions.values()) s.shown = false;
        session.shown = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    }

    if (verb === "rename") {
      const blockId = Number(args[1]);
      const newName = args[2] ?? "";
      const pane = this.panes.get(blockId);
      if (!pane) {
        return { code: 1, stdout: "", stderr: `tern rename: no block is called \`${String(blockId)}\`` };
      }
      const tab = this.tabs.get(pane.tabId);
      if (tab) tab.name = newName;
      this.emit("title_changed", blockId);
      return { code: 0, stdout: "", stderr: "" };
    }

    if (verb === "new") {
      const sub = args[1];
      if (sub === "tab") {
        const targetSessionName = args[2] && !args[2].startsWith("-") ? args[2] : null;
        let session = targetSessionName
          ? [...this.sessions.values()].find((s) => s.name === targetSessionName)
          : [...this.sessions.values()].find((s) => s.shown);
        if (!session) session = this.sessions.get(1);
        if (!session) return { code: 1, stdout: "", stderr: "no session found" };

        const tabId = this.nextId++;
        const paneId = this.nextId++;
        const tabNumber = session.tabIds.length + 1;
        const newTab: FakeTab = {
          id: tabId,
          sessionId: session.id,
          number: tabNumber,
          name: null,
          shown: false,
          paneIds: [paneId],
        };
        const cwdIdx = args.indexOf("--cwd");
        const cwd = cwdIdx >= 0 && args[cwdIdx + 1] ? args[cwdIdx + 1] : "/home/denis";

        const newPane: FakePane = {
          id: paneId,
          tabId,
          sessionId: session.id,
          title: "shell",
          cwd: cwd!,
          program: "/bin/zsh",
          args: [],
          focused: true,
          live: true,
          history: [],
          viewport: ["$ "],
        };

        this.tabs.set(tabId, newTab);
        this.panes.set(paneId, newPane);
        session.tabIds.push(tabId);
        this.emit("pane_spawned", paneId);
        return { code: 0, stdout: String(paneId) + "\n", stderr: "" };
      }

      if (sub === "session") {
        const sessionName = args[2] ?? "new-session";
        const sessionId = this.nextId++;
        const tabId = this.nextId++;
        const paneId = this.nextId++;

        const cwdIdx = args.indexOf("--cwd");
        const cwd = cwdIdx >= 0 && args[cwdIdx + 1] ? args[cwdIdx + 1] : "/home/denis";

        const newSession: FakeSession = {
          id: sessionId,
          name: sessionName,
          shown: false,
          tabIds: [tabId],
        };
        const newTab: FakeTab = {
          id: tabId,
          sessionId,
          number: 1,
          name: null,
          shown: true,
          paneIds: [paneId],
        };
        const newPane: FakePane = {
          id: paneId,
          tabId,
          sessionId,
          title: "shell",
          cwd: cwd!,
          program: "/bin/zsh",
          args: [],
          focused: true,
          live: true,
          history: [],
          viewport: ["$ "],
        };

        this.sessions.set(sessionId, newSession);
        this.tabs.set(tabId, newTab);
        this.panes.set(paneId, newPane);
        this.emit("pane_spawned", paneId);
        this.emit("layout_changed");
        return { code: 0, stdout: String(paneId) + "\n", stderr: "" };
      }
    }

    return { code: 1, stdout: "", stderr: `unknown command: ${verb}` };
  }

  events(handlers: TernStreamHandlers): TernStreamClient {
    const listener: FakeListener = { handlers, ended: false };
    this.listeners.add(listener);
    return {
      kill: () => {
        listener.ended = true;
        this.listeners.delete(listener);
        handlers.onExit("closed");
      },
    };
  }

  private buildLsResult(): TernLsResult {
    const sessions: TernSession[] = [];
    for (const s of this.sessions.values()) {
      const tabs: TernTab[] = [];
      for (const tId of s.tabIds) {
        const t = this.tabs.get(tId);
        if (!t) continue;
        const blocks: TernBlock[] = [];
        for (const pId of t.paneIds) {
          const p = this.panes.get(pId);
          if (!p) continue;
          blocks.push({
            id: p.id,
            title: p.title,
            cwd: p.cwd,
            program: p.program,
            args: p.args,
            command: null,
            cols: 80,
            rows: 24,
            exited: p.live ? null : 0,
            keep_open: false,
            focused: p.focused,
            live: p.live,
          });
        }
        tabs.push({
          id: t.id,
          number: t.number,
          name: t.name,
          shown: t.shown,
          zoomed: false,
          blocks,
        });
      }
      sessions.push({
        id: s.id,
        name: s.name,
        shown: s.shown,
        tabs,
      });
    }
    return { sessions, detached: [] };
  }

  // ── Conformance perturbations ───────────────────────────────────

  async reconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
    this.connected = true;
  }

  async restartMux(): Promise<void> {
    // Rebuilding records as fresh objects while preserving IDs.
    const oldSessions = [...this.sessions.values()];
    const oldTabs = [...this.tabs.values()];
    const oldPanes = [...this.panes.values()];

    this.sessions = new Map(oldSessions.map((s) => [s.id, { ...s, tabIds: [...s.tabIds] }]));
    this.tabs = new Map(oldTabs.map((t) => [t.id, { ...t, paneIds: [...t.paneIds] }]));
    this.panes = new Map(oldPanes.map((p) => [p.id, { ...p, history: [...p.history], viewport: [...p.viewport] }]));
    await Promise.resolve();
  }

  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const pane = this.panes.get(Number(paneId));
    if (!pane) return;
    const tab = this.tabs.get(pane.tabId);
    if (tab) tab.name = label;
  }

  async setProgramTitle(paneId: string, title: string): Promise<void> {
    const pane = this.panes.get(Number(paneId));
    if (pane) pane.title = title;
  }

  async changePane(paneId: string): Promise<void> {
    const pane = this.panes.get(Number(paneId));
    if (pane) {
      pane.viewport.push(`paint ${String(Date.now())}`);
    }
  }

  async endPane(paneId: string): Promise<void> {
    const pane = this.panes.get(Number(paneId));
    if (pane) {
      pane.live = false;
    }
  }

  async pokeTopologyOutOfBand(): Promise<void> {
    // Structural change with NO event emitted — proves refresh().
    const s = this.sessions.get(1);
    if (!s) return;
    const tabId = this.nextId++;
    const paneId = this.nextId++;
    const newTab: FakeTab = {
      id: tabId,
      sessionId: s.id,
      number: s.tabIds.length + 1,
      name: "silent-tab",
      shown: false,
      paneIds: [paneId],
    };
    const newPane: FakePane = {
      id: paneId,
      tabId,
      sessionId: s.id,
      title: "silent",
      cwd: "/home/denis",
      program: "/bin/sh",
      args: [],
      focused: true,
      live: true,
      history: [],
      viewport: ["$ "],
    };
    this.tabs.set(tabId, newTab);
    this.panes.set(paneId, newPane);
    s.tabIds.push(tabId);
  }

  async pokeTopology(): Promise<void> {
    this.emit("layout_changed");
  }

  async pokePane(paneId: string): Promise<void> {
    this.emit("pane_resized", Number(paneId));
  }

  async focusOutOfBand(paneId: string): Promise<void> {
    const target = this.panes.get(Number(paneId));
    if (target) {
      for (const p of this.panes.values()) {
        if (p.tabId === target.tabId) {
          p.focused = p.id === target.id;
        }
      }
      const tab = this.tabs.get(target.tabId);
      if (tab) {
        for (const t of this.tabs.values()) {
          if (t.sessionId === tab.sessionId) t.shown = t.id === tab.id;
        }
      }
      const session = this.sessions.get(target.sessionId);
      if (session) {
        for (const s of this.sessions.values()) s.shown = s.id === session.id;
      }
    }
  }
}

export function ternWorld(fake: FakeTern): MuxConformanceWorld {
  const adapter = new TernMux(fake);
  return {
    adapter,
    writes: () => fake.writes(),
    reconnect: () => fake.reconnect(),
    restartMux: () => fake.restartMux(),
    renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
    setProgramTitle: (paneId, title) => fake.setProgramTitle(paneId, title),
    changePane: (paneId) => fake.changePane(paneId),
    endPane: (paneId) => fake.endPane(paneId),
    pokeTopologyOutOfBand: () => fake.pokeTopologyOutOfBand(),
    pokeTopology: () => fake.pokeTopology(),
    pokePane: (paneId) => fake.pokePane(paneId),
    focusOutOfBand: (paneId) => fake.focusOutOfBand(paneId),
    close: () => Promise.resolve(),
  };
}

export const ternConformanceFixture: MuxConformanceFixture = {
  mux: "tern",
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(ternWorld(new FakeTern()));
  },
};
