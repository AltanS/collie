import { describe, expect, it } from "vitest";

import { changeAt, changeCount, EMPTY_CHANGE_INDEX, indexChanges, markFolder } from "./files-marks";
import type { ChangedFile, ChangedRepo, FileEntry } from "./types";

const ROOT = "/home/you/webapp";

function file(path: string, status: ChangedFile["status"], extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status, added: 1, removed: 0, binary: false, ...extra };
}

const REPOS: ChangedRepo[] = [
  {
    relPath: ".",
    name: "webapp",
    files: [
      file("src/routes/checkout.tsx", "M"),
      file("src/lib/cart.ts", "A"),
      file("README.md", "M"),
      file("old.md", "D"),
      file("src/legacy/a.ts", "D"),
      file("src/legacy/b.ts", "D"),
      file("drafts/", "?"),
      file("notes.md", "?"),
    ],
  },
  {
    relPath: "packages/api",
    name: "api",
    files: [file("server/handlers/orders.ts", "R", { oldPath: "server/orders.ts" })],
  },
];

const INDEX = indexChanges(ROOT, REPOS);

const rootEntries: FileEntry[] = [
  { name: "drafts", kind: "dir" },
  { name: "node_modules", kind: "dir", ignored: true },
  { name: "packages", kind: "dir" },
  { name: "src", kind: "dir" },
  { name: "notes.md", kind: "file", size: 10 },
  { name: "package.json", kind: "file", size: 312 },
  { name: "README.md", kind: "file", size: 1240 },
];

describe("indexChanges", () => {
  it("keys every change by its path from the root, nested repos joined", () => {
    expect([...INDEX.files.keys()].toSorted()).toEqual([
      "README.md",
      "drafts",
      "notes.md",
      "old.md",
      "packages/api/server/handlers/orders.ts",
      "src/legacy/a.ts",
      "src/legacy/b.ts",
      "src/lib/cart.ts",
      "src/routes/checkout.tsx",
    ]);
    expect(INDEX.files.get("drafts")).toMatchObject({ folder: true, repo: ".", path: "drafts/", status: "?" });
    expect(INDEX.files.get("packages/api/server/handlers/orders.ts")).toMatchObject({
      repo: "packages/api",
      path: "server/handlers/orders.ts",
      oldPath: "server/orders.ts",
    });
  });

  it("counts the changes under each folder, the root counting all of them", () => {
    expect(changeCount(INDEX)).toBe(9);
    expect(INDEX.folders.get("src")).toEqual({ count: 4, status: "M" });
    expect(INDEX.folders.get("src/legacy")).toEqual({ count: 2, status: "D" });
    expect(INDEX.folders.get("src/lib")).toEqual({ count: 1, status: "A" });
    expect(INDEX.folders.get("packages")).toEqual({ count: 1, status: "R" });
    expect(changeCount(EMPTY_CHANGE_INDEX)).toBe(0);
  });

  it("joins a repo above the root through the root's own folders, and leaves out what is outside it", () => {
    const above = indexChanges("/home/you/proj/web", [
      { relPath: "..", name: "proj", files: [file("web/src/a.ts", "M"), file("api/b.ts", "M")] },
    ]);
    expect([...above.files.keys()]).toEqual(["src/a.ts"]);
    expect(changeCount(above)).toBe(1);
  });
});

