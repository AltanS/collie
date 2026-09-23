import { describe, expect, it } from "vitest";

import { coerceDashView, shownGroups } from "./dash-view";
import { groupPanesByWorkspace } from "./pane-groups";
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

describe("coerceDashView", () => {
  it("keeps the three views and turns anything else into Panes", () => {
    expect(coerceDashView("panes")).toBe("panes");
    expect(coerceDashView("focus")).toBe("focus");
    expect(coerceDashView("changes")).toBe("changes");
    expect(coerceDashView("all")).toBe("panes");
    expect(coerceDashView(undefined)).toBe("panes");
  });

  it("reads a pre-rename stored value as Focus (ADR 0068)", () => {
    // "needs" is what a device stored before the tab was named Attention; "attention" is handled
    // the same way in case any build ever wrote the label instead of the internal name.
    expect(coerceDashView("needs")).toBe("focus");
    expect(coerceDashView("attention")).toBe("focus");
  });
});
