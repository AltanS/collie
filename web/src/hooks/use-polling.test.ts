import { intervalFor } from "./use-polling";
import type { HomeData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(paneId: string, status: AgentView["status"]): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/",
    focused: false,
  };
}

function makeShell(paneId: string): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "shell",
    status: "unknown",
    cwd: "/",
    focused: false,
    kind: "shell",
  };
}

function makeData(agents: AgentView[], shellPanes: AgentView[] = []): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents,
    shellPanes,
    workspaces: [],
    tabs: [],
    snoozedUntil: null,
    error: false,
  };
}

const HOT = 1500;
const COLD = 4000;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("intervalFor", () => {
  it("returns COLD when data is undefined and no pane is open", () => {
    expect(intervalFor(undefined)).toBe(COLD);
  });

  it("returns COLD when the herd is idle and no pane is open", () => {
    const data = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "done")]);
    expect(intervalFor(data)).toBe(COLD);
  });

  it("returns COLD when the herd is idle and no paneId is provided (home screen)", () => {
    const data = makeData([makeAgent("w1:p1", "idle")]);
    expect(intervalFor(data, null)).toBe(COLD);
  });

  it("returns HOT when any agent in the herd is working", () => {
    const data = makeData([makeAgent("w1:p1", "idle"), makeAgent("w1:p2", "working")]);
    expect(intervalFor(data)).toBe(HOT);
  });

  it("returns HOT when any agent in the herd is blocked", () => {
    const data = makeData([makeAgent("w1:p1", "blocked"), makeAgent("w1:p2", "done")]);
    expect(intervalFor(data)).toBe(HOT);
  });

  it("returns HOT when herd is idle but the open pane is an agent pane that is working", () => {
    // The open agent is idle globally but let's test: open pane exists in agents → HOT.
    // More precisely: the rule is "pane exists in agents ∪ shellPanes" → HOT regardless of status.
    const data = makeData([makeAgent("w1:p1", "idle")]);
    expect(intervalFor(data, "w1:p1")).toBe(HOT);
  });

  it("returns HOT when the open pane is a shell (shells are always live when open)", () => {
    const data = makeData([], [makeShell("w1:s1")]);
    expect(intervalFor(data, "w1:s1")).toBe(HOT);
  });

  it("returns COLD when a paneId is given but it matches no pane in agents or shellPanes", () => {
    const data = makeData([makeAgent("w1:p1", "idle")], [makeShell("w1:s1")]);
    expect(intervalFor(data, "w99:phantom")).toBe(COLD);
  });

  it("returns HOT (from herd) even when paneId is absent", () => {
    const data = makeData([makeAgent("w1:p1", "working")]);
    expect(intervalFor(data, undefined)).toBe(HOT);
  });
});
