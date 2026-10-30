import { describe, expect, test } from "bun:test";

import { bareAddress, inScope, isSelf, labelOf, labelScope, paneAddress, parseAddress } from "./address.ts";

describe("an address", () => {
  test("names one pane, one machine's panes, or every pane", () => {
    expect(parseAddress("bluefin/w6:p3")).toEqual({ kind: "pane", memberId: "bluefin", paneId: "w6:p3", instance: null });
    expect(parseAddress("local/%7")).toEqual({ kind: "pane", memberId: "local", paneId: "%7", instance: null });
    expect(parseAddress("minibuch/all")).toEqual({ kind: "member-all", memberId: "minibuch" });
    expect(parseAddress("all")).toEqual({ kind: "all" });
  });

  test("refuses anything a path could be built from", () => {
    for (const bad of ["", "/w1", "local/", "local/../x", "local/..", "local/a/b", "Bad/w1", "local/a b", "local/a\u0000"]) expect(parseAddress(bad)).toBeNull();
  });

  test("may name one pane instance after a `#`: four characters of [a-z0-9]", () => {
    expect(parseAddress("bluefin/w6:p3#k3f9")).toEqual({ kind: "pane", memberId: "bluefin", paneId: "w6:p3", instance: "k3f9" });
    expect(parseAddress("local/terminal_1#0a0a")).toEqual({ kind: "pane", memberId: "local", paneId: "terminal_1", instance: "0a0a" });
    for (const bad of ["local/w1#", "local/w1#K3F9", "local/w1#k3f", "local/w1#k3f9x", "local/w1#k3f9#k3f9", "local/#k3f9", "local/all#k3f9", "all#k3f9", "local/..#k3f9"]) {
      expect(parseAddress(bad)).toBeNull();
    }
  });

  test("prints the token when given, and a receipt's target drops it", () => {
    expect(paneAddress("desk", "w1:p2", "k3f9")).toBe("desk/w1:p2#k3f9");
    expect(paneAddress(null, "w1:p2", null)).toBe("local/w1:p2");
    expect(bareAddress("desk/w1:p2#k3f9")).toBe("desk/w1:p2");
    for (const kept of ["desk/w1:p2", "desk/all", "all", "not an address"]) expect(bareAddress(kept)).toBe(kept);
  });

  test("a solo pane's address uses `local`", () => {
    expect(paneAddress(null, "w1:p2")).toBe("local/w1:p2");
    expect(paneAddress("desk", "w1:p2")).toBe("desk/w1:p2");
  });

  test("`local` is always this bridge, and so is its own member id", () => {
    expect(isSelf("local", null)).toBe(true);
    expect(isSelf("local", "desk")).toBe(true);
    expect(isSelf("desk", "desk")).toBe(true);
    expect(isSelf("laptop", "desk")).toBe(false);
    expect(isSelf("desk", null)).toBe(false);
  });
});

describe("a pane's label", () => {
  const pane = { paneId: "w1:p2", cwd: "/home/a/projects/collie", branch: "fix-465" };

  test("is repo#branch when the folder is on a branch", () => {
    expect(labelOf(pane, true)).toBe("collie#fix-465");
  });

  test("falls back to the pane's label, the title (when titles show), the folder, the pane id", () => {
    expect(labelOf({ ...pane, branch: null, paneLabel: "review" }, true)).toBe("review");
    expect(labelOf({ ...pane, branch: null, terminalTitle: "vim" }, true)).toBe("vim");
    expect(labelOf({ ...pane, branch: null, terminalTitle: "vim" }, false)).toBe("collie");
    expect(labelOf({ ...pane, cwd: "", branch: null }, true)).toBe("w1:p2");
  });
});

describe("a workspace address", () => {
  test("`<repo>` names a folder on any branch", () => {
    expect(parseAddress("collie-workspace")).toEqual({ kind: "workspace", repo: "collie-workspace", branch: null });
    expect(parseAddress("  collie-workspace ")).toEqual({ kind: "workspace", repo: "collie-workspace", branch: null });
  });

  test("`<repo>#<branch>` names a folder on one branch, split on the first `#`", () => {
    expect(parseAddress("collie-workspace#main")).toEqual({ kind: "workspace", repo: "collie-workspace", branch: "main" });
    expect(parseAddress("collie#feat/x#2")).toEqual({ kind: "workspace", repo: "collie", branch: "feat/x#2" });
    expect(parseAddress("My Project#main")).toEqual({ kind: "workspace", repo: "My Project", branch: "main" });
  });

  test("`here` is the sender's own folder", () => {
    expect(parseAddress("here")).toEqual({ kind: "here" });
  });

  test("refuses an empty repo, an empty branch, and characters a label cannot carry", () => {
    const bad = ["#main", "repo#", "#", "re[po]", "repo#br(anch)", "all#k3f9", "here#main", "a".repeat(49), `repo#${"b".repeat(49)}`, "repo\u0000", "r\u00e9po"];
    for (const value of bad) expect(parseAddress(value)).toBeNull();
  });

  test("`all` and every pane form read as before", () => {
    expect(parseAddress("all")).toEqual({ kind: "all" });
    expect(parseAddress("desk/all")).toEqual({ kind: "member-all", memberId: "desk" });
    expect(parseAddress("desk/w1:p2#k3f9")).toEqual({ kind: "pane", memberId: "desk", paneId: "w1:p2", instance: "k3f9" });
    expect(parseAddress("desk/w1:p2")).toEqual({ kind: "pane", memberId: "desk", paneId: "w1:p2", instance: null });
    expect(parseAddress("/w1")).toBeNull();
    expect(parseAddress("all#k3f9")).toBeNull();
  });

  test("a bare word is only marked as a workspace: member ids are not checked here", () => {
    expect(parseAddress("local")).toEqual({ kind: "workspace", repo: "local", branch: null });
  });
});

describe("the scope a label stands in (M75)", () => {
  test("`<repo>#<branch>` splits on the first `#`; a label with none is a folder on no branch; the bare pane id is no folder", () => {
    expect(labelScope("collie-workspace#main", "w1:p1")).toEqual({ repo: "collie-workspace", branch: "main" });
    expect(labelScope("collie#feat/x#2", "w1:p1")).toEqual({ repo: "collie", branch: "feat/x#2" });
    expect(labelScope("notes", "w1:p1")).toEqual({ repo: "notes", branch: null });
    expect(labelScope("w1:p1", "w1:p1")).toBeNull();
    expect(labelScope("-", "w1:p1")).toBeNull();
    expect(labelScope("#main", "w1:p1")).toBeNull();
  });

  test("a pane is in a scope when its repo matches, and its branch too when the scope names one", () => {
    expect(inScope("collie-workspace#main", "w1:p1", { repo: "collie-workspace", branch: null })).toBe(true);
    expect(inScope("collie-workspace#feat", "w1:p1", { repo: "collie-workspace", branch: "main" })).toBe(false);
    expect(inScope("collie-workspace#main", "w1:p1", { repo: "collie-workspace", branch: "main" })).toBe(true);
    expect(inScope("collie#main", "w1:p1", { repo: "collie-workspace", branch: null })).toBe(false);
    expect(inScope("w1:p1", "w1:p1", { repo: "w1:p1", branch: null })).toBe(false);
  });
});
