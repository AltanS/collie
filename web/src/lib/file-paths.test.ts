import { describe, expect, it } from "vitest";

import { codeSpanPath, findFilePaths, paneFilesRoot, resolveFilePathLink } from "./file-paths";

/** The paths found in `text`, as printed (with the suffix), for a compact table. */
const printed = (text: string) => findFilePaths(text).map((f) => text.slice(f.start, f.end));

describe("findFilePaths: what plain text links", () => {
  it.each([
    ["saved to docs/demo.mp4", ["docs/demo.mp4"]],
    ["edit web/src/lib/a.ts now", ["web/src/lib/a.ts"]],
    ["see ./scripts/build.sh", ["./scripts/build.sh"]],
    ["from ../shared/types.ts", ["../shared/types.ts"]],
    ["in ~/notes/today.md", ["~/notes/today.md"]],
    ["the file /var/home/a/repo/README.md", ["/var/home/a/repo/README.md"]],
    ["a folder ./scripts", ["./scripts"]],
    ["at src/a.ts:12", ["src/a.ts:12"]],
    ["at src/a.ts:12:5 there", ["src/a.ts:12:5"]],
    ["src/App.tsx(120,8): error TS2322", ["src/App.tsx(120,8)"]],
    ["Update(web/src/lib/nav.ts)", ["web/src/lib/nav.ts"]],
    ["see src/a.ts.", ["src/a.ts"]],
    ["two: a/b.ts and c/d.json", ["a/b.ts", "c/d.json"]],
    ["dot-file config/.env here", ["config/.env"]],
    ["scoped node_modules/@scope/pkg/index.js", ["node_modules/@scope/pkg/index.js"]],
    ["unicode docs/über/straße.md", ["docs/über/straße.md"]],
  ])("%s", (text, want) => {
    expect(printed(text)).toEqual(want);
  });

  it("reads the line and the column", () => {
    expect(findFilePaths("src/a.ts:12:5")).toEqual([{ start: 0, end: 13, path: "src/a.ts", line: 12, col: 5 }]);
    expect(findFilePaths("App.tsx(3) x/App.tsx(4, 2)")).toEqual([
      { start: 11, end: 26, path: "x/App.tsx", line: 4, col: 2 },
    ]);
    expect(findFilePaths("a/b.ts")[0]).toEqual({ start: 0, end: 6, path: "a/b.ts" });
  });

  it("a line of zero is no line", () => {
    expect(findFilePaths("a/b.ts:0")[0]).toEqual({ start: 0, end: 8, path: "a/b.ts" });
  });
});

describe("findFilePaths: what plain text leaves alone", () => {
  it.each([
    ["and/or", "this and/or that"],
    ["e.g.", "e.g. a thing"],
    ["a bare file name", "open README.md"],
    ["a version", "bump to 1.2.3 today"],
    ["a version path", "node/v20.1.0/bin"],
    ["a domain", "example.com is down"],
    ["a domain with a path", "github.com/AltanS/collie.git"],
    ["inside a URL", "https://example.com/docs/a.md"],
    ["inside a URL with a port", "http://bluefin:8788/pane/a.ts"],
    ["a call", "call utils/format.ts(x) here"],
    ["a call with a space", "utils/format.ts (x)"],
    ["a folder with a trailing slash", "under src/lib/ now"],
    ["a Windows path", "C:\\Users\\me\\a.ts"],
    ["a Windows path with forward slashes", "C:/Users/me/a.ts"],
    ["a fraction", "1/2.5 of it"],
    ["a slashed word with no extension", "key=value/other"],
    ["a member chain", "items.map(x)"],
  ])("%s", (_name, text) => {
    expect(printed(text)).toEqual([]);
  });

  it("a very long line is not scanned", () => {
    expect(findFilePaths(`${"x".repeat(9000)} a/b.ts`)).toEqual([]);
  });
});

describe("codeSpanPath", () => {
  it.each([
    ["README.md", { path: "README.md" }],
    ["src/a.ts", { path: "src/a.ts" }],
    ["src/a.ts:42", { path: "src/a.ts", line: 42 }],
    ["Name.tsx(12,5)", { path: "Name.tsx", line: 12, col: 5 }],
    [" web/vite.config.ts ", { path: "web/vite.config.ts" }],
    [".env", { path: ".env" }],
    ["./scripts", { path: "./scripts" }],
    ["~/notes/a.md", { path: "~/notes/a.md" }],
    ["tool.vue", { path: "tool.vue" }],
  ])("%s is a path", (code, want) => {
    expect(codeSpanPath(code)).toEqual(want);
  });

  it.each([
    "process.env",
    "process.env.HOME",
    "Math.random",
    "console.log",
    "fs.readFile",
    "items.map",
    "p.then",
    "list.length",
    ".map",
    "example.com",
    "1.2.3",
    "v1.2.3",
    "3.14",
    "and/or",
    "git status",
    "foo.ts(x)",
    "https://x.dev/a.md",
    "Makefile",
    "a.b.c.d.e.verylongextension",
    "",
  ])("%s is not", (code) => {
    expect(codeSpanPath(code)).toBeNull();
  });
});

