/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { createScrollRestore, RESTORE_WINDOW_MS } from "./scroll-restore";

describe("scroll restore", () => {
  test("a reachable target is written once and the restore ends", () => {
    const restore = createScrollRestore();
    restore.arm(600, 0);
    expect(restore.armed).toBe(true);
    expect(restore.step({ at: 0, max: 1200 }, 10)).toEqual({ kind: "write", top: 600 });
    expect(restore.armed).toBe(false);
    expect(restore.step({ at: 600, max: 1200 }, 20)).toEqual({ kind: "done" });
  });

  test("a target the content cannot reach yet waits, then lands when the content grows", () => {
    const restore = createScrollRestore();
    restore.arm(600, 0);
    expect(restore.step({ at: 0, max: 150 }, 5)).toEqual({ kind: "wait" });
    expect(restore.step({ at: 0, max: 400 }, 400)).toEqual({ kind: "wait" });
    expect(restore.step({ at: 0, max: 1500 }, 900)).toEqual({ kind: "write", top: 600 });
    expect(restore.armed).toBe(false);
  });

  test("the first write already landed: nothing to write", () => {
    const restore = createScrollRestore();
    restore.arm(600, 0);
    expect(restore.step({ at: 600, max: 1200 }, 5)).toEqual({ kind: "done" });
    restore.arm(600, 0);
    expect(restore.step({ at: 599.5, max: 1200 }, 5)).toEqual({ kind: "done" }); // sub-pixel slack
  });

  test("gives up after the window and keeps nothing armed", () => {
    const restore = createScrollRestore();
    restore.arm(600, 1_000);
    expect(restore.step({ at: 0, max: 100 }, 1_000 + RESTORE_WINDOW_MS - 1)).toEqual({ kind: "wait" });
    expect(restore.step({ at: 0, max: 100 }, 1_000 + RESTORE_WINDOW_MS)).toEqual({ kind: "done" });
    expect(restore.armed).toBe(false);
    // A late growth after the window does not restore.
    expect(restore.step({ at: 0, max: 5_000 }, 1_000 + RESTORE_WINDOW_MS + 500)).toEqual({ kind: "done" });
  });

  test("the reader's touch, wheel or key cancels it", () => {
    const restore = createScrollRestore();
    restore.arm(600, 0);
    restore.cancel();
    expect(restore.armed).toBe(false);
    expect(restore.step({ at: 40, max: 5_000 }, 100)).toEqual({ kind: "done" });
  });

  test("the browser's clamp is not remembered while a taller target is kept", () => {
    const restore = createScrollRestore();
    restore.arm(600, 0);
    expect(restore.holds(0)).toBe(true);
    expect(restore.holds(150)).toBe(true); // clamped to the short content's end
    expect(restore.holds(600)).toBe(false); // the target itself is a real position
    expect(restore.holds(900)).toBe(false);
    restore.cancel();
    expect(restore.holds(150)).toBe(false); // once the reader took over, their spot counts
  });

  test("a target at the top arms nothing", () => {
    const restore = createScrollRestore();
    restore.arm(0, 0);
    expect(restore.armed).toBe(false);
    expect(restore.holds(0)).toBe(false);
    expect(restore.step({ at: 0, max: 100 }, 1)).toEqual({ kind: "done" });
  });

  test("arming again replaces the target and the window", () => {
    const restore = createScrollRestore();
    restore.arm(600, 0);
    restore.arm(300, 10_000);
    expect(restore.step({ at: 0, max: 400 }, 10_001)).toEqual({ kind: "write", top: 300 });
  });
});
