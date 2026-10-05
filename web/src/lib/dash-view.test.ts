import { describe, expect, it } from "vitest";

import {
  coerceDashView,
  isLegacyDashView,
  pinnedRows,
  shownGroups,
  stripEntries,
  wasFocusView,
  type StripEntry,
} from "./dash-view";
import { groupPanesByWorkspace } from "./pane-groups";
import { currentPins, pinMatcher, setPinned } from "./pins";
import type { AgentView } from "./types";

// Issue 270's filter, as the "Focus" tab draws it (ADR 0066, renamed by ADR 0068): it removes rows
// and moves nothing.

function pane(id: string, ws: number, status: AgentView["status"], extra: Partial<AgentView> = {}): AgentView {
  return {
    paneId: `w${ws}:${id}`,
    workspaceId: `w${ws}`,
    workspaceLabel: `ws${ws}`,
    workspaceNumber: ws,
    tabId: `w${ws}:t1`,
    agent: "claude",
    status,
    cwd: `/home/you/ws${ws}`,
    focused: false,
    ...extra,
  };
}

// ws1: a blocked pane between two quiet ones. ws2: nothing urgent. ws3: a ready-unseen pane, then a
// blocked one, in that order.
const agents: AgentView[] = [
  pane("p1", 1, "working"),
  pane("p2", 1, "blocked"),
  pane("p3", 1, "idle"),
  pane("p1", 2, "working"),
  pane("p2", 2, "idle"),
  pane("p1", 3, "done", { lastActiveAt: 20, lastSeenAt: 10 }),
  pane("p2", 3, "blocked"),
];
const groups = groupPanesByWorkspace(agents, [], { order: "fixed" });

describe("shownGroups", () => {
  it("Panes shows every group with every row", () => {
    const shown = shownGroups(groups, false);
    expect(shown.map((s) => s.group.label)).toEqual(["ws1", "ws2", "ws3"]);
    expect(shown.map((s) => s.rows.length)).toEqual([3, 2, 2]);
  });

  it("Focus keeps only the panes that need you and drops a group with none", () => {
    const shown = shownGroups(groups, true);
    expect(shown.map((s) => s.group.label)).toEqual(["ws1", "ws3"]);
    expect(shown.map((s) => s.rows.map((r) => r.paneId))).toEqual([["w1:p2"], ["w3:p1", "w3:p2"]]);
  });

  it("keeps the order: groups in the dashboard's order, rows in their group's order", () => {
    const shown = shownGroups(groups, true);
    const flat = shown.flatMap((s) => s.rows.map((r) => r.paneId));
    const all = groups.flatMap((g) => g.panes.map((p) => p.paneId));
    expect(flat).toEqual(all.filter((id) => flat.includes(id)));
  });

  it("passes each group through whole, so its heading still counts every pane", () => {
    const shown = shownGroups(groups, true);
    expect(shown[0]!.group).toBe(groups[0]);
    expect(shown[0]!.group.panes).toHaveLength(3);
  });

  it("leaves nothing when nothing needs you", () => {
    const calm = groupPanesByWorkspace([pane("p1", 1, "working"), pane("p1", 2, "idle")], [], { order: "fixed" });
    expect(shownGroups(calm, true)).toEqual([]);
  });

  it("never lets a bare shell through", () => {
    const shell = pane("p9", 1, "unknown", { kind: "shell", agent: "shell" });
    const withShell = groupPanesByWorkspace([pane("p2", 1, "blocked")], [shell], { order: "fixed" });
    expect(shownGroups(withShell, true)[0]!.rows.map((r) => r.paneId)).toEqual(["w1:p2"]);
  });
});

