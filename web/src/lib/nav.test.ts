import {
  readPreviewAsked,
  ancestorsOf,
  changesCommitPath,
  filesFolders,
  filesParent,
  filesPath,
  githubPath,
  homePath,
  decodedPath,
  isAncestor,
  machinePath,
  machinesPath,
  machineTabOf,
  pairLandingPath,
  panePath,
  parentChain,
  readFrom,
  resolveTreeUp,
  resolveUp,
  resolveUpTo,
  resolveUpToExact,
  settingsPath,
  spaceChangesCommitPath,
  spaceFilesPath,
  treeUpLanding,
  updatesPath,
  upTarget,
} from "./nav";

describe("the commit view's paths", () => {
  it("sits one level below the list, with the repo and the file in the query", () => {
    expect(changesCommitPath("w1:p1", undefined, ".")).toBe("/pane/w1%3Ap1/changes/commit?repo=.");
    expect(changesCommitPath("w1:p1", undefined, "one", "a b.ts")).toBe("/pane/w1%3Ap1/changes/commit?repo=one&path=a+b.ts");
    expect(spaceChangesCommitPath("w1", undefined, ".")).toBe("/space/w1/changes/commit?repo=.");
  });
});

describe("the GitHub work path", () => {
  it("names the screen and carries the scope, so its lists stay the scoped machine's", () => {
    expect(githubPath()).toBe("/github");
    expect(githubPath({ host: "workshop", session: undefined })).toBe("/github?h=workshop");
  });
});

describe("the machines paths", () => {
  it("names the list and one machine, and carries the scope", () => {
    expect(machinesPath()).toBe("/machines");
    expect(machinePath("bluefin")).toBe("/machines/bluefin");
    expect(machinePath("a b/c")).toBe("/machines/a%20b%2Fc");
    expect(machinesPath({ host: "badger", session: undefined })).toBe("/machines?h=badger");
  });

  it("names the Alerts view in the query, after the scope, and Status with no parameter", () => {
    expect(machinePath("bluefin", undefined, "alerts")).toBe("/machines/bluefin?tab=alerts");
    expect(machinePath("bluefin", undefined, "status")).toBe("/machines/bluefin");
    expect(machinePath("bluefin", { host: "badger", session: undefined }, "alerts")).toBe("/machines/bluefin?h=badger&tab=alerts");
    expect(machineTabOf("?tab=alerts")).toBe("alerts");
    expect(machineTabOf("?h=badger&tab=alerts")).toBe("alerts");
    expect(machineTabOf("")).toBe("status");
    expect(machineTabOf("?tab=charts")).toBe("status");
  });

  it("keeps both views one level: their parents are the same, so a switch is a side move", () => {
    expect(ancestorsOf("/machines/bluefin")).toContain("/");
    expect(isAncestor("/machines/bluefin?tab=alerts", "/machines/bluefin")).toBe(false);
  });
});

describe("back from the machines pages", () => {
  it("goes up one level at a time: machine, Machines, Settings", () => {
    expect(resolveUp("/machines/bluefin", "/machines", "/machines")).toEqual({ kind: "back" });
    expect(resolveUp("/machines", "/settings", "/settings")).toEqual({ kind: "back" });
  });

  it("replaces onto the structural parent on a cold entry, never pushes a parent", () => {
    expect(resolveUp("/machines/bluefin", undefined, "/machines")).toEqual({ kind: "replace", to: "/machines" });
  });

  it("steps back onto the dashboard from a machine the Crew tab opened (ADR 0085)", () => {
    // The dashboard stores its tab per device, so stepping back lands on the Crew tab again.
    expect(resolveUp("/machines/bluefin", "/", "/machines")).toEqual({ kind: "back" });
    expect(resolveUp("/machines/bluefin", "/?h=workshop", "/machines")).toEqual({ kind: "back" });
    // A cold link has nothing behind it, so it still goes up to the list.
    expect(resolveUp("/machines/bluefin", "/", "/machines", false)).toEqual({ kind: "replace", to: "/machines" });
    expect(resolveUp("/machines", undefined, "/settings")).toEqual({ kind: "replace", to: "/settings" });
    expect(resolveUp("/machines/bluefin", "/pane/w1%3Ap1", "/machines")).toEqual({ kind: "replace", to: "/machines" });
  });
});

