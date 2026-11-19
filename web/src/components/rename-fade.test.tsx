import { render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { ReactElement } from "react";

import { CROSSFADE_QUIET_MS } from "./ui/crossfade-text";
import { AgentCard } from "./agent-card";
import { AgentList } from "./agent-list";
import { ThreadSidebar } from "./agent-sidebar";
import { PaneActionsSheet } from "./pane-actions-sheet";
import { PaneStrip } from "./pane-strip";
import { ColumnHeader } from "./strip-column";
import { SpaceOverview } from "./space-overview";
import { SpaceStrip } from "./space-strip";
import { SpaceView } from "./space-view";
import { TabStrip } from "./tab-strip";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";

// THE NAME FADE AT EVERY PLACE A RENAME SHOWS (ui/crossfade-text.tsx). Each case mounts one surface,
// renames ONE item (same id, new words) and reads that the old words are still drawn as the aria-hidden
// outgoing copy beside the new ones: the crossfade path. A second case per kind shows another item
// taking the same place swaps at once. The primitive's own cases are in ui/crossfade-text.test.tsx.

const pane = (over: Partial<AgentView> = {}): AgentView => ({
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  tabLabel: "review",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/webapp",
  focused: false,
  paneLabel: "plumbing",
  ...over,
});

const space = (over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  workspaceId: "w1",
  number: 1,
  label: "webapp",
  focused: false,
  activeTabId: "w1:t1",
  tabCount: 1,
  paneCount: 1,
  ...over,
});

const tab = (over: Partial<TabView> = {}): TabView => ({
  tabId: "w1:t1",
  workspaceId: "w1",
  number: 1,
  label: "review",
  focused: true,
  paneCount: 1,
  ...over,
});

/** The outgoing copies on screen, as their words. They are all `aria-hidden`. */
function outgoing(root: ParentNode = document.body): string[] {
  const copies = [...root.querySelectorAll<HTMLElement>('[data-slot="crossfade-out"]')];
  for (const copy of copies) expect(copy).toHaveAttribute("aria-hidden", "true");
  return copies.map((copy) => copy.textContent ?? "");
}

// A name fades only when it has held still for the quiet time (ui/crossfade-text.tsx), so the clock is
// faked and moved past it between the mount and the rename.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Mount `before`, let the names hold still, swap to `after` in place, and say what is fading out. */
function rename(before: ReactElement, after: ReactElement): string[] {
  const { container, rerender } = render(before);
  expect(outgoing(container)).toEqual([]);
  vi.setSystemTime(Date.now() + CROSSFADE_QUIET_MS);
  rerender(after);
  return outgoing(container);
}

describe("a dashboard or space row", () => {
  it("fades a renamed pane, its Space and its tab", () => {
    const old = pane();
    const next = pane({ paneLabel: "wiring", workspaceLabel: "frontend", tabLabel: "qa" });
    const out = rename(<AgentCard agent={old} onClick={() => {}} />, <AgentCard agent={next} onClick={() => {}} />);
    expect(out).toEqual(expect.arrayContaining(["plumbing", "webapp", "review"]));
    expect(out).toHaveLength(3);
  });

  it("swaps at once when the row now shows another pane", () => {
    const out = rename(
      <AgentCard agent={pane()} onClick={() => {}} />,
      <AgentCard agent={pane({ paneId: "w1:p2", paneLabel: "wiring" })} onClick={() => {}} />,
    );
    expect(out).toEqual([]);
  });

  it("does not fade a live title or a folder path: they are not names someone gave", () => {
    const old = pane({ paneLabel: undefined, soleTabName: "review", terminalTitle: "one" });
    const next = pane({ paneLabel: undefined, soleTabName: "review", terminalTitle: "two" });
    const out = rename(<AgentCard agent={old} onClick={() => {}} />, <AgentCard agent={next} onClick={() => {}} />);
    expect(out).toEqual([]);
  });
});