// Pinned panes (ADR 0070): a pinned pane leads in a Pinned group, in place order, and leaves its
// workspace group, so it is listed once. The group itself still rides along whole.
describe("pinned rows", () => {
  /** Pin these panes, in THIS order (the time of the pin), and return the list's test. */
  function pin(...ids: string[]) {
    let now = 0;
    for (const id of ids) setPinned(agents.find((a) => a.paneId === id)!, true, agents, ++now);
    return pinMatcher(currentPins());
  }

  it("lists the pinned panes in place order, whatever order they were pinned in", () => {
    // Pinned last-first: ws3 before ws1, and within ws1 the third pane before the first.
    const isPinned = pin("w3:p2", "w1:p3", "w1:p1");
    expect(pinnedRows(groups, isPinned).map((p) => p.paneId)).toEqual(["w1:p1", "w1:p3", "w3:p2"]);
  });

  it("never reads status: a state change moves no pinned row", () => {
    const isPinned = pin("w1:p1", "w3:p2");
    const flipped = groupPanesByWorkspace(
      agents.map((a) => ({ ...a, status: a.status === "blocked" ? ("idle" as const) : ("blocked" as const) })),
      [],
      { order: "fixed" },
    );
    expect(pinnedRows(flipped, isPinned).map((p) => p.paneId)).toEqual(
      pinnedRows(groups, isPinned).map((p) => p.paneId),
    );
  });

  it("takes pinned rows out of their groups on Panes, and drops a group left empty", () => {
    const isPinned = pin("w2:p1", "w2:p2", "w1:p2");
    const shown = shownGroups(groups, false, isPinned);
    // ws2 had two panes, both pinned: the group is gone. ws1 lost its middle row, in place.
    expect(shown.map((s) => s.group.label)).toEqual(["ws1", "ws3"]);
    expect(shown[0]!.rows.map((r) => r.paneId)).toEqual(["w1:p1", "w1:p3"]);
    // The heading still counts every pane of its workspace, pinned or not.
    expect(shown[0]!.group).toBe(groups[0]);
    expect(shown[0]!.group.panes).toHaveLength(3);
  });

  it("does the same under Focus: a group whose urgent rows are all pinned is dropped", () => {
    // ws1's one urgent pane is pinned; ws3 keeps its unpinned urgent pane.
    const isPinned = pin("w1:p2", "w3:p1");
    const shown = shownGroups(groups, true, isPinned);
    expect(shown.map((s) => s.group.label)).toEqual(["ws3"]);
    expect(shown[0]!.rows.map((r) => r.paneId)).toEqual(["w3:p2"]);
  });

  it("lists each pane once: the pinned rows and the group rows never overlap, and cover the herd", () => {
    const isPinned = pin("w1:p2", "w2:p1", "w3:p1");
    const pinnedIds = pinnedRows(groups, isPinned).map((p) => p.paneId);
    const groupIds = shownGroups(groups, false, isPinned).flatMap((s) => s.rows.map((r) => r.paneId));
    expect(pinnedIds.filter((id) => groupIds.includes(id))).toEqual([]);
    expect([...pinnedIds, ...groupIds].toSorted()).toEqual(agents.map((a) => a.paneId).toSorted());
  });

  it("changes nothing with nothing pinned", () => {
    const isPinned = pinMatcher(currentPins());
    expect(pinnedRows(groups, isPinned)).toEqual([]);
    expect(shownGroups(groups, false, isPinned)).toEqual(shownGroups(groups, false));
    expect(shownGroups(groups, true, isPinned)).toEqual(shownGroups(groups, true));
  });
});

describe("coerceDashView", () => {
  it.each([
    ["dashboard", "dashboard"],
    ["crew", "crew"],
    ["changes", "changes"],
    // The retired names (ADR 0085): the first tab was renamed, and Focus is a switch now.
    ["panes", "dashboard"],
    ["focus", "dashboard"],
    ["needs", "dashboard"],
    ["attention", "dashboard"],
    ["all", "dashboard"],
    [2, "dashboard"],
    [undefined, "dashboard"],
  ] as const)("reads %s as %s", (stored, view) => {
    expect(coerceDashView(stored)).toBe(view);
  });

  it("names the retired values, and which of them was Focus", () => {
    expect(["panes", "focus", "needs", "attention", "dashboard", "crew", "changes", "all"].map(isLegacyDashView)).toEqual(
      [true, true, true, true, false, false, false, false],
    );
    expect(["panes", "focus", "needs", "attention", "dashboard", "crew"].map(wasFocusView)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

// The workspace strip with a machine hidden (issue #288): one stand-in per hidden machine, at the
// place its first workspace held, carrying every pane of that machine; isolate keeps its chip.
describe("stripEntries — a hidden machine's stand-in", () => {
  const crew = [
    pane("p1", 1, "idle", { host: "bluefin" }),
    pane("p1", 1, "idle", { host: "workshop" }),
    pane("p1", 2, "blocked", { host: "workshop" }),
    pane("p1", 1, "working", { host: "attic" }),
  ];
  const crewGroups = groupPanesByWorkspace(crew, [], { order: "fixed" });
  const names = (entries: StripEntry[]) =>
    entries.map((e) => (e.kind === "machine" ? `[${e.host}:${e.panes.length}]` : e.group.label));

  it("is one chip per workspace when nothing is hidden", () => {
    expect(names(stripEntries(crewGroups, new Set(), undefined))).toEqual(["ws1", "ws1", "ws2", "ws1"]);
  });

  it("folds a hidden machine's workspaces into one stand-in at its place, holding all its panes", () => {
    const entries = stripEntries(crewGroups, new Set(["workshop"]), undefined);
    expect(names(entries)).toEqual(["ws1", "[workshop:2]", "ws1"]);
  });

  it("keeps an isolated workspace's chip, right after its machine's stand-in", () => {
    const isolated = crewGroups.find((g) => g.panes[0]!.host === "workshop" && g.label === "ws2")!;
    expect(names(stripEntries(crewGroups, new Set(["workshop"]), isolated.key))).toEqual([
      "ws1",
      "[workshop:2]",
      "ws2",
      "ws1",
    ]);
  });

  it("draws no stand-in for a hidden machine with no workspace", () => {
    expect(names(stripEntries(crewGroups, new Set(["cellar"]), undefined))).toEqual(["ws1", "ws1", "ws2", "ws1"]);
  });
});
