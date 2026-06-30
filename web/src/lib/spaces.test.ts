import { blockedCount, groupPanesByTab, worstSpaceStatus } from "./spaces";
import type { AgentStatus, AgentView, TabView } from "./types";

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
  const tabs = [tab("w1:t2", "w1", 2), tab("w1:t1", "w1", 1)]; // deliberately out of order

  it("groups panes by tab in tab-number order", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const a2 = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t2" });
    const groups = groupPanesByTab("w1", tabs, [a1, a2], []);
    expect(groups.map((g) => g.tabId)).toEqual(["w1:t1", "w1:t2"]);
    expect(groups[0]!.panes).toEqual([a1]);
    expect(groups[1]!.panes).toEqual([a2]);
  });

  it("includes shell panes alongside agents in their tab", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const shell = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", kind: "shell" });
    const [first] = groupPanesByTab("w1", tabs, [a1], [shell]);
    expect(first!.panes).toEqual([a1, shell]);
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
