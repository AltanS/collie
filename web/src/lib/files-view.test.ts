import { describe, expect, it } from "vitest";

import { baseName, formatBytes, headerFolder, joinRel, previewKindFor, rootPathOf, splitLines } from "./files-view";
import { countJsonNodes, JSON_TREE_MAX_NODES, parseJsonTree } from "./json-tree";

describe("previewKindFor", () => {
  it.each([
    ["README.md", "markdown"],
    ["a/b/notes.markdown", "markdown"],
    ["data.JSON", "json"],
    ["index.html", "html"],
    ["page.htm", "html"],
    ["main.ts", null],
    ["json", null],
    [".md", null],
    ["x.constructor", null],
    ["archive.md.bak", null],
  ])("%s → %s", (path, kind) => {
    expect(previewKindFor(path)).toBe(kind);
  });
});

describe("rootPathOf", () => {
  it("joins a nested repo's folder and leaves the root repo's paths alone", () => {
    expect(rootPathOf(".", "src/a.md")).toBe("src/a.md");
    expect(rootPathOf("packages/api", "notes.md")).toBe("packages/api/notes.md");
  });
});

describe("paths", () => {
  it("names the last segment and joins from the root", () => {
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(baseName("")).toBe("");
    expect(joinRel("", "a")).toBe("a");
    expect(joinRel("a/b", "c")).toBe("a/b/c");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [812, "812 B"],
    [1024, "1 KB"],
    [3482, "3.4 KB"],
    [20480, "20 KB"],
    [1_572_864, "1.5 MB"],
  ])("%d → %s", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});

describe("splitLines", () => {
  it("drops the newline that ends the last line and reads CRLF as one break", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("parseJsonTree", () => {
  it("parses, errors with the parser's message, and refuses past the cap", () => {
    expect(parseJsonTree('{"a":[1,2]}')).toMatchObject({ kind: "ok", nodes: 4 });
    expect(parseJsonTree("{")).toMatchObject({ kind: "error" });
    expect(parseJsonTree("null")).toMatchObject({ kind: "ok" });
    expect(parseJsonTree(JSON.stringify(Array(JSON_TREE_MAX_NODES).fill(0)))).toMatchObject({ kind: "tooBig" });
  });

  it("counts a wide array without overflowing the call stack", () => {
    expect(countJsonNodes(Array(300_000).fill(1), JSON_TREE_MAX_NODES)).toBeGreaterThan(JSON_TREE_MAX_NODES);
  });
});

describe("headerFolder", () => {
  it("does not say the label twice: a folder named like it shows the folders above it", () => {
    expect(headerFolder("/var/home/altan/projects/storefront", "storefront")).toBe("/var/home/altan/projects/");
    expect(headerFolder("/var/home/altan/projects/storefront/", "storefront")).toBe("/var/home/altan/projects/");
  });

  it("keeps the whole path when the label is another name, for the screen to cut from the left", () => {
    expect(headerFolder("/var/home/altan/projects/storefront", "Shop")).toBe("/var/home/altan/projects/storefront");
    expect(headerFolder("/home/you/webapp/", "Shop")).toBe("/home/you/webapp");
  });

  it("a root folder is itself, and a relative folder named like the label shows nothing above it", () => {
    expect(headerFolder("/", "home")).toBe("/");
    expect(headerFolder("/storefront", "storefront")).toBe("/");
  });
});