describe("resolveFilePathLink", () => {
  const root = "/var/home/me/repo";
  const base = { root, cwd: "/var/home/me/repo/web", home: "/var/home/me" };

  it.each([
    ["an absolute path under the root", "/var/home/me/repo/web/src/a.ts", "web/src/a.ts"],
    ["the other spelling of home", "/home/me/repo/README.md", "README.md"],
    ["~/ with home", "~/repo/docs/a.md", "docs/a.md"],
    ["a bare relative against the cwd", "src/a.ts", "web/src/a.ts"],
    ["./ against the cwd", "./src/a.ts", "web/src/a.ts"],
    ["../ against the cwd", "../docs/a.md", "docs/a.md"],
    ["dots folded", "src/../lib/./b.ts", "web/lib/b.ts"],
  ])("%s", (_name, path, want) => {
    expect(resolveFilePathLink({ ...base, path })).toBe(want);
  });

  it.each([
    ["an absolute path outside the root", "/etc/passwd"],
    ["a sibling folder that shares the prefix", "/var/home/me/repo-old/a.ts"],
    ["the root itself", "/var/home/me/repo"],
    ["../ that leaves the root", "../../other/a.ts"],
    ["~/ outside the root", "~/.ssh/id_ed25519"],
    ["another person's home", "~bob/a.ts"],
    ["a .git folder", ".git/config"],
    ["a backslash", "src\\a.ts"],
  ])("%s is null", (_name, path) => {
    expect(resolveFilePathLink({ ...base, path })).toBeNull();
  });

  it("a cwd relative to the root", () => {
    expect(resolveFilePathLink({ root, cwd: "web", path: "src/a.ts" })).toBe("web/src/a.ts");
    expect(resolveFilePathLink({ root, cwd: "", path: "src/a.ts" })).toBe("src/a.ts");
  });

  it("~/ with no home known matches the root's own tail", () => {
    expect(resolveFilePathLink({ root, cwd: "", path: "~/repo/docs/a.md" })).toBe("docs/a.md");
    expect(resolveFilePathLink({ root, cwd: "", path: "~/elsewhere/a.md" })).toBeNull();
  });

  it("no root, or a Windows root, resolves nothing", () => {
    expect(resolveFilePathLink({ root: null, cwd: "", path: "src/a.ts" })).toBeNull();
    expect(resolveFilePathLink({ root: "C:\\repo", cwd: "", path: "src/a.ts" })).toBeNull();
  });
});

describe("paneFilesRoot", () => {
  const home = "/var/home/me";
  const pane = { workspaceId: "w1", cwd: "/var/home/me/repo/web" };

  it("takes the workspace's own folder first", () => {
    const root = paneFilesRoot({ pane, panes: [pane], workspaces: [{ workspaceId: "w1", folder: "/var/home/me/repo/" }], home });
    expect(root).toBe("/var/home/me/repo");
  });

  it("else the folder the workspace's panes share", () => {
    const other = { workspaceId: "w1", cwd: "/var/home/me/repo/docs" };
    const elsewhere = { workspaceId: "w2", cwd: "/tmp" };
    expect(paneFilesRoot({ pane, panes: [pane, other, elsewhere], workspaces: [], home })).toBe("/var/home/me/repo");
  });

  it("a folder at or above home is out of bounds; the pane's own cwd stands in", () => {
    const other = { workspaceId: "w1", cwd: "/var/home/me" };
    expect(paneFilesRoot({ pane, panes: [pane, other], workspaces: [{ workspaceId: "w1", folder: home }], home })).toBe(
      "/var/home/me/repo/web",
    );
  });

  it("a pane parked in home has no root", () => {
    const parked = { workspaceId: "w1", cwd: home };
    expect(paneFilesRoot({ pane: parked, panes: [parked], workspaces: [], home })).toBeNull();
  });

  it("only the pane's own machine counts", () => {
    const peer = { workspaceId: "w1", cwd: "/srv/x", host: "peer" };
    expect(paneFilesRoot({ pane, panes: [pane, peer], workspaces: [{ workspaceId: "w1", folder: "/srv", host: "peer" }], home })).toBe(
      "/var/home/me/repo/web",
    );
  });

  it("no home known yet, or a Windows home, gives no root", () => {
    expect(paneFilesRoot({ pane, panes: [pane], workspaces: [], home: "" })).toBeNull();
    expect(paneFilesRoot({ pane, panes: [pane], workspaces: [], home: "C:\\Users\\me" })).toBeNull();
  });
});
