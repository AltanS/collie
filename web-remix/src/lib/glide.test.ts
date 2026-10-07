/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { createGlideScheduler } from "./glide-queue";

// The glide's scheduler, in the shape of kody's `view-transition-scheduler.node.test.ts` (research
// note 07, c.3), over a fake transition whose `updateCallbackDone` a test settles by hand. The
// differences from kody are on purpose: a job is a navigation, so a superseded one still goes
// (instantly) and only a STALE one is dropped.

interface Job {
  name: string;
  /** Settles the fake `updateCallbackDone` of this job's transition. */
  callback: PromiseWithResolvers<void>;
  stale?: boolean;
}

function job(name: string, stale = false): Job {
  return { name, callback: Promise.withResolvers<void>(), stale };
}

function rig(options: { throwFor?: string } = {}) {
  const log: string[] = [];
  const scheduler = createGlideScheduler<Job>({
    begin(j) {
      if (j.name === options.throwFor) throw new DOMException("Transition was aborted because of invalid state", "InvalidStateError");
      log.push(`begin:${j.name}`);
      return j.callback.promise;
    },
    instant(j) {
      log.push(`instant:${j.name}`);
    },
    isStale: (j) => j.stale === true,
  });
  return { log, scheduler };
}

describe("glide scheduler", () => {
  test("a job starts at once when no callback is pending", () => {
    const { log, scheduler } = rig();
    scheduler.schedule(job("a"));
    expect(log).toEqual(["begin:a"]);
  });

  test("waits for the prior update callback before starting the next transition", async () => {
    const { log, scheduler } = rig();
    const a = job("a");
    scheduler.schedule(a);
    scheduler.schedule(job("b"));
    expect(log).toEqual(["begin:a"]); // b waits
    expect(scheduler.busy()).toBe(true);
    a.callback.resolve();
    await scheduler.whenSettled();
    expect(log).toEqual(["begin:a", "begin:b"]);
  });

  test("latest wins: a job that loses the slot still moves, instantly, in arrival order", async () => {
    const { log, scheduler } = rig();
    const a = job("a");
    const b = job("b");
    scheduler.schedule(a);
    scheduler.schedule(b);
    scheduler.schedule(job("c"));
    // b lost its slot to c: its navigation goes now, with no transition. c still waits.
    expect(log).toEqual(["begin:a", "instant:b"]);
    a.callback.resolve();
    await scheduler.whenSettled();
    expect(log).toEqual(["begin:a", "instant:b", "begin:c"]);
  });

  test("an instant path cancels the queued transition and keeps its move, before its own", async () => {
    const { log, scheduler } = rig();
    const a = job("a");
    scheduler.schedule(a);
    scheduler.schedule(job("b"));
    scheduler.instant(job("c"));
    expect(log).toEqual(["begin:a", "instant:b", "instant:c"]);
    a.callback.resolve();
    await scheduler.whenSettled();
    expect(log).toEqual(["begin:a", "instant:b", "instant:c"]); // nothing is started late
    expect(scheduler.busy()).toBe(false);
  });

  test("falls back to an instant move when startViewTransition throws", () => {
    const { log, scheduler } = rig({ throwFor: "x" });
    scheduler.schedule(job("x"));
    expect(log).toEqual(["instant:x"]);
    expect(scheduler.busy()).toBe(false);
    scheduler.schedule(job("y")); // the failure left nothing stuck
    expect(log).toEqual(["instant:x", "begin:y"]);
  });

  test("a throw while draining falls back too, and the slot is free after it", async () => {
    const { log, scheduler } = rig({ throwFor: "b" });
    const a = job("a");
    scheduler.schedule(a);
    scheduler.schedule(job("b"));
    a.callback.resolve();
    await scheduler.whenSettled();
    expect(log).toEqual(["begin:a", "instant:b"]);
    expect(scheduler.busy()).toBe(false);
  });

  test("a queued job the location outran is dropped, not replayed", async () => {
    const { log, scheduler } = rig();
    const a = job("a");
    scheduler.schedule(a);
    scheduler.schedule(job("b", true));
    a.callback.resolve();
    await scheduler.whenSettled();
    expect(log).toEqual(["begin:a"]);
    expect(scheduler.busy()).toBe(false);
  });

  test("a rejected callback (a skipped transition) ends the wait and drains the slot, with no unhandled rejection", async () => {
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { log, scheduler } = rig();
      const a = job("a");
      scheduler.schedule(a);
      scheduler.schedule(job("b"));
      a.callback.reject(new DOMException("skipped", "AbortError"));
      await scheduler.whenSettled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(log).toEqual(["begin:a", "begin:b"]);
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("after the last callback settles the scheduler is idle and the next job starts at once", async () => {
    const { log, scheduler } = rig();
    const a = job("a");
    scheduler.schedule(a);
    a.callback.resolve();
    await scheduler.whenSettled();
    expect(scheduler.busy()).toBe(false);
    scheduler.schedule(job("b"));
    expect(log).toEqual(["begin:a", "begin:b"]);
  });
});
