import { describe, expect, it } from "vitest";

import { groupPanesByPlace, placeKey } from "./pane-groups";
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

const labels = (gs: ReturnType<typeof groupPanesByPlace>) => gs.map((g) => g.label);
const ids = (gs: ReturnType<typeof groupPanesByPlace>) => gs.map((g) => g.panes.map((p) => p.paneId));

describe("groupPanesByPlace — one group per space › tab", () => {
  it("heads a group with the joined place", () => {
    expect(labels(groupPanesByPlace([pane("p1")]))).toEqual(["collie-workspace › UI work"]);
  });

  it("heads an unnamed tab's group with the space alone", () => {
    // Herdr labels an unlabelled tab positionally; that is not a name (lib/pane-name.ts).
    expect(labels(groupPanesByPlace([pane("p1", { tabLabel: "2" })]))).toEqual(["collie-workspace"]);
    expect(labels(groupPanesByPlace([pane("p1", { tabLabel: undefined })]))).toEqual([
      "collie-workspace",
    ]);
  });

  it("puts two tabs of one space in two groups, and keeps each tab's panes together", () => {
    const groups = groupPanesByPlace([
      pane("a1", { tabId: "w1:t1", tabLabel: "UI work" }),
      pane("b1", { tabId: "w1:t2", tabLabel: "docs" }),
      pane("a2", { tabId: "w1:t1", tabLabel: "UI work" }),
    ]);
    expect(labels(groups)).toEqual(["collie-workspace › UI work", "collie-workspace › docs"]);
    expect(ids(groups)).toEqual([["a1", "a2"], ["b1"]]);
  });

  it("has no empty group and loses no pane", () => {
    const groups = groupPanesByPlace([pane("a"), pane("b", { tabId: "w1:t2", tabLabel: "docs" })]);
    expect(groups.every((g) => g.panes.length > 0)).toBe(true);
    expect(groups.flatMap((g) => g.panes).length).toBe(2);
  });
});

describe("groupPanesByPlace — the order", () => {
  it("runs by space number, whatever order the spaces arrived in", () => {
    const groups = groupPanesByPlace([
      pane("c", { workspaceId: "w3", workspaceLabel: "three", workspaceNumber: 3, tabId: "w3:t1" }),
      pane("a", { workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1" }),
      pane("b", { workspaceId: "w2", workspaceLabel: "two", workspaceNumber: 2, tabId: "w2:t1" }),
    ]);
    expect(ids(groups)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("runs by tab order inside a space — the order the bridge sent them", () => {
    const groups = groupPanesByPlace([
      pane("second", { tabId: "w1:t2", tabLabel: "docs" }),
      pane("first", { tabId: "w1:t1", tabLabel: "UI work" }),
    ]);
    expect(labels(groups)).toEqual(["collie-workspace › docs", "collie-workspace › UI work"]);
  });

  it("keeps the bridge's order inside a group, and never sorts by a clock", () => {
    const groups = groupPanesByPlace([
      pane("p3", { lastActiveAt: 1 }),
      pane("p1", { lastActiveAt: 900 }),
      pane("p2", { lastActiveAt: 500 }),
    ]);
    expect(ids(groups)).toEqual([["p3", "p1", "p2"]]);
  });

  it("is stable — the same lists twice give the same groups in the same order", () => {
    const herd = [pane("a"), pane("b", { tabId: "w1:t2", tabLabel: "docs" })];
    expect(groupPanesByPlace(herd).map((g) => g.key)).toEqual(
      groupPanesByPlace(herd).map((g) => g.key),
    );
  });
});

describe("groupPanesByPlace — shells", () => {
  it("puts a shell in its own tab's group, after the agents", () => {
    const groups = groupPanesByPlace(
      [pane("a1"), pane("a2")],
      [pane("sh", { kind: "shell", agent: "shell" })],
    );
    expect(ids(groups)).toEqual([["a1", "a2", "sh"]]);
  });

  it("opens a group for a tab that holds only shells", () => {
    const groups = groupPanesByPlace(
      [pane("a1")],
      [pane("sh", { kind: "shell", tabId: "w1:t2", tabLabel: "logs" })],
    );
    expect(labels(groups)).toEqual(["collie-workspace › UI work", "collie-workspace › logs"]);
  });

  it("takes no shells at all without complaint", () => {
    expect(groupPanesByPlace([pane("a")])).toHaveLength(1);
    expect(groupPanesByPlace([], [])).toEqual([]);
  });
});

describe("placeKey — a tab id is not an address on its own", () => {
  it("tells two machines' identically numbered tabs apart", () => {
    expect(placeKey(pane("p", { host: "lodge" }))).not.toBe(placeKey(pane("p", { host: "attic" })));
  });

  it("tells two sessions' identically numbered tabs apart", () => {
    expect(placeKey(pane("p", { session: "a" }))).not.toBe(placeKey(pane("p", { session: "b" })));
  });

  it("keeps two machines' same-numbered tabs in two groups", () => {
    const groups = groupPanesByPlace([
      pane("p", { host: "lodge", workspaceLabel: "lodge-proj" }),
      pane("p", { host: "attic", workspaceLabel: "attic-proj" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("degrades to the bare ids when nothing is tagged", () => {
    expect(placeKey(pane("p"))).toBe("\u0000\u0000w1\u0000w1:t1");
  });
});
