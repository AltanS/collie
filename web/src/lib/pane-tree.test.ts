import { paneRowKey } from "./hosts";
import { foldedAncestors, foldTree, herdHasTree, paneRole, paneTree, treeLayout, treeRelatives, treeRows, unfoldPath } from "./pane-tree";
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

describe("foldTree", () => {
  const waiting = (p: AgentView) => p.status === "blocked";
  const herd = [
    pane("c", { id: "c" }),
    pane("w1", { id: "w1", parent: "c" }),
    pane("r", { parent: "w1" }),
    pane("w2", { parent: "c" }),
    pane("plain"),
  ];
  herd[2]!.status = "blocked";
  const layout = treeLayout(herd);

  it("draws every row, each branch marked, when nothing is folded", () => {
    const rows = foldTree(layout, new Set(), waiting);
    expect(rows.map((r) => [r.pane.paneId, r.depth, r.branch])).toEqual([
      ["c", 0, "c"],
      ["w1", 1, "w1"],
      ["r", 2, null],
      ["w2", 1, null],
      ["plain", 0, null],
    ]);
  });

  it("a folded branch draws its starter alone and counts what it hides, waiting at any depth", () => {
    const rows = foldTree(layout, new Set(["c"]), waiting);
    expect(rows.map((r) => r.pane.paneId)).toEqual(["c", "plain"]);
    expect(rows[0]).toMatchObject({ folded: true, hidden: 3, waiting: 1 });
  });

  it("a folded inner branch leaves its siblings drawn", () => {
    const rows = foldTree(layout, new Set(["w1"]), waiting);
    expect(rows.map((r) => r.pane.paneId)).toEqual(["c", "w1", "w2", "plain"]);
    expect(rows[1]).toMatchObject({ folded: true, hidden: 1, waiting: 1 });
  });

  it("a fold on a leaf or an unknown id changes nothing", () => {
    expect(foldTree(layout, new Set(["w2", "gone"]), waiting).map((r) => r.pane.paneId)).toEqual(["c", "w1", "r", "w2", "plain"]);
  });

  it("opening a branch opens the folded branches on the way to a waiting pane, and no others", () => {
    expect(unfoldPath(layout, "c", waiting)).toEqual(["c", "w1"]);
    expect(unfoldPath(layout, "w1", waiting)).toEqual(["w1"]);
    expect(unfoldPath(layout, "gone", waiting)).toEqual(["gone"]);
  });
});

describe("treeRelatives", () => {
  const herd = [
    pane("c", { id: "c" }),
    pane("w1", { id: "w1", parent: "c" }),
    pane("r", { parent: "w1" }),
    pane("w2", { id: "w2", parent: "c" }),
    pane("w3", { parent: "c" }),
    pane("c2", { id: "c2" }),
    pane("plain"),
  ];
  const layout = treeLayout(herd);
  const rel = (id: string) => {
    const r = treeRelatives(layout, herd.find((p) => p.paneId === id)!);
    return { parent: r.parent?.paneId ?? null, children: ids(r.children), previous: r.previous?.paneId ?? null, next: r.next?.paneId ?? null };
  };

  it("names the parent, the children and the siblings in tree order", () => {
    expect(rel("w2")).toEqual({ parent: "c", children: [], previous: "w1", next: "w3" });
    expect(rel("w1")).toEqual({ parent: "c", children: ["r"], previous: null, next: "w2" });
    expect(rel("r")).toEqual({ parent: "w1", children: [], previous: null, next: null });
  });

  it("a tree top has the other tree tops as siblings, and a pane in no tree has no relatives", () => {
    expect(rel("c")).toEqual({ parent: null, children: ["w1", "w2", "w3"], previous: null, next: "c2" });
    expect(rel("c2")).toEqual({ parent: null, children: [], previous: "c", next: null });
    expect(rel("plain")).toEqual({ parent: null, children: [], previous: null, next: null });
  });

  it("names the folded ancestors a move has to open", () => {
    const r = herd.find((p) => p.paneId === "r")!;
    expect(foldedAncestors(layout, r, new Set(["c", "w1"]))).toEqual(["w1", "c"]);
    expect(foldedAncestors(layout, r, new Set())).toEqual([]);
  });
});