describe("markFolder", () => {
  it("marks a changed file with its status and a folder with the count below it", () => {
    const { marks } = markFolder(rootEntries, "", INDEX);
    expect(marks.get("README.md")).toMatchObject({ kind: "change", status: "M" });
    expect(marks.get("notes.md")).toMatchObject({ kind: "change", status: "?" });
    expect(marks.get("src")).toEqual({ kind: "folder", mark: { count: 4, status: "M" } });
    expect(marks.get("packages")).toEqual({ kind: "folder", mark: { count: 1, status: "R" } });
    expect(marks.has("package.json")).toBe(false);
  });

  it("marks an untracked folder as new rather than counting inside it", () => {
    const { marks } = markFolder(rootEntries, "", INDEX);
    expect(marks.get("drafts")).toMatchObject({ kind: "change", status: "?" });
  });

  it("never marks a row git ignores", () => {
    const index = indexChanges(ROOT, [{ relPath: ".", name: "webapp", files: [file("node_modules/x.js", "M")] }]);
    expect(markFolder(rootEntries, "", index).marks.has("node_modules")).toBe(false);
  });

  it("adds a deleted file from the change set, in the bridge's order, struck through", () => {
    const { entries, marks } = markFolder(rootEntries, "", INDEX);
    expect(entries.map((e) => e.name)).toEqual([
      "drafts",
      "node_modules",
      "packages",
      "src",
      "notes.md",
      "old.md",
      "package.json",
      "README.md",
    ]);
    expect(marks.get("old.md")).toMatchObject({ kind: "change", status: "D", deleted: true, change: { path: "old.md", repo: "." } });
  });

  it("adds a folder that only deleted files are left in, and lists those files inside it", () => {
    const src: FileEntry[] = [
      { name: "lib", kind: "dir" },
      { name: "routes", kind: "dir" },
    ];
    const marked = markFolder(src, "src", INDEX);
    expect(marked.entries.map((e) => `${e.kind}:${e.name}`)).toEqual(["dir:legacy", "dir:lib", "dir:routes"]);
    expect(marked.marks.get("legacy")).toEqual({ kind: "folder", mark: { count: 2, status: "D" } });

    const legacy = markFolder([], "src/legacy", INDEX);
    expect(legacy.entries.map((e) => e.name)).toEqual(["a.ts", "b.ts"]);
    expect([...legacy.marks.values()].every((m) => m.kind === "change" && m.deleted === true)).toBe(true);
  });

  it("does not add a row the disk already lists", () => {
    const { entries } = markFolder([...rootEntries, { name: "old.md", kind: "file" }], "", INDEX);
    expect(entries.filter((e) => e.name === "old.md")).toHaveLength(1);
  });

  it("marks everything inside an untracked folder as new, with no change of its own to diff", () => {
    const { marks } = markFolder(
      [
        { name: "ideas", kind: "dir" },
        { name: "plan.md", kind: "file" },
        { name: "scratch.log", kind: "file", ignored: true },
      ],
      "drafts",
      INDEX,
    );
    expect(marks.get("plan.md")).toEqual({ kind: "change", status: "?" });
    expect(marks.get("ideas")).toEqual({ kind: "change", status: "?" });
    expect(marks.has("scratch.log")).toBe(false);
  });

  it("stops the untracked mark at a folder that is a repo of its own", () => {
    const index = indexChanges(
      ROOT,
      [{ relPath: ".", name: "webapp", files: [file("vendor/", "?")] }],
      [{ relPath: "vendor/lib" }],
    );
    const { marks } = markFolder([{ name: "lib", kind: "dir" }], "vendor", index);
    expect(marks.has("lib")).toBe(false);
    expect(markFolder([{ name: "x.ts", kind: "file" }], "vendor/lib", index).marks.has("x.ts")).toBe(false);
  });

  it("has no marks for a folder no change sits in", () => {
    const { entries, marks } = markFolder(rootEntries, "docs", INDEX);
    expect(marks.size).toBe(0);
    expect(entries).toEqual(rootEntries);
  });
});

describe("the root itself untracked", () => {
  // A pane in `repo/web`, git above lists `web/` whole.
  const ROOT_UP = "/home/you/repo/web";
  const index = indexChanges(ROOT_UP, [{ relPath: "..", name: "repo", files: [file("web/", "?")] }]);

  it("marks every row new, with no change of its own to diff", () => {
    const { marks } = markFolder(
      [
        { name: "src", kind: "dir" },
        { name: "a.md", kind: "file" },
        { name: "dist", kind: "dir", ignored: true },
      ],
      "",
      index,
    );
    expect(marks.get("src")).toEqual({ kind: "change", status: "?" });
    expect(marks.get("a.md")).toEqual({ kind: "change", status: "?" });
    expect(marks.has("dist")).toBe(false);
    expect(markFolder([{ name: "x.ts", kind: "file" }], "src", index).marks.get("x.ts")).toEqual({ kind: "change", status: "?" });
    expect(changeAt(index, "")).toBeUndefined();
  });

  it("stops at a repo of its own inside the root", () => {
    const withRepo = indexChanges(ROOT_UP, [{ relPath: "..", name: "repo", files: [file("web/", "?")] }], [{ relPath: "vendor" }]);
    expect(markFolder([{ name: "vendor", kind: "dir" }], "", withRepo).marks.has("vendor")).toBe(false);
  });
});

describe("changeAt", () => {
  it("finds the change a file screen diffs, but not an untracked folder", () => {
    expect(changeAt(INDEX, "src/lib/cart.ts")).toMatchObject({ repo: ".", path: "src/lib/cart.ts", status: "A" });
    expect(changeAt(INDEX, "drafts")).toBeUndefined();
    expect(changeAt(INDEX, "package.json")).toBeUndefined();
  });
});
