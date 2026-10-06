/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { createClock } from "./clock";
import { clearStatus, setStatus, status } from "./status";

describe("status", () => {
  test("each set is a new message id; an error stays, info expires", async () => {
    const a = setStatus("one");
    const b = setStatus("one");
    expect(b.id).not.toBe(a.id);
    expect(status.get()).toBe(b);
    setStatus("short", "info", { ttlMs: 5 });
    await Bun.sleep(20);
    expect(status.get()).toBeNull();
    const err = setStatus("broken", "error", { detail: "stack" });
    expect(err.detail).toBe("stack");
    await Bun.sleep(20);
    expect(status.get()).toBe(err);
    clearStatus();
    expect(status.get()).toBeNull();
  });

  test("no detail key when none was given", () => {
    expect("detail" in setStatus("plain")).toBe(false);
    clearStatus();
  });
});

interface Beat {
  tick: (() => void) | null;
}

describe("clock", () => {
  test("runs its interval only while someone listens, and starts from the present", () => {
    let t = 100;
    const beat: Beat = { tick: null };
    let running = 0;
    const clock = createClock(
      () => t,
      (fn) => {
        beat.tick = fn;
        running++;
        return () => {
          beat.tick = null;
          running--;
        };
      },
    );
    expect(running).toBe(0);
    t = 200;
    const ctl = new AbortController();
    const stop = clock.subscribe(() => {}, ctl.signal);
    expect(clock.get()).toBe(200);
    expect(running).toBe(1);
    const stop2 = clock.subscribe(() => {});
    expect(running).toBe(1);
    t = 300;
    beat.tick?.();
    expect(clock.get()).toBe(300);
    ctl.abort();
    stop(); // a second stop after abort is a no-op
    expect(clock.listeners()).toBe(1);
    stop2();
    expect(running).toBe(0);
    expect(beat.tick).toBeNull();
  });
});