describe("the dashboard's Space heading", () => {
  it("fades a renamed Space", () => {
    const out = rename(
      <AgentList agents={[pane({ paneLabel: "a" })]} onOpen={() => {}} />,
      <AgentList agents={[pane({ paneLabel: "a", workspaceLabel: "frontend" })]} onOpen={() => {}} />,
    );
    expect(out).toContain("webapp");
  });
});

describe("the pane switcher", () => {
  it("fades a renamed pane, its Space (row and heading) and its tab", () => {
    const old = pane();
    const next = pane({ paneLabel: "wiring", workspaceLabel: "frontend", tabLabel: "qa" });
    const out = rename(
      <ThreadSidebar agents={[old]} currentPaneKey="" onSelect={() => {}} />,
      <ThreadSidebar agents={[next]} currentPaneKey="" onSelect={() => {}} />,
    );
    expect(out).toEqual(expect.arrayContaining(["plumbing", "webapp", "review"]));
  });
});

describe("the tab strip", () => {
  it("fades a renamed tab, and not a tab that is another one", () => {
    const strip = (label: string, tabId: string) => (
      <TabStrip workspaceId="w1" tabs={[tab({ label, tabId })]} agents={[]} selected={null} onSelect={() => {}} onNewTab={() => {}} />
    );
    expect(rename(strip("review", "w1:t1"), strip("qa", "w1:t1"))).toEqual(["review"]);
    expect(rename(strip("review", "w1:t1"), strip("qa", "w1:t9"))).toEqual([]);
  });
});

describe("the space strip", () => {
  it("fades a renamed Space chip", () => {
    const strip = (label: string) => (
      <SpaceStrip workspaces={[space({ label })]} agents={[]} selected={null} onSelect={() => {}} onNewSpace={() => {}} />
    );
    expect(rename(strip("webapp"), strip("frontend"))).toEqual(["webapp"]);
  });
});

describe("the space list", () => {
  it("fades a renamed Space row", () => {
    const list = (label: string) => (
      <SpaceOverview workspaces={[space({ label })]} agents={[]} onOpen={() => {}} onNewSpace={() => {}} open onOpenChange={() => {}} />
    );
    expect(rename(list("webapp"), list("frontend"))).toEqual(["webapp"]);
  });
});

describe("the space view", () => {
  it("fades a renamed Space heading and a renamed tab heading", () => {
    const view = (label: string, tabLabel: string) => (
      <SpaceView
        workspace={space({ label })}
        tabs={[tab({ label: tabLabel })]}
        agents={[]}
        shellPanes={[]}
        selectedTab={null}
        onOpen={() => {}}
      />
    );
    const out = rename(view("webapp", "review"), view("frontend", "qa"));
    expect(out).toEqual(expect.arrayContaining(["webapp", "review"]));
  });
});

describe("the pane strip", () => {
  it("fades a renamed pane pill", () => {
    const strip = (label: string) => (
      <PaneStrip panes={[pane({ paneLabel: label }), pane({ paneId: "w1:p2", paneLabel: "other" })]} currentPaneId="w1:p1" onSelect={() => {}} />
    );
    expect(rename(strip("plumbing"), strip("wiring"))).toEqual(["plumbing"]);
  });
});

describe("a column header on a wide screen", () => {
  it("fades a renamed pane", () => {
    const head = (label: string) => <ColumnHeader pane={pane({ paneLabel: label })} controls={null} onFocus={() => {}} />;
    expect(rename(head("plumbing"), head("wiring"))).toEqual(["plumbing"]);
  });
});

describe("the pane actions sheet", () => {
  it("fades the pane's name in its title", () => {
    const sheet = (label: string) => (
      <PaneActionsSheet open onClose={() => {}} pane={pane({ paneLabel: label })} onRenamed={() => {}} onClosed={() => {}} />
    );
    expect(rename(sheet("plumbing"), sheet("wiring"))).toContain("plumbing");
  });
});
