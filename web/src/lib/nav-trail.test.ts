import { createTrail, findCrumbBase, findCrumbPop, fromOutsideTree, resolveCrumb, TRAIL_CAP, TRAIL_KEY, type TrailEntries } from "./nav-trail";

const root = "/pane/w1/changes";
const dir = (d: string) => `/pane/w1/changes/files?dir=${d}`;
const file = (p: string) => `/pane/w1/changes/files?path=${p}`;

/** A trail whose entries sit at index 0, 1, 2 ... in the order given. */
const stack = (...hrefs: string[]): TrailEntries => new Map(hrefs.map((href, idx) => [idx, href]));

describe("findCrumbPop", () => {
  const walk = stack("/pane/w1", root, dir("a"), dir("a/b"), dir("a/b/c"));

  it("counts the entries back to an ancestor folder", () => {
    expect(findCrumbPop(walk, 4, dir("a/b"))).toBe(1);
    expect(findCrumbPop(walk, 4, dir("a"))).toBe(2);
    expect(findCrumbPop(walk, 4, root)).toBe(3);
  });

  it("takes the old address of the root for the root", () => {
    expect(findCrumbPop(stack("/pane/w1", "/pane/w1/changes/files", dir("a")), 2, root)).toBe(1);
  });

  it("pops from a file to its folders too", () => {
    expect(findCrumbPop(stack("/pane/w1", root, dir("a"), file("a/b.md")), 3, dir("a"))).toBe(1);
  });

  it("is null when the folder is not behind us", () => {
    expect(findCrumbPop(walk, 4, dir("x"))).toBeNull();
    // The root is a crumb of a cold deep link: the entry behind is the pane, which is not in the tree.
    expect(findCrumbPop(stack("/pane/w1", dir("a/b")), 1, root)).toBeNull();
  });

  it("stops at an entry that is not inside the target's subtree", () => {
    // root, a, other, a/b: the pane's own `a` is behind `other`, and a pop would skip it.
    expect(findCrumbPop(stack(root, dir("a"), dir("x"), dir("a/b")), 3, dir("a"))).toBeNull();
    // A diff in between is another screen.
    expect(findCrumbPop(stack(dir("a"), "/pane/w1/changes?repo=.&path=a.ts", dir("a/b")), 2, dir("a"))).toBeNull();
  });

  it("does not cross to another pane, another space or another machine", () => {
    expect(findCrumbPop(stack("/pane/w2/changes", dir("a/b")), 1, root)).toBeNull();
    expect(findCrumbPop(stack(`${root}?h=peer`, dir("a")), 1, root)).toBeNull();
    expect(findCrumbPop(stack("/space/w1/changes", dir("a")), 1, root)).toBeNull();
  });

  it("is null when an entry is missing, and for a target that is a file or another screen", () => {
    expect(findCrumbPop(new Map([[3, dir("a/b")]]), 3, root)).toBeNull();
    expect(findCrumbPop(walk, 4, file("a/b.md"))).toBeNull();
    expect(findCrumbPop(walk, 4, "/pane/w1")).toBeNull();
  });

  it("compares the query in any order", () => {
    expect(findCrumbPop(stack(`${dir("a")}&h=peer`, `${dir("a/b")}&h=peer`), 1, `/pane/w1/changes/files?h=peer&dir=a`)).toBe(1);
  });
});

describe("findCrumbBase", () => {
  it("counts back to the first place of the run below the target", () => {
    // Files opened on the pane's folder a/b, then c, then d: the root is not in the stack.
    const walk = stack("/pane/w1", dir("a/b"), dir("a/b/c"), dir("a/b/c/d"));
    expect(findCrumbBase(walk, 3, root)).toBe(2);
    expect(findCrumbBase(walk, 3, dir("a"))).toBe(2);
  });

  it("is null when the entry behind is already outside the tree", () => {
    expect(findCrumbBase(stack("/pane/w1", dir("a/b")), 1, root)).toBeNull();
  });

  it("stops at a place outside the target's subtree and at a missing entry", () => {
    expect(findCrumbBase(stack(dir("x"), dir("a/b"), dir("a/b/c")), 2, dir("a"))).toBe(1);
    expect(findCrumbBase(new Map([[2, dir("a/b")], [3, dir("a/b/c")]]), 3, dir("a"))).toBe(1);
  });
});

