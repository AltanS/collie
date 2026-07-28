import {
  blockedCount,
  filterSpaces,
  groupPanesByTab,
  sortSpacesByRecency,
  spaceLastSeen,
  spaceLastSeenMap,
  worstSpaceStatus,
} from "./spaces";
import type { AgentStatus, AgentView, TabView, WorkspaceView } from "./types";

function agent(
  partial: Partial<AgentView> & { paneId: string; workspaceId: string; tabId: string },
): AgentView {
  return {
    workspaceLabel: "ws",
    workspaceNumber: 1,
    agent: "claude",
    status: "idle",
    cwd: "/home/you/demo",
    focused: false,
    ...partial,
  };
}

const tab = (tabId: string, workspaceId: string, number: number): TabView => ({
  tabId,
  workspaceId,
  number,
  label: String(number),
  focused: false,
  paneCount: 1,
});

describe("groupPanesByTab", () => {
  const tabs = [tab("w1:t2", "w1", 2), tab("w1:t1", "w1", 1)]; // differs from stable number order

  it("preserves snapshot tab order when grouping panes", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const a2 = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t2" });
    const groups = groupPanesByTab("w1", tabs, [a1, a2], []);
    expect(groups.map((g) => g.tabId)).toEqual(["w1:t2", "w1:t1"]);
    expect(groups[0]!.panes).toEqual([a2]);
    expect(groups[1]!.panes).toEqual([a1]);
  });

  it("includes shell panes alongside agents in their tab", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const shell = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", kind: "shell" });
    const group = groupPanesByTab("w1", tabs, [a1], [shell]).find((item) => item.tabId === "w1:t1");
    expect(group!.panes).toEqual([a1, shell]);
  });

  it("collects panes whose tab isn't listed yet into a trailing '…' group", () => {
    const orphan = agent({ paneId: "w1:p9", workspaceId: "w1", tabId: "w1:tX" });
    const groups = groupPanesByTab("w1", tabs, [orphan], []);
    const last = groups.at(-1)!;
    expect(last.tabId).toBe("w1:other");
    expect(last.label).toBe("…");
    expect(last.panes).toEqual([orphan]);
  });

  it("ignores panes from other workspaces", () => {
    const other = agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1" });
    const groups = groupPanesByTab("w1", tabs, [other], []);
    expect(groups.every((g) => g.panes.length === 0)).toBe(true);
  });
});

describe("blockedCount", () => {
  it("counts only blocked agents within the given workspace", () => {
    const agents = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", status: "blocked" }),
      agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", status: "working" }),
      agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", status: "blocked" }),
    ];
    expect(blockedCount("w1", agents)).toBe(1);
    expect(blockedCount("w2", agents)).toBe(1);
    expect(blockedCount("w3", agents)).toBe(0);
  });

  it("counts every blocked agent, not just presence", () => {
    const agents = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", status: "blocked" }),
      agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", status: "blocked" }),
      agent({ paneId: "w1:p3", workspaceId: "w1", tabId: "w1:t1", status: "working" }),
    ];
    expect(blockedCount("w1", agents)).toBe(2);
  });
});

