import { describe, expect, test } from "bun:test";

import { StateEngine } from "./state-engine.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { AgentStatus } from "./types.ts";

// The state engine polls Herdr, shapes the snapshot, and fires status transitions (which drive push
// notifications). We exercise it with a fake HerdrClient whose returned panes change between polls.

interface FakePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  agent?: string | null;
  agent_status: AgentStatus;
  revision: number;
}

function pane(id: string, ws: string, status: AgentStatus, agent: string | null): FakePane {
  return {
    pane_id: id,
    terminal_id: "term",
    workspace_id: ws,
    tab_id: `${ws}:t1`,
    focused: false,
    cwd: "/home/you/demo",
    agent,
    agent_status: status,
    revision: 0,
  };
}

const ws = (id: string, number: number) => ({
  workspace_id: id,
  number,
  label: id,
  focused: false,
  pane_count: 1,
  tab_count: 1,
  active_tab_id: `${id}:t1`,
  agent_status: "idle" as AgentStatus,
});

class FakeHerdr {
  panes: FakePane[] = [];
  workspaces = [ws("w1", 1), ws("w2", 2)];
  tabs = [
    {
      tab_id: "w1:t1",
      workspace_id: "w1",
      number: 1,
      label: "1",
      focused: false,
      pane_count: 1,
      agent_status: "idle" as AgentStatus,
    },
  ];
  listWorkspaces() {
    return Promise.resolve(this.workspaces);
  }
  listPanes() {
    return Promise.resolve(this.panes);
  }
  listTabs() {
    return Promise.resolve(this.tabs);
  }
}

function makeEngine() {
  const herdr = new FakeHerdr();
  const engine = new StateEngine(herdr as unknown as HerdrClient, 1500);
  const transitions: Array<{ pane: string; from: AgentStatus; to: AgentStatus }> = [];
  engine.onTransition((a, from, to) => transitions.push({ pane: a.paneId, from, to }));
  const poll = () => (engine as unknown as { poll(): Promise<void> }).poll();
  return { herdr, engine, transitions, poll };
}

describe("StateEngine — transition detection", () => {
  test("does not fire a transition on the first sighting of a pane", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([]);
  });

  test("fires when an agent's status changes between polls", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "working", "claude")];
    await poll(); // first sighting — suppressed
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll();
    expect(transitions).toEqual([{ pane: "w1:p1", from: "working", to: "blocked" }]);
  });

  test("prunes a vanished pane so its return is a fresh first sighting", async () => {
    const { herdr, transitions, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // first sighting
    herdr.panes = []; // pane closed
    await poll(); // pruned from prevStatus
    herdr.panes = [pane("w1:p1", "w1", "blocked", "claude")];
    await poll(); // reappears — must be treated as new, not a transition
    expect(transitions).toEqual([]);
  });
});

describe("StateEngine — snapshot shaping", () => {
  test("splits agent panes from bare shell panes", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude"), pane("w1:p2", "w1", "unknown", null)];
    await poll();
    const snap = engine.current();
    expect(snap.agents.map((a) => a.paneId)).toEqual(["w1:p1"]);
    expect(snap.shellPanes.map((a) => a.paneId)).toEqual(["w1:p2"]);
    expect(snap.shellPanes[0]!.agent).toBe("shell");
    expect(snap.bridge).toBe("connected");
  });

  test("sorts agents by urgency (blocked first), then workspace number", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [
      pane("w2:p1", "w2", "idle", "claude"),
      pane("w1:p1", "w1", "blocked", "codex"),
      pane("w2:p2", "w2", "working", "claude"),
    ];
    await poll();
    expect(engine.current().agents.map((a) => a.paneId)).toEqual(["w1:p1", "w2:p2", "w2:p1"]);
  });

  test("marks the bridge disconnected when a poll throws", async () => {
    const { herdr, engine, poll } = makeEngine();
    herdr.panes = [pane("w1:p1", "w1", "idle", "claude")];
    await poll();
    expect(engine.current().bridge).toBe("connected");
    herdr.listPanes = () => Promise.reject(new Error("socket down"));
    await poll();
    expect(engine.current().bridge).toBe("disconnected");
  });
});