describe("panePath", () => {
  it("URL-encodes the colon in a pane id", () => {
    expect(panePath("wE:p2")).toBe("/pane/wE%3Ap2");
  });

  it("leaves a colon-free id alone", () => {
    expect(panePath("abc")).toBe("/pane/abc");
  });

  it("round-trips back to the original pane id via decodeURIComponent", () => {
    const id = "w1:p1";
    const encoded = panePath(id).replace("/pane/", "");
    expect(decodeURIComponent(encoded)).toBe(id);
  });

  it("omits both params on the lead's primary session (undefined/blank)", () => {
    expect(panePath("w1:p1", undefined)).toBe("/pane/w1%3Ap1");
    expect(panePath("w1:p1", {})).toBe("/pane/w1%3Ap1");
    expect(panePath("w1:p1", { host: "  ", session: "  " })).toBe("/pane/w1%3Ap1");
  });

  it("carries a named session as ?s= (encoded)", () => {
    expect(panePath("w1:p1", { session: "collie-demo" })).toBe("/pane/w1%3Ap1?s=collie-demo");
    expect(panePath("abc", { session: "a b" })).toBe("/pane/abc?s=a%20b");
  });

  it("carries a host as ?h=, always before ?s=", () => {
    expect(panePath("w1:p1", { host: "badger" })).toBe("/pane/w1%3Ap1?h=badger");
    expect(panePath("w1:p1", { host: "badger", session: "collie-demo" })).toBe(
      "/pane/w1%3Ap1?h=badger&s=collie-demo",
    );
  });
});

describe("homePath", () => {
  it("is '/' on the lead's primary session", () => {
    expect(homePath()).toBe("/");
    expect(homePath(undefined)).toBe("/");
    expect(homePath({})).toBe("/");
    expect(homePath({ session: "" })).toBe("/");
  });

  it("carries a named session as ?s=", () => {
    expect(homePath({ session: "collie-demo" })).toBe("/?s=collie-demo");
  });

  it("carries a host as ?h=, before ?s=", () => {
    expect(homePath({ host: "badger" })).toBe("/?h=badger");
    expect(homePath({ host: "badger", session: "collie-demo" })).toBe("/?h=badger&s=collie-demo");
  });
});

describe("updatesPath", () => {
  // A CHILD path of settings, not an anchor inside it — so "back" from the page lands on Settings
  // and the router can hold the two as separate routes.
  it("is a child of settings and carries the scope like the others", () => {
    expect(updatesPath()).toBe("/settings/updates");
    expect(updatesPath({})).toBe("/settings/updates");
    expect(updatesPath({ host: "badger" })).toBe("/settings/updates?h=badger");
    expect(updatesPath({ host: "badger", session: "demo" })).toBe("/settings/updates?h=badger&s=demo");
    // It is a path, not a fragment: PAIRED_DEVICES_HASH's shape would not have given it a route.
    expect(updatesPath()).not.toContain("#");
    expect(settingsPath()).toBe("/settings");
  });
});

describe("pairLandingPath", () => {
  // The QR `collie pair` prints names `/settings?pair=<code>`. The form is on System now, so the
  // index forwards a code there with the whole query, scope included.
  it("sends a pairing code to Settings → System with the query intact", () => {
    expect(pairLandingPath("?pair=ABCD2345")).toBe("/settings/system?pair=ABCD2345");
    expect(pairLandingPath("?h=badger&pair=ABCD2345")).toBe("/settings/system?h=badger&pair=ABCD2345");
  });

  it("leaves the index alone when there is no code", () => {
    expect(pairLandingPath("")).toBeNull();
    expect(pairLandingPath("?h=badger")).toBeNull();
  });
});

