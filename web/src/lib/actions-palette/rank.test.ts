import type { AgentView } from "@/lib/types";

import { neverFirst, searchPalette, type CommandEntry } from "./rank";

// THE TYPED LIST of the Actions palette (ADR 0165): one ranked list of commands, spaces and panes.

function pane(id: string, label: string, extra: Partial<AgentView> = {}): AgentView {
  return {
    paneId: `w1:${id}`,
    workspaceId: "w1",
    workspaceLabel: "webapp",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/webapp",
    focused: false,
    paneLabel: label,
    ...extra,
  };
}

const command = (id: CommandEntry["id"], label: string, destructive = false): CommandEntry => ({ id, label, destructive });

describe("searchPalette", () => {
  it("returns nothing for an empty field", () => {
    expect(searchPalette({ query: "  ", commands: [command("find", "Find in output")], spaces: [], panes: [] })).toEqual([]);
  });

  it("on a tie puts a command before a space, and a space before a pane", () => {
    const hits = searchPalette({
      query: "deploy",
      commands: [command("new_tab", "Deploy")],
      spaces: [{ key: "w9", label: "Deploy" }],
      panes: [pane("p1", "Deploy")],
    });
    expect(hits.map((hit) => hit.kind)).toEqual(["command", "space", "pane"]);
  });

  it("puts a better match first, whatever its kind", () => {
    const hits = searchPalette({
      query: "zen",
      commands: [command("new_tab", "New tab, frozen")],
      spaces: [],
      panes: [pane("p1", "zen")],
    });
    expect(hits[0]?.kind).toBe("pane");
  });

  it("marks the matched letters of a command", () => {
    const [hit] = searchPalette({ query: "find", commands: [command("find", "Find in output")], spaces: [], panes: [] });
    expect(hit?.kind === "command" ? hit.marks : undefined).toEqual([[0, 4]]);
  });

  it("never opens on a destructive row, even when it matches best", () => {
    const hits = searchPalette({
      query: "close",
      commands: [command("close_pane", "Close pane", true), command("open_crew", "Open Crew, closed rooms")],
      spaces: [],
      panes: [],
    });
    expect(hits[0]?.destructive).toBe(false);
    expect(hits.some((hit) => hit.kind === "command" && hit.command.id === "close_pane")).toBe(true);
  });
});

describe("neverFirst", () => {
  it("brings the first safe row to the front and keeps the rest in order", () => {
    const rows = [
      { id: "a", destructive: true },
      { id: "b", destructive: true },
      { id: "c", destructive: false },
      { id: "d", destructive: false },
    ];
    expect(neverFirst(rows).map((row) => row.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("leaves a list with no safe row as it is", () => {
    const rows = [{ id: "a", destructive: true }];
    expect(neverFirst(rows)).toEqual(rows);
  });
});