describe("worstSpaceStatus", () => {
  const mk = (status: AgentStatus) =>
    agent({ paneId: `w1:${status}`, workspaceId: "w1", tabId: "w1:t1", status });

  it("returns null when the workspace has no agents", () => {
    expect(worstSpaceStatus("w1", [])).toBeNull();
    expect(worstSpaceStatus("w1", [agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1" })])).toBeNull();
  });

  it("returns the most-urgent status (blocked beats working beats idle/done)", () => {
    expect(worstSpaceStatus("w1", [mk("idle"), mk("working"), mk("blocked")])).toBe("blocked");
    expect(worstSpaceStatus("w1", [mk("done"), mk("working")])).toBe("working");
    expect(worstSpaceStatus("w1", [mk("idle"), mk("done")])).toBe("idle");
  });

  it("ranks unknown between working and idle", () => {
    expect(worstSpaceStatus("w1", [mk("idle"), mk("unknown")])).toBe("unknown");
    expect(worstSpaceStatus("w1", [mk("working"), mk("unknown")])).toBe("working");
  });
});

const ws = (workspaceId: string, label: string, number: number): WorkspaceView => ({
  workspaceId,
  number,
  label,
  focused: false,
  activeTabId: `${workspaceId}:t1`,
  tabCount: 1,
  paneCount: 1,
});

describe("spaceLastSeen", () => {
  it("takes the most recent look across the space's panes", () => {
    const panes = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 100 }),
      agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 900 }),
    ];
    expect(spaceLastSeen("w1", panes)).toBe(900);
  });

  it("ignores panes in other spaces", () => {
    const panes = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 100 }),
      agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", lastSeenAt: 900 }),
    ];
    expect(spaceLastSeen("w1", panes)).toBe(100);
  });

  it("counts bare shells, not just agents", () => {
    const panes = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", kind: "shell", lastSeenAt: 700 }),
    ];
    expect(spaceLastSeen("w1", panes)).toBe(700);
  });

  it("is 0 for a space you've never opened, and on a bridge with no timestamps", () => {
    expect(spaceLastSeen("w1", [])).toBe(0);
    expect(
      spaceLastSeen("w1", [agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" })]),
    ).toBe(0);
  });
});

describe("sortSpacesByRecency", () => {
  const spaces = [ws("w1", "alpha", 1), ws("w2", "beta", 2), ws("w3", "gamma", 3)];

  it("floats the space you used most recently to the top", () => {
    const panes = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 100 }),
      agent({ paneId: "w3:p1", workspaceId: "w3", tabId: "w3:t1", lastSeenAt: 900 }),
    ];
    expect(sortSpacesByRecency(spaces, panes).map((w) => w.workspaceId)).toEqual([
      "w3",
      "w1",
      "w2",
    ]);
  });

  it("leaves never-used spaces in Herdr's own order behind the used ones", () => {
    const panes = [agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", lastSeenAt: 5 })];
    expect(sortSpacesByRecency(spaces, panes).map((w) => w.workspaceId)).toEqual([
      "w2",
      "w1",
      "w3",
    ]);
  });

  it("changes nothing at all on a bridge that reports no timestamps", () => {
    const panes = [agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" })];
    expect(sortSpacesByRecency(spaces, panes)).toEqual(spaces);
  });

  it("does not mutate its input", () => {
    const panes = [agent({ paneId: "w3:p1", workspaceId: "w3", tabId: "w3:t1", lastSeenAt: 9 })];
    sortSpacesByRecency(spaces, panes);
    expect(spaces.map((w) => w.workspaceId)).toEqual(["w1", "w2", "w3"]);
  });
});

describe("filterSpaces", () => {
  const spaces = [ws("w1", "moonward_os", 1), ws("w2", "trader", 2), ws("w3", "MOON_probe", 3)];

  it("matches case-insensitively, anywhere in the label", () => {
    expect(filterSpaces(spaces, "moon").map((w) => w.workspaceId)).toEqual(["w1", "w3"]);
    expect(filterSpaces(spaces, "RAD").map((w) => w.workspaceId)).toEqual(["w2"]);
  });

  it("returns everything for an empty or whitespace query", () => {
    expect(filterSpaces(spaces, "")).toHaveLength(3);
    expect(filterSpaces(spaces, "   ")).toHaveLength(3);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterSpaces(spaces, "zzz")).toEqual([]);
  });
});

describe("spaceLastSeenMap", () => {
  it("agrees with spaceLastSeen for every space, in one pass", () => {
    const panes = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 100 }),
      agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 900 }),
      agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", lastSeenAt: 400 }),
    ];
    const map = spaceLastSeenMap(panes);
    for (const id of ["w1", "w2"]) expect(map.get(id)).toBe(spaceLastSeen(id, panes));
  });

  it("omits spaces with no panes, which callers read as 0", () => {
    expect(spaceLastSeenMap([]).get("w1")).toBeUndefined();
  });

  it("gives the same ordering whether or not the map is passed in", () => {
    const spaces = [ws("w1", "alpha", 1), ws("w2", "beta", 2)];
    const panes = [agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", lastSeenAt: 900 })];
    expect(sortSpacesByRecency(spaces, panes, spaceLastSeenMap(panes))).toEqual(
      sortSpacesByRecency(spaces, panes),
    );
  });
});
