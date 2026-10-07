import { resolveFileLink, resolveImageSrc } from "./files-link";

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

describe("resolveImageSrc: which images of a Markdown file the preview may load (ADR 0090)", () => {
  it("resolves a relative address against the file's folder", () => {
    expect(resolveImageSrc("img/home.png", "docs/guide.md")).toBe("docs/img/home.png");
    expect(resolveImageSrc("./home.png", "docs/guide.md")).toBe("docs/home.png");
    expect(resolveImageSrc("../brand/mark.svg", "docs/guide.md")).toBe("brand/mark.svg");
    expect(resolveImageSrc("my%20shot.png", "README.md")).toBe("my shot.png");
    expect(resolveImageSrc("a.png?raw=1#x", "README.md")).toBe("a.png");
  });

  it("refuses a scheme, a root-absolute, home or protocol-relative address, and a fragment", () => {
    for (const src of ["https://example.com/a.png", "http://x/a.png", "data:image/png;base64,AA", "javascript:alert(1)", "file:///etc/a.png", "/logo.png", "//cdn.example/a.png", "~/a.png", "#top", "?x", "", "   "]) {
      expect({ src, at: resolveImageSrc(src, "docs/guide.md") }).toEqual({ src, at: null });
    }
  });

  it("refuses an address that climbs past the root, names a folder, or goes through .git", () => {
    expect(resolveImageSrc("../../a.png", "docs/guide.md")).toBeNull();
    expect(resolveImageSrc("../a.png", "README.md")).toBeNull();
    expect(resolveImageSrc("img/", "README.md")).toBeNull();
    expect(resolveImageSrc(".git/a.png", "README.md")).toBeNull();
    expect(resolveImageSrc("sub/.GIT/a.png", "README.md")).toBeNull();
    expect(resolveImageSrc("a%00.png", "README.md")).toBeNull();
  });
});