// ── ADR 0067: back goes up one level ────────────────────────────────────────────────────────────

describe("readFrom", () => {
  it("reads a from string beside other state", () => {
    expect(readFrom({ from: "/space/w1", freshPane: {} })).toBe("/space/w1");
  });

  it("ignores anything that is not an app path", () => {
    expect(readFrom(null)).toBeUndefined();
    expect(readFrom("from")).toBeUndefined();
    expect(readFrom({ fromList: true })).toBeUndefined();
    expect(readFrom({ from: 3 })).toBeUndefined();
    expect(readFrom({ from: "https://evil.example/" })).toBeUndefined();
  });
});

describe("ancestorsOf / isAncestor: the level tree", () => {
  it("has nothing above the dashboard", () => {
    expect(ancestorsOf("/")).toEqual([]);
  });

  it.each([
    ["/", "/space/w1", true],
    ["/?h=badger", "/space/w1", true],
    ["/settings", "/space/w1", false],
    ["/", "/pane/w1%3Ap1", true],
    ["/space/w1", "/pane/w1%3Ap1", true],
    // Any space: a pane's space is not in its path.
    ["/space/w9?h=badger", "/pane/w1%3Ap1", true],
    ["/pane/w1%3Ap2", "/pane/w1%3Ap1", false],
    ["/settings", "/pane/w1%3Ap1", false],
    ["/pane/w1%3Ap1", "/pane/w1%3Ap1/history", true],
    ["/pane/w1%3Ap2", "/pane/w1%3Ap1/history", false],
    ["/pane/w1%3Ap1/history", "/pane/w1%3Ap1", false],
    ["/pane/w1%3Ap1", "/pane/w1%3Ap1/changes", true],
    ["/", "/space/w1/changes", true],
    ["/space/w1", "/space/w1/changes", true],
    ["/space/w2", "/space/w1/changes", false],
    ["/pane/w1%3Ap1/changes?h=badger", "/pane/w1%3Ap1/changes/commit", true],
    ["/pane/w1%3Ap1", "/pane/w1%3Ap1/changes/commit", true],
    ["/pane/w1%3Ap2/changes", "/pane/w1%3Ap1/changes/commit", false],
    ["/space/w1/changes", "/space/w1/changes/commit", true],
    ["/space/w1/changes/commit", "/space/w1/changes", false],
    ["/", "/settings", true],
    ["/pane/w1%3Ap1", "/settings", false],
    ["/settings", "/settings/updates", true],
    ["/", "/settings/updates", true],
    ["/", "/crew", true],
    ["/settings", "/crew", true],
    // Machines: Settings above it, and a machine above that. The crew census and the System card
    // open both, so each is a legitimate parent there too.
    ["/settings", "/machines", true],
    ["/settings/system", "/machines", true],
    ["/", "/machines", true],
    ["/crew", "/machines", false],
    ["/machines", "/machines/bluefin", true],
    ["/machines?h=workshop", "/machines/bluefin", true],
    ["/crew", "/machines/bluefin", true],
    ["/settings", "/machines/bluefin", true],
    ["/machines/workshop", "/machines/bluefin", false],
    ["/pane/w1%3Ap1", "/machines/bluefin", false],
    // GitHub work is a child of the dashboard (ADR 0091), and of nothing else.
    ["/", "/github", true],
    ["/?h=workshop", "/github", true],
    ["/settings", "/github", false],
    ["/github", "/settings", false],
    ["/", "/nowhere", false],
  ])("%s above %s: %s", (from, here, expected) => {
    expect(isAncestor(from, here)).toBe(expected);
  });
});

