import { render } from "@testing-library/react";

import { AgentList } from "./agent-list";
import { ThreadSidebar } from "./agent-sidebar";
import { groupPanesByWorkspace } from "@/lib/pane-groups";
import { panesOfTab } from "@/lib/pane-ordinal";
import { groupPanesByTab } from "@/lib/spaces";
import { STATUS_RANK, type AgentStatus, type AgentView, type ServerSummary, type TabView } from "@/lib/types";

// ONE RULE, EVERY SURFACE: a pane does not move when its state changes (ADR 0063).
//
// The fault this pins was in the bridge, which sorted `agents` status-first, and every client surface
// that kept the bridge's order inherited it: the pane strip, the space view, the switcher, and the
// crew's dashboard groups (a peer whose pane blocked had its groups jump above the lead's). The bridge
// half is pinned in bridge/state-engine.test.ts and bridge/crew/merge.test.ts. This file pins the
// client half, and pins it against the WORST arrival order: every list below is handed over sorted
// status-first, the way the old bridge (or an older peer) sent it, so a surface that still leaned on
// the arrival order would fail here.

const servers: ServerSummary[] = [
  { id: "desk", name: "desk", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
  { id: "alpha", name: "alpha", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
];

const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "one", focused: false, paneCount: 3, host: "desk" },
  { tabId: "w1:t2", workspaceId: "w1", number: 2, label: "two", focused: false, paneCount: 1, host: "desk" },
  { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "one", focused: false, paneCount: 1, host: "desk" },
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "one", focused: false, paneCount: 2, host: "alpha" },
];

function pane(label: string, over: Partial<AgentView> & { paneId: string }): AgentView {
  return {
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/proj",
    focused: false,
    host: "desk",
    paneLabel: label,
    ...over,
  };
}

/** The herd in PLACE order, with a label per pane so every surface's order can be read back by name. */
const HERD: AgentView[] = [
  pane("L-one-a", { paneId: "w1:p1", tabPosition: 0 }),
  pane("L-one-b", { paneId: "w1:p2", tabPosition: 1 }),
  pane("L-two", { paneId: "w1:p3", tabId: "w1:t2", tabPosition: 0 }),
  pane("L-w2", { paneId: "w2:p1", workspaceId: "w2", workspaceLabel: "other", workspaceNumber: 2, tabId: "w2:t1", tabPosition: 0 }),
  pane("P-one-a", { paneId: "w1:p1", host: "alpha", workspaceLabel: "peerproj", tabPosition: 0 }),
  pane("P-one-b", { paneId: "w1:p2", host: "alpha", workspaceLabel: "peerproj", tabPosition: 1 }),
];
const SHELLS: AgentView[] = [
  pane("L-shell", { paneId: "w1:p9", agent: "shell", kind: "shell", status: "unknown", tabPosition: 2 }),
];

/** The same herd with each status replaced, handed over status-first as the old bridge sent it. */
function herdWith(statuses: readonly AgentStatus[]): AgentView[] {
  return HERD.map((p, i) => Object.assign({}, p, { status: statuses[i]! })).toSorted(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
  );
}

const CALM: AgentStatus[] = ["idle", "idle", "idle", "idle", "idle", "idle"];
// Every pane changes: the last ones block, the first ones finish or work. Under status-first order
// this reverses most of the list.
const STORM: AgentStatus[] = ["done", "working", "idle", "blocked", "working", "blocked"];
const UNREAD: Partial<AgentView> = { lastActiveAt: 200, lastSeenAt: 100 };

const labels = (panes: readonly AgentView[]) => panes.map((p) => p.paneLabel);
const lead = (agents: readonly AgentView[]) => agents.filter((a) => a.host === "desk");

/** Each surface's order, read back by pane label. */
function surfaces(agents: AgentView[]) {
  const here = agents.find((a) => a.paneLabel === "L-one-a")!;
  const sidebar = render(
    <ThreadSidebar agents={agents} shellPanes={SHELLS} tabs={tabs} servers={servers} currentPaneKey="" onSelect={vi.fn()} />,
  );
  const switcher = [...sidebar.container.querySelectorAll("button[id^='switch-row-']")].map(
    (b) => agents.find((a) => b.textContent?.includes(a.paneLabel!))?.paneLabel,
  );
  sidebar.unmount();
  const dash = render(
    <AgentList agents={agents} shellPanes={SHELLS} tabs={tabs} servers={servers} onOpen={vi.fn()} />,
  );
  const dashboard = [...dash.container.querySelectorAll("section button")].map(
    (b) => [...agents, ...SHELLS].find((a) => b.textContent?.includes(a.paneLabel!))?.paneLabel,
  );
  dash.unmount();
  return {
    strip: labels(panesOfTab(here, agents, SHELLS)),
    space: groupPanesByTab("w1", tabs.filter((t) => t.host === "desk"), lead(agents), SHELLS, "desk").map((g) =>
      labels(g.panes),
    ),
    groups: groupPanesByWorkspace(agents, SHELLS, { order: "fixed", tabs, servers }).map((g) => [
      g.label,
      labels(g.panes),
    ]),
    switcher,
    dashboard,
  };
}

describe("a pane keeps its place on every surface when its state changes", () => {
  test("the calm herd reads in place order everywhere, the lead's machine first", () => {
    const calm = surfaces(herdWith(CALM));
    // The strip holds this tab on THIS machine only: the peer's panes share the id `w1:t1` and stay out.
    expect(calm.strip).toEqual(["L-one-a", "L-one-b", "L-shell"]);
    expect(calm.space).toEqual([["L-one-a", "L-one-b", "L-shell"], ["L-two"]]);
    expect(calm.groups).toEqual([
      ["proj", ["L-one-a", "L-one-b", "L-shell", "L-two"]],
      ["other", ["L-w2"]],
      ["peerproj", ["P-one-a", "P-one-b"]],
    ]);
    expect(calm.switcher).toEqual(["L-one-a", "L-one-b", "L-two", "L-w2", "P-one-a", "P-one-b"]);
    expect(calm.dashboard).toEqual(["L-one-a", "L-one-b", "L-shell", "L-two", "L-w2", "P-one-a", "P-one-b"]);
  });

  test("a storm of status flips moves nothing", () => {
    expect(surfaces(herdWith(STORM))).toEqual(surfaces(herdWith(CALM)));
  });

  test("an unread completion, and reading it, moves nothing", () => {
    const unread = herdWith(STORM).map((p) => (p.paneLabel === "L-one-a" ? Object.assign({}, p, UNREAD) : p));
    const read = unread.map((p) => (p.paneLabel === "L-one-a" ? Object.assign({}, p, { lastSeenAt: 300 }) : p));
    expect(surfaces(unread)).toEqual(surfaces(herdWith(CALM)));
    expect(surfaces(read)).toEqual(surfaces(herdWith(CALM)));
  });
});
