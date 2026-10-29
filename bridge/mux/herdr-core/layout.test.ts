import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "../../types.ts";
import type { WireLayout, WireTerminal } from "./client.ts";
import { agentForApp, agentStatus, IMPLICIT_SPACE_ID, IMPLICIT_TAB_ID, isLocalAddress, toSnapshot } from "./layout.ts";

function terminal(over: Partial<WireTerminal> & { address: string }): WireTerminal {
  return {
    name: "",
    labels: {},
    state: "live",
    cwd: "/home/dev",
    cols: 80,
    rows: 24,
    title: "",
    status: null,
    foreground: { name: "bash", cwd: "/home/dev" },
    ...over,
  };
}

const LAYOUT: WireLayout = {
  spaces: [
    { id: "spA", name: "", folder: "/home/dev", tabs: [{ id: "tbA1", name: "" }, { id: "tbA2", name: "fix login" }, { id: "tbEmpty", name: "" }] },
    { id: "spB", name: "notes", folder: "/home/dev/notes", tabs: [{ id: "tbB1", name: "" }] },
  ],
};

const inSpace = (space: string, tab: string, where = ""): Record<string, string> =>
  where === "" ? { "herdr.space": space, "herdr.tab": tab } : { "herdr.space": space, "herdr.tab": tab, where };

