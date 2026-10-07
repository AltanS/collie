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

describe("clock while hidden", () => {
  function rig() {
    let t = 100;
    let visible = true;
    const watchers = new Set<() => void>();
    const beat: Beat = { tick: null };
    const log = { starts: 0, stops: 0 };
    const clock = createClock(
      () => t,
      (fn) => {
        beat.tick = fn;
        log.starts++;
        return () => {
          beat.tick = null;
          log.stops++;
        };
      },
      {
        visible: () => visible,
        onChange(fn) {
          watchers.add(fn);
          return () => watchers.delete(fn);
        },
      },
    );
    return {
      clock,
      beat,
      log,
      watchers,
      setTime: (n: number) => (t = n),
      show(on: boolean) {
        visible = on;
        for (const fn of watchers) fn();
      },
    };
  }

  test("the interval stops when the page hides and restarts from the present when it shows", () => {
    const r = rig();
    const seen: number[] = [];
    const stop = r.clock.subscribe(() => seen.push(r.clock.get()));
    expect(r.log.starts).toBe(1);
    r.setTime(200);
    r.beat.tick?.();
    r.show(false);
    expect(r.log.stops).toBe(1);
    expect(r.beat.tick).toBeNull();
    expect(r.clock.listeners()).toBe(1); // the listener stays
    r.setTime(5000);
    r.show(false); // a repeated hidden event changes nothing
    expect(r.log.stops).toBe(1);
    seen.length = 0;
    r.show(true);
    expect(r.log.starts).toBe(2);
    expect(r.clock.get()).toBe(5000);
    expect(seen).toEqual([5000]); // one notification for the present
    stop();
    expect(r.log.stops).toBe(2);
    expect(r.watchers.size).toBe(0);
  });

  test("a first listener on a hidden page starts nothing until the page shows", () => {
    const r = rig();
    r.show(false);
    const stop = r.clock.subscribe(() => {});
    expect(r.log.starts).toBe(0);
    expect(r.watchers.size).toBe(1);
    r.setTime(900);
    r.show(true);
    expect(r.log.starts).toBe(1);
    expect(r.clock.get()).toBe(900);
    stop();
    expect(r.watchers.size).toBe(0);
    expect(r.log.stops).toBe(1);
  });

  test("a listener that leaves while hidden drops the visibility watcher, nothing to stop twice", () => {
    const r = rig();
    const stop = r.clock.subscribe(() => {});
    r.show(false);
    stop();
    expect(r.watchers.size).toBe(0);
    expect(r.log.stops).toBe(1);
  });
});