describe("resolveUp: the back arrow", () => {
  it("steps back when the entry behind is a parent", () => {
    expect(resolveUp("/pane/p1", "/space/w1", "/")).toEqual({ kind: "back" });
    expect(resolveUp("/space/w1/changes", "/", "/space/w1")).toEqual({ kind: "back" });
  });

  it("replaces onto the structural parent when the entry behind is not one", () => {
    expect(resolveUp("/settings", "/pane/p1", "/")).toEqual({ kind: "replace", to: "/" });
    expect(resolveUp("/settings/updates", "/pane/p1", "/settings")).toEqual({ kind: "replace", to: "/settings" });
  });

  it("replaces on a cold entry with no from", () => {
    expect(resolveUp("/pane/p1", undefined, "/?h=badger")).toEqual({ kind: "replace", to: "/?h=badger" });
  });

  it("never steps back from the router's first entry", () => {
    expect(resolveUp("/pane/p1", "/", "/", false)).toEqual({ kind: "replace", to: "/" });
  });
});

// The Changes header arrow names this pathname, so its accessible label never disagrees with what
// the arrow itself does (changes.tsx `backAriaKey`).
describe("upTarget: naming an UP move's destination without performing it", () => {
  it("names `from` when the entry behind is a legitimate parent", () => {
    expect(upTarget("/space/w1/changes", "/", "/space/w1")).toBe("/");
    expect(upTarget("/pane/p1/changes", "/space/w1", "/pane/p1")).toBe("/space/w1");
    expect(upTarget("/pane/p1/changes", "/pane/p1", "/pane/p1")).toBe("/pane/p1");
  });

  it("names the fallback's bare pathname when the entry behind is not a parent", () => {
    expect(upTarget("/space/w1/changes", "/settings", "/space/w1")).toBe("/space/w1");
    expect(upTarget("/space/w1/changes", undefined, "/pane/p1?h=badger")).toBe("/pane/p1");
  });

  it("never steps back from the router's first entry", () => {
    expect(upTarget("/space/w1/changes", "/", "/space/w1", false)).toBe("/space/w1");
  });
});

describe("resolveUpTo: a named parent", () => {
  it("steps back only onto that very parent", () => {
    expect(resolveUpTo("/space/w1", "/space/w1")).toEqual({ kind: "back" });
    expect(resolveUpTo("/space/w1?h=a", "/space/w1")).toEqual({ kind: "back" });
  });

  it("replaces when the pane came from somewhere else", () => {
    expect(resolveUpTo("/", "/space/w1")).toEqual({ kind: "replace", to: "/space/w1" });
    expect(resolveUpTo("/space/w2", "/space/w1")).toEqual({ kind: "replace", to: "/space/w1" });
    expect(resolveUpTo(undefined, "/space/w1")).toEqual({ kind: "replace", to: "/space/w1" });
  });
});

