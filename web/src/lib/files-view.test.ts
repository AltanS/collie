import { describe, expect, it } from "vitest";

import { baseName, formatBytes, headerFolder, imageCaption, isRasterImagePath, joinRel, previewKindFor, rootPathOf, splitLines } from "./files-view";
import { countJsonNodes, JSON_TREE_MAX_NODES, parseJsonTree } from "./json-tree";

describe("previewKindFor", () => {
  it.each([
    ["README.md", "markdown"],
    ["a/b/notes.markdown", "markdown"],
    ["data.JSON", "json"],
    ["index.html", "html"],
    ["page.htm", "html"],
    ["icons/logo.svg", "svg"],
    ["LOGO.SVG", "svg"],
    ["logo.png", null],
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
    expect(rootPathOf("/home/you/webapp", ".", "src/a.md")).toBe("src/a.md");
    expect(rootPathOf("/home/you/webapp", "packages/api", "notes.md")).toBe("packages/api/notes.md");
  });

  it("drops an untracked folder's trailing slash", () => {
    expect(rootPathOf("/home/you/webapp", ".", "drafts/")).toBe("drafts");
  });

  // The root is a folder INSIDE a repo: a pane opened in `proj/web` reads the repo `proj` as `..`, and
  // the repo's paths start with `web/`. Before 2026-10-06 the path came out as `../web/…`, which
  // Files refuses, so the diff's Preview opened "This file is not available".
  it("strips the root's own folders from a repo above the root", () => {
    expect(rootPathOf("/home/you/proj/web", "..", "web/src/a.md")).toBe("src/a.md");
    expect(rootPathOf("/home/you/mono/apps/web", "../..", "apps/web/README.md")).toBe("README.md");
    expect(rootPathOf("C:\\Users\\you\\proj\\web", "..", "web/a.md")).toBe("a.md");
  });

  it("is null for a file of that repo outside the root, and for the root itself", () => {
    expect(rootPathOf("/home/you/proj/web", "..", "api/server.ts")).toBeNull();
    expect(rootPathOf("/home/you/proj/web", "..", "api/")).toBeNull();
    expect(rootPathOf("/web", "../..", "a/web/x.md")).toBeNull();
  });
});

describe("rootPathOf, an untracked folder that holds the root", () => {
  // `repo/web` is the root; git in `repo` lists `web/` whole. Before this the answer was null, the
  // tree marked nothing and the badge still counted the row.
  it("is the root itself, an empty path", () => {
    expect(rootPathOf("/home/you/proj/web", "..", "web/")).toBe("");
    expect(rootPathOf("/home/you/mono/apps/web", "../..", "apps/")).toBe("");
    expect(rootPathOf("/home/you/mono/apps/web", "../..", "apps/web/")).toBe("");
  });

  it("is still the folder's own path for an untracked folder below the root", () => {
    expect(rootPathOf("/home/you/proj/web", "..", "web/drafts/")).toBe("drafts");
  });
});

describe("rootPathOf on Windows", () => {
  it("matches the root's folders without regard to case", () => {
    expect(rootPathOf("C:\\Users\\you\\Proj\\Web", "..", "web/a.md")).toBe("a.md");
    expect(rootPathOf("C:\\Users\\you\\Proj\\Web", "..", "web/")).toBe("");
    expect(rootPathOf("\\\\host\\share\\Proj\\Web", "..", "WEB/src/a.md")).toBe("src/a.md");
  });

  it("stays case-sensitive on a POSIX root", () => {
    expect(rootPathOf("/home/you/Proj/Web", "..", "web/a.md")).toBeNull();
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
  it("says nothing after the label when the folder is named like it", () => {
    expect(headerFolder("/var/home/altan/projects/storefront", "storefront")).toBe("");
    expect(headerFolder("/var/home/altan/projects/storefront/", "storefront")).toBe("");
    expect(headerFolder("/storefront", "storefront")).toBe("");
  });

  it("says the folder's last segment, never the whole path, when the label is another name", () => {
    expect(headerFolder("/var/home/altan/projects/storefront", "Shop")).toBe("storefront");
    expect(headerFolder("/home/you/webapp/", "Shop")).toBe("webapp");
    expect(headerFolder("C:/Users/you/webapp", "Shop")).toBe("webapp");
    expect(headerFolder("C:\\Users\\you\\webapp\\", "Shop")).toBe("webapp");
  });

  it("says nothing for a root with no segment", () => {
    expect(headerFolder("/", "home")).toBe("");
    expect(headerFolder("", "home")).toBe("");
  });
});


describe("pictures (ADR 0090)", () => {
  it.each([
    ["a.png", true],
    ["b/c.JPG", true],
    ["d.jpeg", true],
    ["e.gif", true],
    ["f.webp", true],
    ["g.avif", true],
    ["h.svg", false],
    ["i.bmp", false],
    ["png", false],
    [".png", false],
    ["j.png.txt", false],
  ])("%s is a raster picture: %s", (path, raster) => {
    expect(isRasterImagePath(path)).toBe(raster);
  });

  it("captions a picture with each part that is known", () => {
    expect(imageCaption({ width: 1200, height: 800, size: 52_224, type: "image/png" })).toBe("1200 × 800 · 51 KB · PNG");
    expect(imageCaption({ size: 52_224, type: "image/png" })).toBe("51 KB · PNG");
    expect(imageCaption({ width: 0, height: 0, size: 900, type: "image/svg+xml" })).toBe("900 B · SVG");
    expect(imageCaption({ size: 10, type: "application/octet-stream" })).toBe("10 B");
    expect(imageCaption({ width: 16, height: 16, type: "IMAGE/WEBP" })).toBe("16 × 16 · WebP");
    expect(imageCaption({})).toBe("");
  });
});
