import {
  ancestorsOf,
  changesCommitPath,
  homePath,
  isAncestor,
  panePath,
  parentChain,
  readFrom,
  resolveUp,
  resolveUpTo,
  settingsPath,
  spaceChangesCommitPath,
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
    ["/settings", "", ["/"]],
    ["/settings/updates", "", ["/", "/settings"]],
    ["/crew", "", ["/"]],
    ["/nowhere", "", []],
  ])("%s%s → %j", (pathname, search, expected) => {
    expect(parentChain(pathname, search)).toEqual(expected);
  });
});
