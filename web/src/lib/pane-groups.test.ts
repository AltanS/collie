import { describe, expect, it } from "vitest";

import { groupPanesByWorkspace, workspaceGroupKey } from "./pane-groups";
import type { AgentView } from "./types";

function pane(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "collie-workspace",
    workspaceNumber: 1,
    tabId: "w1:t1",
    tabLabel: "UI work",
    agent: "claude",
    status: "idle",
    cwd: "/home/k/proj",
    focused: false,
    ...over,
  };
}

const labels = (gs: ReturnType<typeof groupPanesByWorkspace>) => gs.map((g) => g.label);
const ids = (gs: ReturnType<typeof groupPanesByWorkspace>) =>
  gs.map((g) => g.panes.map((p) => p.paneId));

describe("groupPanesByWorkspace — one group per workspace", () => {
  it("heads a group with the workspace's own name, never with its tab", () => {
    expect(labels(groupPanesByWorkspace([pane("p1")]))).toEqual(["collie-workspace"]);
  });

  it("falls back to the workspace id when the multiplexer gave it no name", () => {
    expect(labels(groupPanesByWorkspace([pane("p1", { workspaceLabel: "" })]))).toEqual(["w1"]);
  });

  it("keeps two tabs of one workspace in ONE group", () => {
    const groups = groupPanesByWorkspace([
      pane("a1", { tabId: "w1:t1", tabLabel: "UI work" }),
      pane("b1", { tabId: "w1:t2", tabLabel: "docs" }),
      pane("a2", { tabId: "w1:t1", tabLabel: "UI work" }),
    ]);
    expect(labels(groups)).toEqual(["collie-workspace"]);
    // Tab by tab, in the order the tabs were met — not in the order the panes arrived.
    expect(ids(groups)).toEqual([["a1", "a2", "b1"]]);
  });

  it("has no empty group and loses no pane", () => {
    const groups = groupPanesByWorkspace([
      pane("a"),
      pane("b", { workspaceId: "w2", workspaceNumber: 2, tabId: "w2:t1" }),
    ]);
    expect(groups.every((g) => g.panes.length > 0)).toBe(true);
    expect(groups.flatMap((g) => g.panes).length).toBe(2);
  });

  it("groups only what it was handed — a pulled-out pane is in neither a group nor a count", () => {
    // The dashboard withholds the rows it already listed on top; the count is what is left.
    const groups = groupPanesByWorkspace([pane("stays"), pane("also")]);
    expect(groups[0]!.panes).toHaveLength(2);
    expect(groupPanesByWorkspace([pane("stays")])[0]!.panes).toHaveLength(1);
  });
});

describe("groupPanesByWorkspace — the order", () => {
  it("runs by workspace number, whatever order the workspaces arrived in", () => {
    const groups = groupPanesByWorkspace([
      pane("c", { workspaceId: "w3", workspaceLabel: "three", workspaceNumber: 3, tabId: "w3:t1" }),
      pane("a", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1" }),
      pane("b", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1" }),
    ]);
    expect(labels(groups)).toEqual(["one", "two", "three"]);
  });

  it("keeps a machine's workspaces together, in the order the bridge sent the machines", () => {
    // Both machines number from 1, so a sort on the number alone would interleave them.
    const groups = groupPanesByWorkspace([
      pane("lead2", { host: "lodge", workspaceId: "w2", workspaceLabel: "lodge-two", workspaceNumber: 2 }),
      pane("peer1", { host: "attic", workspaceId: "w1", workspaceLabel: "attic-one", workspaceNumber: 1 }),
      pane("lead1", { host: "lodge", workspaceId: "w1", workspaceLabel: "lodge-one", workspaceNumber: 1 }),
    ]);
    expect(labels(groups)).toEqual(["lodge-one", "lodge-two", "attic-one"]);
  });

  it("runs the tabs inside a workspace in the order the bridge sent them", () => {
    const groups = groupPanesByWorkspace([
      pane("second", { tabId: "w1:t2", tabLabel: "docs" }),
      pane("first", { tabId: "w1:t1", tabLabel: "UI work" }),
    ]);
    expect(ids(groups)).toEqual([["second", "first"]]);
  });

  it("keeps the bridge's order inside a tab, and never sorts by a clock", () => {
    const groups = groupPanesByWorkspace([
      pane("p3", { lastActiveAt: 1 }),
      pane("p1", { lastActiveAt: 900 }),
      pane("p2", { lastActiveAt: 500 }),
    ]);
    expect(ids(groups)).toEqual([["p3", "p1", "p2"]]);
  });

  it("is stable — the same lists twice give the same groups in the same order", () => {
    const herd = [pane("a"), pane("b", { tabId: "w1:t2", tabLabel: "docs" })];
    expect(groupPanesByWorkspace(herd).map((g) => g.key)).toEqual(
      groupPanesByWorkspace(herd).map((g) => g.key),
    );
  });
});

describe("groupPanesByWorkspace — shells", () => {
  it("puts a shell after its OWN tab's agents, not at the end of the workspace", () => {
    const groups = groupPanesByWorkspace(
      [pane("a1"), pane("a2", { tabId: "w1:t2", tabLabel: "docs" })],
      [pane("sh", { kind: "shell", agent: "shell" })],
    );
    expect(ids(groups)).toEqual([["a1", "sh", "a2"]]);
  });

  it("opens a group for a workspace that holds only shells", () => {
    const groups = groupPanesByWorkspace(
      [],
      [pane("sh", { kind: "shell", workspaceLabel: "logs-box", tabLabel: "logs" })],
    );
    expect(labels(groups)).toEqual(["logs-box"]);
  });

  it("takes no shells at all without complaint", () => {
    expect(groupPanesByWorkspace([pane("a")])).toHaveLength(1);
    expect(groupPanesByWorkspace([], [])).toEqual([]);
  });
});

describe("workspaceGroupKey — a workspace id is not an address on its own", () => {
  it("tells two machines' identically numbered workspaces apart", () => {
    expect(workspaceGroupKey(pane("p", { host: "lodge" }))).not.toBe(
      workspaceGroupKey(pane("p", { host: "attic" })),
    );
  });

  it("tells two sessions' identically numbered workspaces apart", () => {
    expect(workspaceGroupKey(pane("p", { session: "a" }))).not.toBe(
      workspaceGroupKey(pane("p", { session: "b" })),
    );
  });

  it("keeps two machines' same-numbered workspaces in two groups", () => {
    const groups = groupPanesByWorkspace([
      pane("p", { host: "lodge", workspaceLabel: "lodge-proj" }),
      pane("p", { host: "attic", workspaceLabel: "attic-proj" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("ignores the tab — one workspace is one key however many tabs it has", () => {
    expect(workspaceGroupKey(pane("p", { tabId: "w1:t9" }))).toBe(workspaceGroupKey(pane("p")));
  });

  it("degrades to the bare ids when nothing is tagged", () => {
    expect(workspaceGroupKey(pane("p"))).toBe("\u0000\u0000w1");
  });
});