describe("parentChain: what a cold deep link gets behind it", () => {
  it.each([
    ["/", "", []],
    ["/pane/w1%3Ap1", "", ["/"]],
    ["/pane/w1%3Ap1", "?h=badger&s=demo", ["/?h=badger&s=demo"]],
    ["/pane/w1%3Ap1/history", "?h=badger", ["/?h=badger", "/pane/w1%3Ap1?h=badger"]],
    ["/pane/w1%3Ap1/changes", "", ["/", "/pane/w1%3Ap1"]],
    ["/pane/w1%3Ap1/changes", "?repo=.&path=a.ts", ["/", "/pane/w1%3Ap1", "/pane/w1%3Ap1/changes"]],
    ["/space/w1", "", ["/"]],
    ["/space/w1/changes", "", ["/", "/space/w1"]],
    ["/space/w1/changes", "?repo=.&path=a.ts", ["/", "/space/w1", "/space/w1/changes"]],
    ["/pane/w1%3Ap1/changes/commit", "?repo=.", ["/", "/pane/w1%3Ap1", "/pane/w1%3Ap1/changes"]],
    [
      "/pane/w1%3Ap1/changes/commit",
      "?h=badger&repo=one&path=a.ts",
      ["/?h=badger", "/pane/w1%3Ap1?h=badger", "/pane/w1%3Ap1/changes?h=badger", "/pane/w1%3Ap1/changes/commit?h=badger&repo=one"],
    ],
    ["/space/w1/changes/commit", "?repo=.&path=a.ts", ["/", "/space/w1", "/space/w1/changes", "/space/w1/changes/commit?repo=."]],
    // The Changes tree: every folder above the target sits behind it, then the Changes screen that
    // is the tree's root, then that screen's own way up (ADR 0083). With neither `?dir=` nor `?path=`
    // the address is the root itself, spelled the way it was before 2026-10-06.
    ["/pane/w1%3Ap1/changes/files", "", ["/", "/pane/w1%3Ap1"]],
    ["/pane/w1%3Ap1/changes/files", "?dir=a", ["/", "/pane/w1%3Ap1", "/pane/w1%3Ap1/changes"]],
    [
      "/pane/w1%3Ap1/changes/files",
      "?h=badger&dir=a%2Fb",
      ["/?h=badger", "/pane/w1%3Ap1?h=badger", "/pane/w1%3Ap1/changes?h=badger", "/pane/w1%3Ap1/changes/files?h=badger&dir=a"],
    ],
    [
      "/space/w1/changes/files",
      "?path=a%2Fb%2Fc.md",
      ["/", "/space/w1", "/space/w1/changes", "/space/w1/changes/files?dir=a", "/space/w1/changes/files?dir=a%2Fb"],
    ],
    ["/space/w1/changes/files", "?path=README.md", ["/", "/space/w1", "/space/w1/changes"]],
    ["/settings", "", ["/"]],
    // Both are opened from the System section now, so a cold deep link gets the index AND that
    // section behind it — two taps back to home, matching the two pushes that would have got here.
    ["/settings/updates", "", ["/", "/settings", "/settings/system"]],
    ["/settings/device", "", ["/", "/settings"]],
    ["/crew", "", ["/", "/settings", "/settings/system"]],
    // Machines sits under Settings, and one machine under Machines: a cold deep link gets both behind it.
    ["/machines", "", ["/", "/settings"]],
    ["/machines/bluefin", "", ["/", "/settings", "/machines"]],
    ["/machines/bluefin", "?h=badger", ["/?h=badger", "/settings?h=badger", "/machines?h=badger"]],
    ["/github", "", ["/"]],
    ["/github", "?h=workshop", ["/?h=workshop"]],
    ["/nowhere", "", []],
  ])("%s%s → %j", (pathname, search, expected) => {
    expect(parentChain(pathname, search)).toEqual(expected);
  });
});

describe("the Changes tree's paths", () => {
  it("is the Changes screen's child route, with a folder or a file in the query", () => {
    expect(filesPath("w1:p1", undefined, { dir: "src/lib" })).toBe("/pane/w1%3Ap1/changes/files?dir=src%2Flib");
    expect(filesPath("w1:p1", undefined, { path: "a b.md" })).toBe("/pane/w1%3Ap1/changes/files?path=a+b.md");
    expect(spaceFilesPath("w1", undefined, { dir: "docs" })).toBe("/space/w1/changes/files?dir=docs");
  });

  it("carries a file's line after its path, and only a real line of a file (ADR 0088)", () => {
    expect(filesPath("w1:p1", undefined, { path: "src/a.ts", line: 12 })).toBe("/pane/w1%3Ap1/changes/files?path=src%2Fa.ts&line=12");
    expect(filesPath("w1:p1", undefined, { path: "a.ts", line: 0 })).toBe("/pane/w1%3Ap1/changes/files?path=a.ts");
    expect(filesPath("w1:p1", undefined, { dir: "src", line: 3 })).toBe("/pane/w1%3Ap1/changes/files?dir=src");
  });

  it("keeps the machine and session in front of the folder", () => {
    expect(filesPath("w1:p1", { host: "badger" }, { dir: "a" })).toBe("/pane/w1%3Ap1/changes/files?h=badger&dir=a");
  });

  it("names the root as the Changes screen itself", () => {
    expect(filesPath("w1:p1")).toBe("/pane/w1%3Ap1/changes");
    expect(filesPath("w1:p1", undefined, {})).toBe("/pane/w1%3Ap1/changes");
    expect(filesPath("w1:p1", undefined, { dir: "" })).toBe("/pane/w1%3Ap1/changes");
    expect(spaceFilesPath("w1", { host: "badger" })).toBe("/space/w1/changes?h=badger");
  });
});

