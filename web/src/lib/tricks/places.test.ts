import { describe, expect, it } from "vitest";

import { countBlocked, bucketOf } from "../triage";
import { paneProgress } from "../pane-marks";
import type { AgentView, TabView, WorkspaceView } from "../types";
import { findTrickSession, findScopedPane, splitTrickSessions } from "./places";

function pane(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "collie", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd: "/w", focused: false, ...over };
}

const TRICK = pane("trick:bluefin:legs:legs", {
  workspaceId: "trick:bluefin",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:bluefin:legs",
  agent: "legs",
  kind: "trick",
  status: "working",
  view: "bluefin/legs/legs",
  progress: { kind: "percent", value: 68 },
});
const TRICK2 = { ...TRICK, paneId: "trick:bluefin:legs:second", view: "bluefin/legs/second" };
const REAL = pane("w6X:3");
const SPACES: WorkspaceView[] = [
  { workspaceId: "w1", number: 1, label: "collie", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 },
  { workspaceId: "trick:bluefin", number: 2, label: "Tricks", focused: false, activeTabId: "trick:bluefin:legs", tabCount: 1, paneCount: 1 },
];
const TABS: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 1 },
  { tabId: "trick:bluefin:legs", workspaceId: "trick:bluefin", number: 1, label: "Browser leg", focused: false, paneCount: 1 },
];

describe("the trick sessions leave the herd", () => {
  it("takes the trick panes, their Space and their tabs out of every list, in the bridge's order", () => {
    const split = splitTrickSessions({ agents: [REAL, TRICK, TRICK2], shellPanes: [], workspaces: SPACES, tabs: TABS });
    expect(split.agents).toEqual([REAL]);
    expect(split.trickSessions.map((p) => p.paneId)).toEqual([TRICK.paneId, TRICK2.paneId]);
    expect(split.workspaces.map((w) => w.workspaceId)).toEqual(["w1"]);
    expect(split.tabs.map((t) => t.tabId)).toEqual(["w1:t1"]);
  });

  it("hands back the same arrays for a body with no trick session, so nothing re-renders for it", () => {
    const agents = [REAL];
    const workspaces = SPACES.slice(0, 1);
    const split = splitTrickSessions({ agents, shellPanes: [], workspaces, tabs: TABS });
    expect(split.agents).toBe(agents);
    expect(split.workspaces).toBe(workspaces);
    expect(split.trickSessions).toEqual([]);
  });

  it("keeps a trick pane outside triage even if one slips into a list", () => {
    expect(bucketOf({ ...TRICK, status: "blocked" })).toBe("recent");
    expect(countBlocked([{ ...TRICK, status: "blocked" }])).toBe(0);
  });

  it("draws a trick session's progress in any state, and a program's only while it works", () => {
    expect(paneProgress({ ...TRICK, status: "idle" })).toEqual({ kind: "percent", label: null, value: 68 });
    expect(paneProgress({ ...TRICK, kind: "agent", status: "idle" })).toBeNull();
  });
});

describe("where a link goes", () => {
  it("finds a trick session by its id, and the trick's first session part by the trick alone", () => {
    expect(findTrickSession("trick:bluefin:legs:second", [TRICK, TRICK2])).toBe(TRICK2);
    expect(findTrickSession("trick:bluefin:legs", [TRICK, TRICK2])).toBe(TRICK);
    expect(findTrickSession("trick:bluefin:legs:gone", [TRICK])).toBeUndefined();
    expect(findTrickSession("trick:minibuch:legs", [TRICK])).toBeUndefined();
    expect(findTrickSession("w6X:3", [TRICK])).toBeUndefined();
  });

  it("finds the real pane a scope key names, the bridge's own host matching a pane with no host", () => {
    const peer = pane("w6X:3", { host: "minibuch" });
    expect(findScopedPane("bluefin:w6X:3", [REAL, peer], "bluefin")).toBe(REAL);
    expect(findScopedPane("minibuch:w6X:3", [REAL, peer], "bluefin")).toBe(peer);
    expect(findScopedPane("laptop:w6X:3", [REAL, peer], "bluefin")).toBeUndefined();
    // Never a trick session: it has no reply box.
    expect(findScopedPane("bluefin:trick:bluefin:legs:legs", [TRICK], "bluefin")).toBeUndefined();
  });

  it("finds no pane for a key that is not a scope key: a name, a URL, a script", () => {
    for (const key of ["w6X:3", "composer", "https://a.example/", "javascript:alert(1)", "trick:bluefin:legs"]) expect(findScopedPane(key, [REAL, TRICK], "bluefin"), key).toBeUndefined();
  });
});
