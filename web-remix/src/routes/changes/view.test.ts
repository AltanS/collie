import { describe, expect, test } from "bun:test";

import { readView } from "./view";

describe("readView", () => {
  test("the bare screen is the tree root, or the list when changes-only is on", () => {
    const tree = readView("list", "", false);
    expect([tree.atRoot, tree.showList, tree.treeDir, tree.treeFile]).toEqual([true, false, "", null]);
    const list = readView("list", "", true);
    expect([list.atRoot, list.showList, list.treeDir]).toEqual([true, true, null]);
  });

  test("?repo=&path= on the list is one changed file's diff", () => {
    const view = readView("list", "?h=m&repo=.&path=a%2Fb.ts", false);
    expect(view.open).toEqual({ repo: ".", path: "a/b.ts" });
    expect(view.current).toEqual({ repo: ".", path: "a/b.ts" });
    expect([view.atRoot, view.treeDir, view.commitView]).toEqual([false, null, false]);
  });

  test("the commit level reads the repo, and the file rides the same two names", () => {
    const head = readView("commit", "?repo=sub", false);
    expect([head.commitRepo, head.commitOpen, head.open]).toEqual(["sub", null, null]);
    const file = readView("commit", "?repo=sub&path=x.ts", false);
    expect(file.commitOpen).toEqual({ repo: "sub", path: "x.ts" });
    expect(file.current).toEqual({ repo: "sub", path: "x.ts" });
  });

  test("the files level: root, a folder, a file", () => {
    expect(readView("files", "", false).atRoot).toBe(true);
    const folder = readView("files", "?dir=src%2Flib", false);
    expect([folder.atRoot, folder.treeDir, folder.treeFile]).toEqual([false, "src/lib", null]);
    const file = readView("files", "?path=src%2Fa.ts", true);
    expect([file.treeDir, file.treeFile, file.showList]).toEqual([null, "src/a.ts", false]);
    // A repo/path pair on the files level is not a list diff.
    expect(readView("files", "?repo=.&path=a.ts", false).open).toBeNull();
  });
});