describe("filesParent: one level up inside the Changes tree", () => {
  it("takes a file to its folder, a folder to its parent, and a top-level folder to the root", () => {
    expect(filesParent({ path: "a/b/c.md" })).toEqual({ dir: "a/b" });
    expect(filesParent({ dir: "a/b" })).toEqual({ dir: "a" });
    expect(filesParent({ dir: "a" })).toEqual({});
    expect(filesParent({ path: "README.md" })).toEqual({});
  });

  it("has none at the root, where the way up is the list's own", () => {
    expect(filesParent({})).toBeNull();
    expect(filesParent({ dir: "" })).toBeNull();
  });
});

describe("filesFolders", () => {
  it("lists every folder above a file, and every folder down to a folder", () => {
    expect(filesFolders({ path: "a/b/c.md" })).toEqual(["a", "a/b"]);
    expect(filesFolders({ dir: "a/b" })).toEqual(["a", "a/b"]);
    expect(filesFolders({ path: "c.md" })).toEqual([]);
  });
});

describe("the Changes tree in the level tree", () => {
  it("sits below the Changes screen, then shares its parents", () => {
    expect(ancestorsOf("/pane/w1/changes/files")).toEqual(["/pane/w1/changes", "/pane/w1", "/space/*", "/"]);
    expect(ancestorsOf("/space/w1/changes/files")).toEqual(["/space/w1/changes", "/space/w1", "/"]);
    expect(isAncestor("/pane/w1/changes?h=badger", "/pane/w1/changes/files")).toBe(true);
    expect(isAncestor("/", "/space/w1/changes/files")).toBe(true);
    expect(isAncestor("/space/w2", "/space/w1/changes/files")).toBe(false);
    expect(isAncestor("/space/w2/changes", "/space/w1/changes/files")).toBe(false);
  });
});

describe("resolveUpToExact: a folder level of the Files view", () => {
  const parent = "/pane/w1/changes/files?dir=a";

  it("steps back only onto that very folder", () => {
    expect(resolveUpToExact(parent, parent)).toEqual({ kind: "back" });
    expect(resolveUpToExact("/pane/w1/changes/files?dir=a#top", parent)).toEqual({ kind: "back" });
  });

  it("does not take another folder of the same pathname for the parent", () => {
    expect(resolveUpToExact("/pane/w1/changes/files?dir=b", parent)).toEqual({ kind: "replace", to: parent });
    expect(resolveUpToExact("/pane/w1/changes/files", parent)).toEqual({ kind: "replace", to: parent });
  });

  it("replaces on a cold entry and never steps back from the first entry", () => {
    expect(resolveUpToExact(undefined, parent)).toEqual({ kind: "replace", to: parent });
    expect(resolveUpToExact(parent, parent, false)).toEqual({ kind: "replace", to: parent });
  });

  it("reads the same query in any order", () => {
    expect(resolveUpToExact("/pane/w1/changes/files?dir=a&h=badger", "/pane/w1/changes/files?h=badger&dir=a")).toEqual({
      kind: "back",
    });
  });
});

