import { describe, expect, it } from "vitest";

import type { ShownGroup } from "@/lib/dash-view";
import type { AgentView } from "@/lib/types";
import { dealIntoColumns, gridWidth, isWideDashboard, machineRuns, runsIntoColumns, spaceColumns } from "./wide-dashboard";

describe("the Space grid's columns", () => {
  it("reads the count from the width alone, two at 1024, three at 1280 and 1440, four at 1920, six at most", () => {
    expect([1024, 1280, 1440, 1920, 2560, 3440].map(spaceColumns)).toEqual([2, 3, 3, 4, 6, 6]);
  });

  it("begins the grid inside the expanded width class and never in medium", () => {
    expect(isWideDashboard(899)).toBe(true);
    expect(isWideDashboard(839)).toBe(false);
    expect(isWideDashboard(600)).toBe(false);
    expect(spaceColumns(390)).toBe(1);
  });

  it("measures the grid as its columns and the gaps between them", () => {
    expect(gridWidth(3)).toBe(3 * 384 + 2 * 24);
  });
});

describe("dealing Spaces into columns", () => {
  it("puts item i in column i mod n, so a Space's column never depends on another's height", () => {
    expect(dealIntoColumns(["a", "b", "c", "d", "e"], 3)).toEqual([["a", "d"], ["b", "e"], ["c"]]);
  });

  it("keeps every column of a Space when one more Space joins at the end", () => {
    const before = dealIntoColumns([1, 2, 3, 4], 3);
    const after = dealIntoColumns([1, 2, 3, 4, 5], 3);
    before.forEach((column, i) => expect(after[i]!.slice(0, column.length)).toEqual(column));
  });

  it("cuts a list into runs read down one column, then the next", () => {
    expect(runsIntoColumns([1, 2, 3, 4, 5], 3)).toEqual([[1, 2], [3, 4], [5]]);
    expect(runsIntoColumns([1, 2], 4)).toEqual([[1], [2]]);
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
