import { resolveFileLink } from "./files-link";

// Links in a Markdown file, resolved against the file they are in. The root is the folder Files
// shows; a path never starts with a slash and never climbs out.

describe("resolveFileLink", () => {
  it.each([
    ["a sibling", "./other.md", "docs/guide.md", { path: "docs/other.md" }],
    ["a bare sibling", "other.md", "docs/guide.md", { path: "docs/other.md" }],
    ["a child", "img/readme.md", "docs/guide.md", { path: "docs/img/readme.md" }],
    ["a parent's file", "../README.md", "docs/guide.md", { path: "README.md" }],
    ["two up and down again", "../../src/a.ts", "docs/deep/guide.md", { path: "src/a.ts" }],
    ["a dot in the middle", "a/./b/../c.md", "x.md", { path: "a/c.md" }],
    ["from the root", "./other.md", "README.md", { path: "other.md" }],
    ["a root-absolute path", "/docs/guide.md", "a/b/c.md", { path: "docs/guide.md" }],
    ["a root-absolute path to the root file", "/README.md", "docs/guide.md", { path: "README.md" }],
  ])("%s", (_label, href, from, expected) => {
    expect(resolveFileLink(href, from)).toEqual(expected);
  });

  it("drops a query and a fragment", () => {
    expect(resolveFileLink("other.md#install", "docs/guide.md")).toEqual({ path: "docs/other.md" });
    expect(resolveFileLink("other.md?plain=1", "docs/guide.md")).toEqual({ path: "docs/other.md" });
    expect(resolveFileLink("other.md?x=1#top", "docs/guide.md")).toEqual({ path: "docs/other.md" });
  });

  it("decodes a percent escape once", () => {
    expect(resolveFileLink("my%20notes.md", "docs/guide.md")).toEqual({ path: "docs/my notes.md" });
    expect(resolveFileLink("100%2525.md", "guide.md")).toEqual({ path: "100%25.md" });
    expect(resolveFileLink("a%2Fb.md", "guide.md")).toEqual({ path: "a/b.md" });
  });

  it("a malformed escape is no link", () => {
    expect(resolveFileLink("bad%zz.md", "guide.md")).toBeNull();
    expect(resolveFileLink("bad%.md", "guide.md")).toBeNull();
  });

  it.each([
    ["a slash", "docs/", "guide.md", { dir: "docs" }],
    ["a folder up", "../", "docs/guide.md", { dir: "" }],
    ["a bare parent", "..", "docs/deep/guide.md", { dir: "docs" }],
    ["the folder itself", "./", "docs/guide.md", { dir: "docs" }],
    ["a bare dot", ".", "docs/guide.md", { dir: "docs" }],
    ["a rooted folder", "/src/", "docs/guide.md", { dir: "src" }],
    ["the root", "/", "docs/guide.md", { dir: "" }],
  ])("a folder: %s", (_label, href, from, expected) => {
    expect(resolveFileLink(href, from)).toEqual(expected);
  });

  it("a path that climbs past the root is no link", () => {
    expect(resolveFileLink("../x.md", "README.md")).toBeNull();
    expect(resolveFileLink("../../x.md", "docs/guide.md")).toBeNull();
    expect(resolveFileLink("a/../../x.md", "guide.md")).toBeNull();
    expect(resolveFileLink("%2e%2e/x.md", "guide.md")).toBeNull();
    expect(resolveFileLink("/../x.md", "docs/guide.md")).toBeNull();
  });

  it("a fragment alone, an empty target, a NUL and a backslash are no file link", () => {
    expect(resolveFileLink("#top", "guide.md")).toBeNull();
    expect(resolveFileLink("?x=1", "guide.md")).toBeNull();
    expect(resolveFileLink("", "guide.md")).toBeNull();
    expect(resolveFileLink("a%00b.md", "guide.md")).toBeNull();
    expect(resolveFileLink("a%5Cb.md", "guide.md")).toBeNull();
  });
});