describe("resolveTreeUp: the arrow inside the Files tree goes back where you came from", () => {
  const parent = "/pane/w1/changes/files?dir=src/lib";

  it("steps back onto a pane that printed the path, not up the folders", () => {
    expect(resolveTreeUp("/pane/w1", parent)).toEqual({ kind: "back" });
  });

  it("steps back onto the diff a Preview came from, and onto a Markdown file a link came from", () => {
    expect(resolveTreeUp("/pane/w1/changes?repo=.&path=a.ts", parent)).toEqual({ kind: "back" });
    expect(resolveTreeUp("/pane/w1/changes/files?path=docs/README.md", parent)).toEqual({ kind: "back" });
  });

  it("still steps back onto the parent folder when that is where it came from", () => {
    expect(resolveTreeUp(parent, parent)).toEqual({ kind: "back" });
  });

  it("replaces onto the parent folder on a cold deep link and on the first entry", () => {
    expect(resolveTreeUp(undefined, parent)).toEqual({ kind: "replace", to: parent });
    expect(resolveTreeUp("/pane/w1", parent, false)).toEqual({ kind: "replace", to: parent });
  });
});

describe("treeUpLanding: naming where the tree's arrow lands", () => {
  it("names a pane, its history, a space and the dashboard", () => {
    expect(treeUpLanding("/pane/w1:p2?h=badger", true, false)).toBe("pane");
    expect(treeUpLanding("/pane/w1/history", true, false)).toBe("pane");
    expect(treeUpLanding("/space/w1", true, false)).toBe("workspace");
    expect(treeUpLanding("/", true, false)).toBe("dashboard");
  });

  it("names a Changes diff or the change list as the list", () => {
    expect(treeUpLanding("/pane/w1/changes?repo=.&path=a.ts", true, false)).toBe("list");
    expect(treeUpLanding("/space/w1/changes/commit?repo=.", true, false)).toBe("list");
    expect(treeUpLanding("/space/w1/changes", false, true)).toBe("list");
  });

  it("keeps the folder and parent labels when it steps back onto the tree's own root, folders and files", () => {
    expect(treeUpLanding("/space/w1/changes", false, false)).toBe("parent");
    expect(treeUpLanding("/pane/w1/changes/files?dir=a", false, false)).toBe("parent");
    expect(treeUpLanding("/pane/w1/changes/files?path=a/b.md", true, false)).toBe("folder");
  });

  it("keeps the labels the arrow always had when it replaces", () => {
    expect(treeUpLanding(undefined, true, false)).toBe("folder");
    expect(treeUpLanding(undefined, false, false)).toBe("parent");
    expect(treeUpLanding("/pane/w1", false, false, false)).toBe("parent");
  });
});

describe("readPreviewAsked: the diff's Preview offer", () => {
  it("is true only for the one value the offer writes", () => {
    expect(readPreviewAsked({ from: "/pane/w1/changes", fileView: "preview" })).toBe(true);
    expect(readPreviewAsked({ fileView: "source" })).toBe(false);
    expect(readPreviewAsked(null)).toBe(false);
    expect(readPreviewAsked(undefined)).toBe(false);
  });
});

describe("two spellings of one pane id", () => {
  it("a colon and %3A name the same screen for every up move", () => {
    expect(isAncestor("/pane/w1:p2", "/pane/w1%3Ap2/changes")).toBe(true);
    expect(isAncestor("/pane/w1%3Ap2", "/pane/w1:p2/history")).toBe(true);
    expect(resolveUp("/pane/w1%3Ap2/changes", "/pane/w1:p2", "/pane/w1%3Ap2")).toEqual({ kind: "back" });
    expect(resolveUpTo("/space/w1%3Ax", "/space/w1:x")).toEqual({ kind: "back" });
    expect(resolveUpToExact("/pane/w1:p2/changes/files?dir=a", "/pane/w1%3Ap2/changes/files?dir=a")).toEqual({ kind: "back" });
  });

  it("keeps a segment that is not valid encoding as written", () => {
    expect(decodedPath("/pane/w1%zz")).toBe("/pane/w1%zz");
    expect(isAncestor("/pane/w1%zz", "/pane/w1%zz/changes")).toBe(true);
  });
});

