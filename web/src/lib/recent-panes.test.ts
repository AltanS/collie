import type { AgentView } from "./types";
import { paneRowKey } from "./hosts";
import { __reloadRecentPanes, currentRecentPanes, forgetRecentPanes, MAX_RECENT, recentLivePanes, rememberRecentPane } from "./recent-panes";

// THE PANES THIS DEVICE OPENED LAST, for the Actions palette's Recent rows (ADR 0165).

function pane(id: string, space = "webapp"): AgentView {
  return {
    paneId: `w1:${id}`,
    workspaceId: "w1",
    workspaceLabel: space,
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/webapp",
    focused: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  forgetRecentPanes();
});

describe("recent panes", () => {
  it("keeps the newest first, and moves a shown pane to the front", () => {
    rememberRecentPane(pane("a"), 1);
    rememberRecentPane(pane("b"), 2);
    rememberRecentPane(pane("a"), 3);
    expect(currentRecentPanes().map((r) => r.row)).toEqual([paneRowKey(pane("a")), paneRowKey(pane("b"))]);
  });

  it("keeps at most MAX_RECENT records", () => {
    for (let i = 0; i < MAX_RECENT + 3; i += 1) rememberRecentPane(pane(`p${i}`), i);
    expect(currentRecentPanes()).toHaveLength(MAX_RECENT);
  });

  it("is stored on the device and read back after a reload", () => {
    rememberRecentPane(pane("a"), 1);
    expect(localStorage.getItem("collie:recent-panes:v1")).not.toBeNull();
    __reloadRecentPanes();
    expect(currentRecentPanes().map((r) => r.row)).toEqual([paneRowKey(pane("a"))]);
  });

  it("writes nothing when the front pane is shown again", () => {
    rememberRecentPane(pane("a"), 1);
    const before = localStorage.getItem("collie:recent-panes:v1");
    rememberRecentPane(pane("a"), 99);
    expect(localStorage.getItem("collie:recent-panes:v1")).toBe(before);
  });

  it("leaves out the open pane, a pane that is gone, and a reused id in another space", () => {
    for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) rememberRecentPane(pane(id), i);
    const live = [pane("a"), pane("b", "elsewhere"), pane("d"), pane("e")];
    const out = recentLivePanes({ recent: currentRecentPanes(), panes: live, hereKey: paneRowKey(pane("e")), limit: 4 });
    expect(out.map((p) => p.paneId)).toEqual(["w1:d", "w1:a"]);
  });

  it("is forgotten by the wipe", () => {
    rememberRecentPane(pane("a"), 1);
    forgetRecentPanes();
    expect(currentRecentPanes()).toEqual([]);
    expect(localStorage.getItem("collie:recent-panes:v1")).toBeNull();
  });
});
