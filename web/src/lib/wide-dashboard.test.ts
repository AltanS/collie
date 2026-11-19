import { describe, expect, it } from "vitest";

import type { ShownGroup } from "@/lib/dash-view";
import { EXPANDED_MIN_PX, MEDIUM_MIN_PX } from "@/lib/wide-layout";
import type { AgentStatus, AgentView } from "@/lib/types";
import { contentWidth, gridWidth, machineRuns, MAX_SPACE_COLUMNS, runsIntoColumns, SPACE_WIDTH, spaceColumns, waitingPanes } from "./wide-dashboard";

describe("the Space grid's columns", () => {
  it("reads the count from the width alone, two at 1024, three at 1280 and 1440, four at 1920, six at most", () => {
    expect([1024, 1280, 1440, 1920, 2560, 3440].map(spaceColumns)).toEqual([2, 3, 3, 4, 6, 6]);
  });

  it("begins the grid with the expanded width class: two columns at 900px, one at 840px less one and in medium", () => {
    // The grid is drawn only in the `expanded` class (900px, ADR 0120), so its floor must hold two columns.
    expect(spaceColumns(EXPANDED_MIN_PX)).toBe(2);
    expect(spaceColumns(839)).toBe(1);
    expect(spaceColumns(MEDIUM_MIN_PX)).toBe(1);
    expect(spaceColumns(390)).toBe(1);
  });

  it("holds the six-column cap and never returns less than one", () => {
    expect(spaceColumns(10_000)).toBe(MAX_SPACE_COLUMNS);
    expect(spaceColumns(0)).toBe(1);
  });

  it("changes the count only at a column's edge: 1248px is three columns and 1247px is two", () => {
    expect(contentWidth(3)).toBe(1248);
    expect(spaceColumns(1248)).toBe(3);
    expect(spaceColumns(1247)).toBe(2);
    expect(spaceColumns(1655)).toBe(3);
    expect(spaceColumns(1656)).toBe(4);
  });

  it("measures the grid as its columns and the gaps between them, and the column as the grid and its gutters", () => {
    expect(gridWidth(1)).toBe(SPACE_WIDTH);
    expect(gridWidth(3)).toBe(3 * 384 + 2 * 24);
    expect(contentWidth(3)).toBe(gridWidth(3) + 48);
  });
});

describe("cutting a list into columns", () => {
  it("cuts a list into runs read down one column, then the next", () => {
    expect(runsIntoColumns([1, 2, 3, 4, 5], 3)).toEqual([[1, 2], [3, 4], [5]]);
    expect(runsIntoColumns([1, 2], 4)).toEqual([[1], [2]]);
  });
});

describe("the sessions of the band", () => {
  const pane = (id: string, status: AgentStatus, over: Partial<AgentView> = {}): AgentView => ({
    paneId: id,
    workspaceId: "w1",
    workspaceLabel: "w1",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/src",
    focused: false,
    ...over,
  });
  const group = (key: string, panes: AgentView[]) => ({ key, label: key, panes });

  it("takes the sessions that need you or finished unseen, in the list's own order and never by status", () => {
    const a = pane("w1:p1", "working");
    const b = pane("w1:p2", "done", { lastActiveAt: 200, lastSeenAt: 100 });
    const c = pane("w2:p1", "blocked");
    const d = pane("w2:p2", "idle");
    expect(waitingPanes([group("w1", [a, b]), group("w2", [c, d])]).map((p) => p.paneId)).toEqual(["w1:p2", "w2:p1"]);
    // The same herd with a different state mix still keeps the Space order: the blocked one is not first.
    expect(waitingPanes([group("w1", [pane("w1:p1", "blocked")]), group("w2", [pane("w2:p1", "blocked")])]).map((p) => p.paneId)).toEqual(["w1:p1", "w2:p1"]);
  });

  it("leaves a session that is seen and finished, and takes the answer of the held list when one is given", () => {
    const seen = pane("w1:p1", "done", { lastActiveAt: 100, lastSeenAt: 200 });
    const waiting = pane("w1:p2", "blocked");
    expect(waitingPanes([group("w1", [seen, waiting])]).map((p) => p.paneId)).toEqual(["w1:p2"]);
    expect(waitingPanes([group("w1", [seen, waiting])], (p) => p.paneId === "w1:p1").map((p) => p.paneId)).toEqual(["w1:p1"]);
  });

  it("is empty with nothing waiting", () => {
    expect(waitingPanes([group("w1", [pane("w1:p1", "working")])])).toEqual([]);
  });
});

describe("machine runs", () => {
  const shown = (host: string | undefined, id: string): ShownGroup => {
    const pane: AgentView = {
      paneId: `${id}:p1`,
      workspaceId: id,
      workspaceLabel: id,
      workspaceNumber: 1,
      tabId: `${id}:t1`,
      agent: "claude",
      status: "idle",
      cwd: "/src",
      focused: false,
    };
    if (host !== undefined) pane.host = host;
    return { group: { key: `${host ?? ""}\u0000${id}`, label: id, panes: [pane] }, rows: [pane] };
  };

  it("cuts the list where the machine changes, keeping the order", () => {
    const runs = machineRuns([shown("lodge", "w1"), shown("lodge", "w2"), shown("workshop", "w1")]);
    expect(runs.map((r) => [r.host, r.items.length])).toEqual([
      ["lodge", 2],
      ["workshop", 1],
    ]);
  });

  it("is one run with no host when solo", () => {
    expect(machineRuns([shown(undefined, "w1"), shown(undefined, "w2")]).map((r) => r.host)).toEqual([""]);
  });
});