describe("the herdr-core snapshot mapping", () => {
  test("labels place a terminal; the document names and orders spaces and tabs", () => {
    const snapshot = toSnapshot(
      [
        terminal({ address: "t3", labels: inSpace("spB", "tbB1") }),
        terminal({ address: "t1", labels: inSpace("spA", "tbA1", "collie-workspace / 1"), foreground: { name: "bash", cwd: "/home/dev/collie-workspace" } }),
        terminal({ address: "t2", labels: inSpace("spA", "tbA2", "collie-workspace / fix login") }),
      ],
      LAYOUT,
      "/home/dev",
    );
    expect(snapshot.spaces.map((s) => [s.spaceId, s.label, s.number, s.tabCount, s.paneCount])).toEqual([
      ["spA", "collie-workspace", 1, 2, 2],
      ["spB", "notes", 2, 1, 1],
    ]);
    // The empty tab is left out, so the counts are counts of what the snapshot carries.
    expect(snapshot.tabs.map((t) => [t.tabId, t.label, t.number, t.paneCount])).toEqual([
      ["tbA1", "1", 1, 1],
      ["tbA2", "fix login", 2, 1],
      ["tbB1", "1", 1, 1],
    ]);
    const t2 = snapshot.panes.find((pane) => pane.paneId === "t2");
    expect(t2?.tabLabel).toBe("fix login");
    expect(t2?.tabNamed).toBe(true);
    const t1 = snapshot.panes.find((pane) => pane.paneId === "t1");
    expect(t1?.tabLabel).toBeUndefined();
    expect(t1?.cwd).toBe("/home/dev/collie-workspace");
    expect(snapshot.spaces[0]?.folder).toBe("/home/dev");
  });

  test("an unnamed space without a `where` label is named after its first terminal's folder, `~` at home", () => {
    const named = toSnapshot([terminal({ address: "t1", labels: inSpace("spA", "tbA1"), foreground: { name: "bash", cwd: "/home/dev/repo" } })], LAYOUT, "/home/dev");
    expect(named.spaces[0]?.label).toBe("repo");
    const home = toSnapshot([terminal({ address: "t1", labels: inSpace("spA", "tbA1") })], LAYOUT, "/home/dev");
    expect(home.spaces[0]?.label).toBe("~");
  });

  test("ids the document does not know become a space and a tab after the known ones", () => {
    const snapshot = toSnapshot(
      [terminal({ address: "t9", labels: inSpace("spNew", "tbNew") }), terminal({ address: "t1", labels: inSpace("spB", "tbB1") })],
      LAYOUT,
      "/home/dev",
    );
    expect(snapshot.spaces.map((s) => s.spaceId)).toEqual(["spB", "spNew"]);
    expect(snapshot.tabs.map((t) => t.tabId)).toEqual(["tbB1", "tbNew"]);
  });

  test("a terminal herdr-app does not show sits in one implicit space with one tab, also with no document", () => {
    const snapshot = toSnapshot([terminal({ address: "t1" }), terminal({ address: "t2", labels: { "herdr.space": "spA" } })], null, "/home/dev");
    expect(snapshot.spaces).toHaveLength(1);
    expect(snapshot.spaces[0]?.spaceId).toBe(IMPLICIT_SPACE_ID);
    expect(snapshot.spaces[0]?.label).toBe(IMPLICIT_SPACE_ID);
    expect(snapshot.tabs.map((t) => t.tabId)).toEqual([IMPLICIT_TAB_ID]);
    expect(snapshot.panes.map((p) => [p.paneId, p.tabId])).toEqual([
      ["t1", IMPLICIT_TAB_ID],
      ["t2", IMPLICIT_TAB_ID],
    ]);
  });

  test("only live local terminals are panes: another machine's and a finished one are dropped", () => {
    const snapshot = toSnapshot(
      [terminal({ address: "t1" }), terminal({ address: "box/t1" }), terminal({ address: "t2", state: "finished" })],
      null,
      "/home/dev",
    );
    expect(snapshot.panes.map((p) => p.paneId)).toEqual(["t1"]);
    expect(isLocalAddress("t7")).toBe(true);
    expect(isLocalAddress("box/t7")).toBe(false);
    expect(isLocalAddress("")).toBe(false);
  });

  test("the agent comes from the program's own report, never from the foreground process", () => {
    const snapshot = toSnapshot(
      [
        terminal({ address: "t1", status: { state: "blocked", app: "claude-code", kind: "permission" }, foreground: { name: "claude", cwd: "/x" } }),
        terminal({ address: "t2", status: null, foreground: { name: "claude", cwd: "/x" } }),
        terminal({ address: "t3", status: { state: "working", app: "some-other-tool", kind: "" } }),
        terminal({ address: "t4", status: { state: "error", app: "codex", kind: "" } }),
      ],
      null,
      "/home/dev",
    );
    const rows = snapshot.panes.map((p) => [p.paneId, p.agent, p.status, p.foregroundCommand]);
    expect(rows).toEqual([
      ["t1", "claude", "blocked", "claude"],
      ["t2", "shell", "unknown", "claude"],
      ["t3", "shell", "unknown", "bash"],
      ["t4", "codex", "unknown", "bash"],
    ]);
  });

  test("the start name is the pane's label, a printed title is its terminal title, a shell locator is dropped", () => {
    const snapshot = toSnapshot(
      [
        terminal({ address: "t1", name: "review", title: "✳ Reviewing the diff" }),
        terminal({ address: "t2", title: "altan@bluefin:~/projects/x" }),
      ],
      null,
      "/home/dev",
    );
    expect(snapshot.panes[0]?.paneLabel).toBe("review");
    expect(snapshot.panes[0]?.terminalTitle).toBe("Reviewing the diff");
    expect(snapshot.panes[1]?.paneLabel).toBeUndefined();
    expect(snapshot.panes[1]?.terminalTitle).toBeUndefined();
  });

  test("nothing is focused: the core has no focus", () => {
    const snapshot = toSnapshot([terminal({ address: "t1", labels: inSpace("spA", "tbA1") })], LAYOUT, "/home/dev");
    expect(snapshot.panes.every((p) => !p.focused)).toBe(true);
    expect(snapshot.spaces.every((s) => !s.focused)).toBe(true);
    expect(snapshot.tabs.every((t) => !t.focused)).toBe(true);
  });
});

describe("status and app words", () => {
  test.each<[string, AgentStatus]>([
    ["idle", "idle"],
    ["working", "working"],
    ["blocked", "blocked"],
    ["done", "done"],
    ["error", "unknown"],
    ["", "unknown"],
  ])("%s reads as %s", (word, collie) => {
    expect(agentStatus(word)).toBe(collie);
  });

  test.each([
    ["claude-code", "claude"],
    ["Claude-Code", "claude"],
    ["codex", "codex"],
    ["pi", "pi"],
    ["cursor-agent", "cursor"],
    ["gemini-cli", null],
    ["", null],
  ])("app %s is harness %s", (app, harness) => {
    expect(agentForApp(app)).toBe(harness);
  });
});