describe("fromOutsideTree", () => {
  it("is true for a pane or another screen, false for a place of the same tree or none", () => {
    expect(fromOutsideTree("/pane/w1", dir("a"))).toBe(true);
    expect(fromOutsideTree("/pane/w1/changes?repo=.&path=a.ts", dir("a"))).toBe(true);
    expect(fromOutsideTree("/pane/w2/changes/files?dir=a", dir("a"))).toBe(true);
    expect(fromOutsideTree(dir("a/b"), dir("a"))).toBe(false);
    expect(fromOutsideTree(root, dir("a"))).toBe(false);
    expect(fromOutsideTree(undefined, dir("a"))).toBe(false);
  });
});

describe("resolveCrumb", () => {
  const walk = stack("/pane/w1", root, dir("a"), dir("a/b"), dir("a/b/c"));

  it("pops to an ancestor that is behind us", () => {
    expect(resolveCrumb(walk, 4, dir("a/b/c"), dir("a"))).toEqual({ kind: "pop", steps: 2 });
  });

  it("replaces, with the target as is, when it is not behind us", () => {
    expect(resolveCrumb(stack("/pane/w1", dir("a/b")), 1, dir("a/b"), root)).toEqual({ kind: "replace", to: root });
    expect(resolveCrumb(walk, undefined, dir("a/b/c"), dir("a"))).toEqual({ kind: "replace", to: dir("a") });
  });

  it("pops to where the tree was entered and replaces it, when the target is above that", () => {
    const entered = stack("/pane/w1", dir("a/b"), dir("a/b/c"));
    expect(resolveCrumb(entered, 2, dir("a/b/c"), dir("a"))).toEqual({ kind: "popReplace", steps: 1, to: dir("a") });
  });

  it("replaces for a target that is not above the current place", () => {
    expect(resolveCrumb(walk, 4, dir("a/b/c"), dir("z"))).toEqual({ kind: "replace", to: dir("z") });
  });

  it("does nothing on the place you are", () => {
    expect(resolveCrumb(walk, 4, dir("a/b/c"), dir("a/b/c"))).toEqual({ kind: "stay" });
    expect(resolveCrumb(walk, 1, root, "/pane/w1/changes/files")).toEqual({ kind: "stay" });
  });
});

describe("createTrail", () => {
  const memory = () => {
    const store = new Map<string, string>();
    return { store, storage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
  };

  it("records a location against its index and overwrites a revisit", () => {
    const trail = createTrail(undefined);
    trail.record(1, root);
    trail.record(2, dir("a"));
    trail.record(2, dir("b"));
    expect([...trail.entries()]).toEqual([[1, root], [2, dir("b")]]);
  });

  it("mirrors to storage and a fresh trail reads it back", () => {
    const { storage, store } = memory();
    createTrail(storage).record(5, dir("a"));
    expect(JSON.parse(store.get(TRAIL_KEY) ?? "null")).toEqual([[5, dir("a")]]);
    expect([...createTrail(storage).entries()]).toEqual([[5, dir("a")]]);
  });

  it("drops the oldest visit past the cap", () => {
    const trail = createTrail(undefined);
    for (let i = 0; i < TRAIL_CAP + 5; i++) trail.record(i, dir(String(i)));
    expect(trail.entries().size).toBe(TRAIL_CAP);
    expect(trail.entries().has(0)).toBe(false);
    expect(trail.entries().has(TRAIL_CAP + 4)).toBe(true);
  });

  it("starts empty from unreadable storage and survives a storage that throws", () => {
    const junk = { getItem: () => "{not json", setItem: () => {} };
    expect(createTrail(junk).entries().size).toBe(0);
    const bad = { getItem: () => { throw new Error("locked"); }, setItem: () => { throw new Error("full"); } };
    const trail = createTrail(bad);
    trail.record(1, root);
    expect(trail.entries().get(1)).toBe(root);
  });
});
