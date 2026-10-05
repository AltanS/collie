import { describe, expect, it } from "vitest";

import { folderView, isNameFilterOn, matchesName } from "./files-filter";
import type { FileEntry } from "./types";

const entries: FileEntry[] = [
  { name: "src", kind: "dir" },
  { name: "node_modules", kind: "dir", ignored: true },
  { name: "README.md", kind: "file", size: 10 },
  { name: "debug.log", kind: "file", size: 5, ignored: true },
  { name: "Notes.md", kind: "file", size: 7 },
];

describe("folderView", () => {
  it("hides ignored rows by default and counts them", () => {
    const v = folderView(entries, "", false);
    expect(v.rows.map((e) => e.name)).toEqual(["src", "README.md", "Notes.md"]);
    expect(v).toMatchObject({ pool: 3, hiddenIgnored: 2 });
  });

  it("lists everything, in the bridge's order, once ignored rows are shown", () => {
    const v = folderView(entries, "", true);
    expect(v.rows.map((e) => e.name)).toEqual(["src", "node_modules", "README.md", "debug.log", "Notes.md"]);
    expect(v).toMatchObject({ pool: 5, hiddenIgnored: 0 });
  });

  it("filters by a case-insensitive substring of the name, and counts only the ignored rows it would show", () => {
    expect(folderView(entries, "MD", false).rows.map((e) => e.name)).toEqual(["README.md", "Notes.md"]);
    expect(folderView(entries, "log", false)).toMatchObject({ rows: [], pool: 3, hiddenIgnored: 1 });
    expect(folderView(entries, "log", true).rows.map((e) => e.name)).toEqual(["debug.log"]);
    expect(folderView(entries, "nothing", true).rows).toEqual([]);
  });

  it("hides nothing for a listing with no ignored field (an older member)", () => {
    const old: FileEntry[] = entries.map((e) => {
      const copy = { ...e };
      delete copy.ignored;
      return copy;
    });
    expect(folderView(old, "", false)).toMatchObject({ pool: 5, hiddenIgnored: 0 });
  });
});

describe("the name filter", () => {
  it("is off for blank and for spaces", () => {
    expect(isNameFilterOn("")).toBe(false);
    expect(isNameFilterOn("  ")).toBe(false);
    expect(isNameFilterOn("a")).toBe(true);
    expect(matchesName(entries[0]!, "  ")).toBe(true);
  });
});
