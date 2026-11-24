import { paneRowKey } from "./hosts";
import { herdHasTree, paneRole, paneTree, treeLayout, treeRows } from "./pane-tree";
import type { AgentView, PaneTree } from "./types";

function pane(paneId: string, tree?: PaneTree, host?: string): AgentView {
  const view: AgentView = {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "work",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/srv/work",
    focused: false,
  };
  if (host !== undefined) view.host = host;
  if (tree !== undefined) view.tree = tree;
  return view;
}

const ids = (rows: readonly AgentView[]) => rows.map((p) => p.paneId);

describe("paneTree", () => {
  it("keeps a well-formed tree and drops what a peer sent malformed", () => {
    expect(paneTree(pane("a", { id: "n1", parent: "n0", role: " worker " }))).toEqual({ id: "n1", parent: "n0", role: "worker" });
    expect(paneTree(pane("a"))).toBeNull();
    expect(paneTree(pane("a", { role: "worker" }))).toBeNull();
    expect(paneTree(pane("a", { id: "host/w1:p1" }))).toBeNull();
    expect(paneTree(pane("a", { id: "n1", parent: "n1" }))).toEqual({ id: "n1" });
    expect(paneTree(JSON.parse('{"tree":"nonsense"}'))).toBeNull();
    expect(paneRole(pane("a", { id: "n1", role: "x".repeat(25) }))).toBeNull();
  });

  it("offers the order only when some pane is in a tree", () => {
    expect(herdHasTree([pane("a"), pane("b")])).toBe(false);
    expect(herdHasTree([pane("a"), pane("b", { parent: "n0" })])).toBe(true);
  });
});

describe("treeLayout", () => {
  it("puts each child under its starter, then the panes in no tree", () => {
    const panes = [
      pane("plain"),
      pane("w1", { id: "w1", parent: "c1", role: "worker" }),
      pane("c1", { id: "c1", role: "coordinator" }),
      pane("w2", { id: "w2", parent: "c1" }),
      pane("r1", { parent: "w1", role: "reviewer" }),
    ];
    const { rows, depth } = treeLayout(panes);
    expect(ids(rows)).toEqual(["c1", "w1", "r1", "w2", "plain"]);
    expect(rows.map((p) => depth.get(paneRowKey(p)))).toEqual([0, 1, 2, 1, 0]);
  });

  it("finds a starter on another machine by id alone", () => {
    const { rows, depth } = treeLayout([pane("w1:p1", { parent: "c1" }, "laptop"), pane("w9:p1", { id: "c1" }, "server")]);
    expect(ids(rows)).toEqual(["w9:p1", "w1:p1"]);
    expect(depth.get(paneRowKey(rows[1]!))).toBe(1);
  });

  it("a child whose starter is gone is a root of its own and keeps its row", () => {
    const { rows, depth } = treeLayout([pane("a", { parent: "gone" }), pane("b")]);
    expect(ids(rows)).toEqual(["a", "b"]);
    expect(depth.get(paneRowKey(rows[0]!))).toBe(0);
  });

  it("draws a cycle once and never loops", () => {
    const { rows } = treeLayout([pane("a", { id: "a", parent: "b" }), pane("b", { id: "b", parent: "a" }), pane("c")]);
    expect(ids(rows)).toEqual(["a", "b", "c"]);
  });

  it("gives a shared id to the first pane in place order", () => {
    const { rows } = treeLayout([pane("first", { id: "dup" }), pane("second", { id: "dup" }), pane("kid", { parent: "dup" })]);
    expect(ids(rows)).toEqual(["first", "kid", "second"]);
  });

  it("keeps place order with no tree at all", () => {
    expect(ids(treeLayout([pane("b"), pane("a"), pane("c")]).rows)).toEqual(["b", "a", "c"]);
  });
});

describe("treeRows", () => {
  const a = pane("a", { id: "a" });
  const b = pane("b", { parent: "a" });
  const c = pane("c");

  it("puts a pinned pane back in place order among the rows the filters left", () => {
    expect(ids(treeRows([a, c], [b], [a, b, c]))).toEqual(["a", "b", "c"]);
  });

  it("is the shown rows when nothing pinned is missing from them", () => {
    expect(ids(treeRows([a, b, c], [b], [a, b, c]))).toEqual(["a", "b", "c"]);
    expect(ids(treeRows([c, a], [], [a, b, c]))).toEqual(["c", "a"]);
  });
});
