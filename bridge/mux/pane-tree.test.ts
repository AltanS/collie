import { describe, expect, test } from "bun:test";

import { paneTreeOf, TREE_ROLE_MAX } from "./pane-tree.ts";

describe("paneTreeOf", () => {
  test("reads the three collie_ names", () => {
    expect(paneTreeOf({ collie_id: "a1b2c3", collie_parent: "ff00aa", collie_role: "worker" })).toEqual({
      id: "a1b2c3",
      parent: "ff00aa",
      role: "worker",
    });
  });

  test("a root has an id and no parent; a leaf may have a parent and no id", () => {
    expect(paneTreeOf({ collie_id: "root1", collie_role: "coordinator" })).toEqual({ id: "root1", role: "coordinator" });
    expect(paneTreeOf({ collie_parent: "root1" })).toEqual({ parent: "root1" });
  });

  test("no tree without an id or a parent, whatever else the pane carries", () => {
    expect(paneTreeOf(undefined)).toBeUndefined();
    expect(paneTreeOf(null)).toBeUndefined();
    expect(paneTreeOf({})).toBeUndefined();
    expect(paneTreeOf({ collie_role: "worker" })).toBeUndefined();
    // Another program's own names are not Collie's.
    expect(paneTreeOf({ role: "worker", parent: "tclaw-02/w1Q:p1" })).toBeUndefined();
  });

  test("an id that is not a plain word is dropped whole, never cleaned", () => {
    expect(paneTreeOf({ collie_id: "tclaw-02/w1Q:p1" })).toBeUndefined();
    expect(paneTreeOf({ collie_id: "a b" })).toBeUndefined();
    expect(paneTreeOf({ collie_id: "x".repeat(65) })).toBeUndefined();
    expect(paneTreeOf({ collie_id: "ok", collie_parent: "../../etc" })).toEqual({ id: "ok" });
  });

  test("a pane never parents itself", () => {
    expect(paneTreeOf({ collie_id: "same", collie_parent: "same" })).toEqual({ id: "same" });
  });

  test("a role is a short word or nothing", () => {
    expect(paneTreeOf({ collie_id: "a", collie_role: "  research  " })?.role).toBe("research");
    expect(paneTreeOf({ collie_id: "a", collie_role: "code review" })?.role).toBe("code review");
    expect(paneTreeOf({ collie_id: "a", collie_role: "x".repeat(TREE_ROLE_MAX) })?.role).toBe("x".repeat(TREE_ROLE_MAX));
    expect(paneTreeOf({ collie_id: "a", collie_role: "x".repeat(TREE_ROLE_MAX + 1) })?.role).toBeUndefined();
    expect(paneTreeOf({ collie_id: "a", collie_role: "evil‮word" })?.role).toBeUndefined();
    expect(paneTreeOf({ collie_id: "a", collie_role: "line\nbreak" })?.role).toBeUndefined();
    expect(paneTreeOf({ collie_id: "a", collie_role: "" })?.role).toBeUndefined();
  });
});
