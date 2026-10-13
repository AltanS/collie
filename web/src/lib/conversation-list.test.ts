import { describe, expect, it } from "vitest";

import {
  groupConversations,
  mergeConversations,
  passesFilter,
  type ConversationFilter,
} from "./conversation-list";
import type { AgentView, Ask, DurableConversationRow } from "./types";

// M53 spec 12: the durable home's list, merged from the snapshot's live panes and the program's own list.

const pane = (paneId: string, over: Partial<AgentView> = {}): AgentView => ({
  paneId,
  workspaceId: "w1",
  workspaceLabel: "support",
  workspaceNumber: 1,
  tabId: `${paneId}:t`,
  agent: "pi",
  status: "idle",
  cwd: "",
  focused: false,
  paneLabel: `pane ${paneId}`,
  ...over,
});

const row = (id: string, over: Partial<DurableConversationRow> = {}): DurableConversationRow => ({
  id,
  title: `row ${id}`,
  startedAt: "2026-10-13T08:00:00Z",
  state: "closed",
  items: 3,
  ...over,
});

const T = (iso: string) => Date.parse(iso);

describe("conversation list: merge", () => {
  it("conversation list: draws the live panes alone until the program's list arrives", () => {
    const items = mergeConversations([pane("p1", { status: "working" }), pane("p2")], null);
    expect(items.map((item) => item.title)).toEqual(["pane p1", "pane p2"]);
    expect(items[0]).toMatchObject({ state: "working", items: null, id: undefined, key: "pane:p1" });
  });

  it("conversation list: one row per conversation, the pane's state with the program's count", () => {
    const items = mergeConversations(
      [pane("p1", { status: "blocked", subtitle: "login fails", lastActiveAt: T("2026-10-13T10:00:00Z") })],
      [row("c1", { state: "open", paneId: "p1", items: 12, title: "the program's title" }), row("c0")],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ key: "c1", id: "c1", title: "pane p1", subtitle: "login fails", state: "waiting", items: 12 });
    expect(items[0]!.pane?.paneId).toBe("p1");
    expect(items[1]).toMatchObject({ key: "c0", state: "closed", pane: undefined, items: 3 });
  });

  it("conversation list: open ones first, then closed, each newest first", () => {
    const items = mergeConversations(
      [pane("old", { lastActiveAt: T("2026-10-13T07:00:00Z") }), pane("new", { lastActiveAt: T("2026-10-13T11:00:00Z") })],
      [
        row("c-early", { startedAt: "2026-10-12T08:00:00Z", endedAt: "2026-10-12T09:00:00Z" }),
        row("c-late", { startedAt: "2026-10-13T08:00:00Z", endedAt: "2026-10-13T12:00:00Z" }),
      ],
    );
    expect(items.map((item) => item.key)).toEqual(["pane:new", "pane:old", "c-late", "c-early"]);
  });

  it("conversation list: an open ask waits on a person even while the pane works", () => {
    const ask: Ask = { id: "a1", kind: "permission", toolCallId: "c1", revision: 1, title: "Run it?", itemId: "i1", options: [] };
    const [item] = mergeConversations([pane("p1", { status: "working", asks: [ask, ask] })], null);
    expect(item).toMatchObject({ state: "waiting", asks: 2 });
  });

  it("conversation list: an open conversation the snapshot does not show reads as idle, and a shell is no row", () => {
    const items = mergeConversations([pane("s1", { kind: "shell" })], [row("c1", { state: "open", paneId: "gone" })]);
    expect(items.map((item) => [item.key, item.state])).toEqual([["c1", "idle"]]);
  });
});

describe("conversation list: filter chips", () => {
  const items = mergeConversations(
    [pane("w", { status: "working" }), pane("b", { status: "blocked" }), pane("i")],
    [row("c1")],
  );
  const keys = (filter: ConversationFilter) => items.filter((item) => passesFilter(item, filter)).map((item) => item.key).toSorted();

  it("conversation list: All, Open, Needs you and Closed", () => {
    expect(keys("all")).toEqual(["c1", "pane:b", "pane:i", "pane:w"]);
    expect(keys("open")).toEqual(["pane:b", "pane:i", "pane:w"]);
    expect(keys("needsYou")).toEqual(["pane:b"]);
    expect(keys("closed")).toEqual(["c1"]);
  });
});

describe("conversation list: workspaces", () => {
  it("conversation list: one workspace draws one group with no heading", () => {
    const items = mergeConversations([pane("p1"), pane("p2")], null);
    expect(groupConversations(items, [{ workspaceId: "w1", label: "support" }])).toEqual([{ key: "", label: null, items }]);
  });

  it("conversation list: more than one workspace groups by it, newest group first, unplaced rows last", () => {
    const items = mergeConversations(
      [pane("p1", { workspaceId: "w2", lastActiveAt: 3 }), pane("p2", { lastActiveAt: 2 })],
      [row("c1", { workspaceId: undefined })],
    );
    const groups = groupConversations(items, [
      { workspaceId: "w1", label: "support" },
      { workspaceId: "w2", label: "billing" },
    ]);
    expect(groups.map((group) => [group.label, group.items.map((item) => item.key)])).toEqual([
      ["billing", ["pane:p1"]],
      ["support", ["pane:p2"]],
      [null, ["c1"]],
    ]);
  });
});
