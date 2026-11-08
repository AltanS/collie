import { describe, expect, it } from "vitest";

import { countBlocked, bucketOf } from "../triage";
import { paneProgress } from "../pane-marks";
import type { AgentView, TabView, WorkspaceView } from "../types";
import { draftPlacement, findModSession, findScopedPane, splitModSessions } from "./places";

function pane(paneId: string, over: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "collie", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd: "/w", focused: false, ...over };
}

const MOD = pane("mod:bluefin:legs:legs", {
  workspaceId: "mod:bluefin",
  workspaceLabel: "Mods",
  workspaceNumber: 2,
  tabId: "mod:bluefin:legs",
  agent: "legs",
  kind: "mod",
  status: "working",
  view: "bluefin/legs/legs",
  progress: { kind: "percent", value: 68 },
});
const MOD2 = { ...MOD, paneId: "mod:bluefin:legs:second", view: "bluefin/legs/second" };
const REAL = pane("w6X:3");
const SPACES: WorkspaceView[] = [
  { workspaceId: "w1", number: 1, label: "collie", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 },
  { workspaceId: "mod:bluefin", number: 2, label: "Mods", focused: false, activeTabId: "mod:bluefin:legs", tabCount: 1, paneCount: 1 },
];
const TABS: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 1 },
  { tabId: "mod:bluefin:legs", workspaceId: "mod:bluefin", number: 1, label: "Browser leg", focused: false, paneCount: 1 },
];

describe("the mod sessions leave the herd", () => {
  it("takes the mod panes, their Space and their tabs out of every list, in the bridge's order", () => {
    const split = splitModSessions({ agents: [REAL, MOD, MOD2], shellPanes: [], workspaces: SPACES, tabs: TABS });
    expect(split.agents).toEqual([REAL]);
    expect(split.modSessions.map((p) => p.paneId)).toEqual([MOD.paneId, MOD2.paneId]);
    expect(split.workspaces.map((w) => w.workspaceId)).toEqual(["w1"]);
    expect(split.tabs.map((t) => t.tabId)).toEqual(["w1:t1"]);
  });

  it("hands back the same arrays for a body with no mod session, so nothing re-renders for it", () => {
    const agents = [REAL];
    const workspaces = SPACES.slice(0, 1);
    const split = splitModSessions({ agents, shellPanes: [], workspaces, tabs: TABS });
    expect(split.agents).toBe(agents);
    expect(split.workspaces).toBe(workspaces);
    expect(split.modSessions).toEqual([]);
  });

  it("keeps a mod pane outside triage even if one slips into a list", () => {
    expect(bucketOf({ ...MOD, status: "blocked" })).toBe("recent");
    expect(countBlocked([{ ...MOD, status: "blocked" }])).toBe(0);
  });

  it("draws a mod session's progress in any state, and a program's only while it works", () => {
    expect(paneProgress({ ...MOD, status: "idle" })).toEqual({ kind: "percent", label: null, value: 68 });
    expect(paneProgress({ ...MOD, kind: "agent", status: "idle" })).toBeNull();
  });
});

describe("where an open and a draft go", () => {
  it("finds a mod session by its id, and the mod's first session part by the mod alone", () => {
    expect(findModSession("mod:bluefin:legs:second", [MOD, MOD2])).toBe(MOD2);
    expect(findModSession("mod:bluefin:legs", [MOD, MOD2])).toBe(MOD);
    expect(findModSession("mod:bluefin:legs:gone", [MOD])).toBeUndefined();
    expect(findModSession("mod:minibuch:legs", [MOD])).toBeUndefined();
    expect(findModSession("w6X:3", [MOD])).toBeUndefined();
  });

  it("finds the real pane a scope key names, the bridge's own host matching a pane with no host", () => {
    const peer = pane("w6X:3", { host: "minibuch" });
    expect(findScopedPane("bluefin:w6X:3", [REAL, peer], "bluefin")).toBe(REAL);
    expect(findScopedPane("minibuch:w6X:3", [REAL, peer], "bluefin")).toBe(peer);
    expect(findScopedPane("laptop:w6X:3", [REAL, peer], "bluefin")).toBeUndefined();
    // Never a mod session: it has no reply box.
    expect(findScopedPane("bluefin:mod:bluefin:legs:legs", [MOD], "bluefin")).toBeUndefined();
  });

  it("places a draft only in an empty box", () => {
    expect(draftPlacement(null, REAL)).toBe("placed");
    expect(draftPlacement("  \n", REAL)).toBe("placed");
    expect(draftPlacement("half a thought", REAL)).toBe("box-has-text");
    expect(draftPlacement("", undefined)).toBe("no-session");
  });
});
