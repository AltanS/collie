import { describe, expect, it } from "vitest";

import {
  buildChangeTree,
  EMPTY_FILTER,
  filterRepos,
  isFilterActive,
  layoutOrder,
  treeFiles,
  visibleTreeRows,
  type TreeFolder,
  type TreeNode,
} from "@/lib/changes-tree";
import type { ChangedFile, ChangedRepo, ChangeStatus } from "@/lib/types";

function f(path: string, status: ChangeStatus = "M", added = 1, removed = 0): ChangedFile {
  return { path, status, added, removed, binary: false };
}

function folder(node: TreeNode | undefined): TreeFolder {
  if (node?.kind !== "folder") throw new Error("expected a folder row");
  return node;
}

/** A compact picture of a tree: folders as `label/ (count +a -r)`, files by name, indented. */
function draw(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((n) =>
    n.kind === "file"
      ? [`${"  ".repeat(n.depth)}${n.name}`]
      : [`${"  ".repeat(n.depth)}${n.label}/ (${n.fileCount} +${n.added} -${n.removed})`, ...draw(n.children)],
  );
}

describe("buildChangeTree", () => {
  it("puts folders first, then files, each by name, case-insensitively and numerically", () => {
    const tree = buildChangeTree([f("b.ts"), f("src/x.ts"), f("A.ts"), f("lib/file10.ts"), f("lib/file2.ts"), f("lib/sub/z.ts")]);
    expect(draw(tree)).toEqual([
      "lib/ (3 +3 -0)",
      "  sub/ (1 +1 -0)",
      "    z.ts",
      "  file2.ts",
      "  file10.ts",
      "src/ (1 +1 -0)",
      "  x.ts",
      "A.ts",
      "b.ts",
    ]);
  });

  it("compacts a chain of single-folder folders into one row, and stops where a folder holds a file", () => {
    const tree = buildChangeTree([f("src/lib/deep/a.ts", "M", 2, 1), f("src/lib/b.ts", "A", 4, 0)]);
    expect(draw(tree)).toEqual(["src/lib/ (2 +6 -1)", "  deep/ (1 +2 -1)", "    a.ts", "  b.ts"]);
    const top = folder(tree[0]);
    expect(top.key).toBe("src/lib/");
    expect(folder(top.children[0]).key).toBe("src/lib/deep/");
  });

  it("does not compact a folder with two folders under it", () => {
    expect(draw(buildChangeTree([f("a/b/x.ts"), f("a/c/y.ts")]))).toEqual([
      "a/ (2 +2 -0)",
      "  b/ (1 +1 -0)",
      "    x.ts",
      "  c/ (1 +1 -0)",
      "    y.ts",
    ]);
  });

  it("keeps an untracked folder as one file row, slash and all", () => {
    const tree = buildChangeTree([f("docs/new/", "?", 0, 0)]);
    expect(draw(tree)).toEqual(["docs/ (1 +0 -0)", "  new/"]);
  });

  it("walks every file for Previous / Next, collapsed or not, and draws a collapsed folder's row alone", () => {
    const tree = buildChangeTree([f("z.ts"), f("src/a.ts"), f("src/b.ts")]);
    expect(treeFiles(tree).map((x) => x.path)).toEqual(["src/a.ts", "src/b.ts", "z.ts"]);
    const rows = visibleTreeRows(tree, new Set(["src/"]));
    expect(rows.map((r) => r.key)).toEqual(["src/", "z.ts"]);
  });
});

const repos: ChangedRepo[] = [
  { relPath: ".", name: "web", files: [f("src/Checkout.tsx", "M"), f("src/cart.ts", "A"), f("notes.md", "?")] },
  { relPath: "api", name: "api", files: [f("server/orders.ts", "R"), f("old.ts", "D")] },
];

describe("filterRepos", () => {
  it("passes everything through with no filter", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(filterRepos(repos, EMPTY_FILTER)).toEqual(repos);
    expect(isFilterActive({ query: "  ", statuses: [] })).toBe(false);
  });

  it("matches a path substring case-insensitively and drops repos left empty", () => {
    const out = filterRepos(repos, { query: "CHECK", statuses: [] });
    expect(out.map((r) => [r.relPath, r.files.map((x) => x.path)])).toEqual([[".", ["src/Checkout.tsx"]]]);
  });

  it("keeps only the chosen status letters, U standing for untracked", () => {
    const out = filterRepos(repos, { query: "", statuses: ["U", "D"] });
    expect(out.flatMap((r) => r.files.map((x) => x.path))).toEqual(["notes.md", "old.ts"]);
  });

  it("combines text and status", () => {
    expect(filterRepos(repos, { query: "src", statuses: ["A"] }).flatMap((r) => r.files.map((x) => x.path))).toEqual([
      "src/cart.ts",
    ]);
  });
});

describe("layoutOrder", () => {
  it("follows the list's order, or the tree's, repo by repo", () => {
    expect(layoutOrder(repos, "list").map((r) => r.path)).toEqual([
      "src/Checkout.tsx",
      "src/cart.ts",
      "notes.md",
      "server/orders.ts",
      "old.ts",
    ]);
    expect(layoutOrder(repos, "tree").map((r) => `${r.repo}:${r.path}`)).toEqual([
      ".:src/cart.ts",
      ".:src/Checkout.tsx",
      ".:notes.md",
      "api:server/orders.ts",
      "api:old.ts",
    ]);
  });
});
