import { describe, expect, test } from "bun:test";

import { isSelf, labelOf, paneAddress, parseAddress } from "./address.ts";

describe("an address", () => {
  test("names one pane, one machine's panes, or every pane", () => {
    expect(parseAddress("bluefin/w6:p3")).toEqual({ kind: "pane", memberId: "bluefin", paneId: "w6:p3" });
    expect(parseAddress("local/%7")).toEqual({ kind: "pane", memberId: "local", paneId: "%7" });
    expect(parseAddress("minibuch/all")).toEqual({ kind: "member-all", memberId: "minibuch" });
    expect(parseAddress("all")).toEqual({ kind: "all" });
  });

  test("refuses anything a path could be built from", () => {
    for (const bad of ["", "/w1", "local/", "local/../x", "local/..", "local/a/b", "Bad/w1", "local/a b", "local/a\u0000"]) expect(parseAddress(bad)).toBeNull();
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
