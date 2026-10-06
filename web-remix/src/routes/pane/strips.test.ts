/// <reference types="bun" />
// The pane screen's strips, as pure helpers: which rows draw, the fold chevron's and the bar's
// names, the bead status of a tab, and where a tap on a tab goes. The DOM half is covered by the
// pane e2e specs.
import { describe, expect, test } from "bun:test";

import type { AgentView, TabView } from "@web/lib/types";

import { firstPaneOfTab, foldLabelKey, spaceTabs, stripsExist, tabBeadStatus } from "./strips";

function pane(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/proj",
    focused: false,
    ...extra,
  };
}

function tab(tabId: string, extra: Partial<TabView> = {}): TabView {
  return { tabId, workspaceId: "w1", number: 1, label: "1", focused: false, paneCount: 1, ...extra };
}

describe("stripsExist", () => {
  const here = pane("w1:p1");
  test("a space with tabs always has a band, even for one pane", () => {
    expect(stripsExist(here, [tab("w1:t1")], [here])).toBe(true);
  });
  test("no tabs and one pane draws nothing", () => {
    expect(stripsExist(here, [], [here])).toBe(false);
  });
  test("no tabs but two panes still draws the pane row", () => {
    expect(stripsExist(here, [], [here, pane("w1:p2")])).toBe(true);
  });
  test("another space's tabs are not this band's", () => {
    expect(stripsExist(here, [tab("w2:t1", { workspaceId: "w2" })], [here])).toBe(false);
  });
});

describe("spaceTabs", () => {
  test("keeps the snapshot order and drops other spaces", () => {
    const rows = [tab("w1:t2"), tab("w2:t1", { workspaceId: "w2" }), tab("w1:t1")];
    expect(spaceTabs(pane("w1:p1"), rows).map((r) => r.tabId)).toEqual(["w1:t2", "w1:t1"]);
  });
  test("a tab on another machine is not this space's, an untagged one is ambient", () => {
    const rows = [tab("w1:t1", { host: "peer" }), tab("w1:t2"), tab("w1:t3", { host: "lead" })];
    expect(spaceTabs(pane("w1:p1", { host: "lead" }), rows).map((r) => r.tabId)).toEqual(["w1:t2", "w1:t3"]);
  });
});

describe("foldLabelKey", () => {
  test("names both rows only when both are drawn", () => {
    expect(foldLabelKey(3, 2)).toBe("chat.strips.hide.both");
  });
  test("a lone pane has no pane row to hide", () => {
    expect(foldLabelKey(3, 1)).toBe("chat.strips.hide.tabs");
  });
  test("no tabs leaves the pane row", () => {
    expect(foldLabelKey(0, 2)).toBe("chat.strips.hide.panes");
  });
});

describe("tabBeadStatus", () => {
  test("an empty tab is null, not idle", () => {
    expect(tabBeadStatus([pane("w1:p1", { tabId: "w1:t2" })], "w1:t1")).toBeNull();
  });
  test("a blocked agent shows its tab as blocked", () => {
    const panes = [pane("w1:p1", { status: "idle" }), pane("w1:p2", { status: "blocked" })];
    expect(tabBeadStatus(panes, "w1:t1")).toBe("blocked");
  });
});

describe("firstPaneOfTab", () => {
  const first = pane("w1:p1", { tabPosition: 0 });
  const second = pane("w1:p2", { tabPosition: 1 });
  const other = pane("w1:p3", { tabId: "w1:t2", tabPosition: 1 });
  const otherFirst = pane("w1:p4", { tabId: "w1:t2", tabPosition: 0 });
  const shell = pane("w1:p5", { tabId: "w1:t3", kind: "shell" });

  test("the open tab goes nowhere", () => {
    expect(firstPaneOfTab(tab("w1:t1"), first, [first, second], [])).toBeUndefined();
  });
  test("goes to the tab's first pane by position, whatever order the herd arrived in", () => {
    expect(firstPaneOfTab(tab("w1:t2"), first, [first, other, otherFirst], [])?.paneId).toBe("w1:p4");
  });
  test("a tab holding only a shell lands on the shell", () => {
    expect(firstPaneOfTab(tab("w1:t3"), first, [first], [shell])?.paneId).toBe("w1:p5");
  });
  test("an empty tab has no pane to land on", () => {
    expect(firstPaneOfTab(tab("w1:t9"), first, [first], [])).toBeUndefined();
  });
  test("a pane of the same tab id on another machine is not a candidate", () => {
    const peer = pane("w1:p7", { tabId: "w1:t2", host: "peer" });
    expect(firstPaneOfTab(tab("w1:t2"), first, [first, peer], [])).toBeUndefined();
  });
});
