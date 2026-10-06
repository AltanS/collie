/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { collapseContent, collapseEntered, collapseExited, collapseInitial, collapseSettled, collapseStep, isEmptyNode } from "./collapse";

describe("Collapse state", () => {
  test("holds its last child through the exit, then lets go", () => {
    let s = collapseInitial(true, "notice A");
    let step = collapseStep(s, true, "notice B", false);
    s = step.state;
    expect(step.effect).toBe("none");
    // The caller closes and drops the child in the same render (`open && <Notice/>`).
    step = collapseStep(s, false, null, false);
    s = step.state;
    expect(step.effect).toBe("exit");
    expect(s.rendered).toBe(true);
    expect(collapseContent(s, null)).toBe("notice B");
    s = collapseExited(s);
    expect(s.rendered).toBe(false);
    expect(collapseContent(s, null)).toBeNull();
  });

  test("an empty child while open does not replace the held one", () => {
    let s = collapseInitial(true, "card");
    s = collapseStep(s, true, false, false).state;
    expect(s.held).toBe("card");
  });

  test("enter starts at 0fr, expands after two frames, drops the clip after the duration", () => {
    let s = collapseInitial(false, null);
    expect(s.rendered).toBe(false);
    const step = collapseStep(s, true, "x", false);
    expect(step.effect).toBe("enter");
    s = step.state;
    expect(s).toMatchObject({ rendered: true, expanded: false, settled: false });
    s = collapseEntered(s);
    expect(s.expanded).toBe(true);
    s = collapseSettled(s);
    expect(s.settled).toBe(true);
  });

  test("reduced motion opens expanded at once", () => {
    const s = collapseStep(collapseInitial(false, null), true, "x", true).state;
    expect(s.expanded).toBe(true);
  });

  test("a late timer from a close does not undo a reopen", () => {
    let s = collapseInitial(true, "a");
    s = collapseStep(s, false, null, false).state;
    s = collapseStep(s, true, "b", false).state;
    expect(collapseExited(s).rendered).toBe(true);
  });

  test("isEmptyNode matches what a bare conditional renders as nothing", () => {
    for (const n of [null, undefined, false, true, "", [null, false]]) expect(isEmptyNode(n)).toBe(true);
    for (const n of ["x", 0, ["", "y"]]) expect(isEmptyNode(n)).toBe(false);
  });
});
