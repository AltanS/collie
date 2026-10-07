/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createStore, framesHeld, holdFrames, scheduleUpdate, useStoreSelect, type Updatable } from "./store";

// The coalescer reads `document.visibilityState`, `requestAnimationFrame`, `cancelAnimationFrame` and
// `window.setTimeout` at call time. Each is a hand-cranked fake here: frames and timers run only when
// the test says so, the way Chromium runs no frame while a view transition's callback is pending.
class Clock {
  frames = new Map<number, () => void>();
  timers = new Map<number, () => void>();
  cancelled: number[] = [];
  #next = 1;
  frame(fn: () => void): number {
    const id = this.#next++;
    this.frames.set(id, fn);
    return id;
  }
  timer(fn: () => void): number {
    const id = this.#next++;
    this.timers.set(id, fn);
    return id;
  }
  cancel(id: number): void {
    this.cancelled.push(id);
    this.frames.delete(id);
  }
  runFrames(): void {
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const fn of due) fn();
  }
  runTimers(): void {
    const due = [...this.timers.values()];
    this.timers.clear();
    for (const fn of due) fn();
  }
}

let clock: Clock;
const FAKED = ["document", "window", "requestAnimationFrame", "cancelAnimationFrame"] as const;
const saved = new Map(FAKED.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

beforeEach(() => {
  clock = new Clock();
  Object.assign(globalThis, {
    document: { visibilityState: "visible" },
    window: { setTimeout: (fn: () => void) => clock.timer(fn) },
    requestAnimationFrame: (fn: () => void) => clock.frame(fn),
    cancelAnimationFrame: (id: number) => clock.cancel(id),
  });
});

afterEach(() => {
  // The shared frame is module state: let a test's leftover frame or timer run, so the next test
  // starts with nothing armed (a real page runs them on its own).
  clock.runFrames();
  clock.runTimers();
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

function handle(): Updatable & { updates: number; stop: () => void } {
  const ctl = new AbortController();
  const h = {
    updates: 0,
    signal: ctl.signal,
    stop: () => ctl.abort(),
    update(): Promise<AbortSignal> {
      h.updates++;
      return Promise.resolve(ctl.signal);
    },
    queueTask(): void {},
  };
  return h;
}

describe("scheduleUpdate", () => {
  test("many calls before a frame are one update, on the frame", () => {
    const h = handle();
    for (let i = 0; i < 60; i++) scheduleUpdate(h);
    expect(clock.frames.size).toBe(1);
    expect(clock.timers.size).toBe(0);
    clock.runFrames();
    expect(h.updates).toBe(1);
  });

  test("an aborted handle is never updated", () => {
    const h = handle();
    scheduleUpdate(h);
    h.stop();
    clock.runFrames();
    expect(h.updates).toBe(0);
  });
});

describe("holdFrames", () => {
  test("while held, an update runs on a timer, still one per handle", () => {
    const release = holdFrames();
    const h = handle();
    const store = createStore(0);
    store.subscribe(() => scheduleUpdate(h));
    for (let i = 1; i <= 60; i++) store.set(i);
    expect(clock.frames.size).toBe(0);
    expect(clock.timers.size).toBe(1);
    clock.runTimers();
    expect(h.updates).toBe(1);
    release();
  });

  test("turning it on moves an update already waiting for a frame onto a timer", () => {
    const h = handle();
    scheduleUpdate(h);
    expect(clock.frames.size).toBe(1);
    const release = holdFrames();
    expect(clock.cancelled).toHaveLength(1);
    expect(clock.frames.size).toBe(0);
    expect(clock.timers.size).toBe(1);
    // No frame comes (the view transition's callback is pending); the timer alone draws it.
    clock.runTimers();
    expect(h.updates).toBe(1);
    // And the next request is again one update, not a second queued one.
    scheduleUpdate(h);
    scheduleUpdate(h);
    expect(clock.timers.size).toBe(1);
    release();
  });

  test("released, updates wait for frames again; a release is idempotent and holders are counted", () => {
    const a = holdFrames();
    const b = holdFrames();
    a();
    a();
    expect(framesHeld()).toBe(true);
    b();
    expect(framesHeld()).toBe(false);
    const h = handle();
    scheduleUpdate(h);
    expect(clock.frames.size).toBe(1);
    expect(clock.timers.size).toBe(0);
    clock.runFrames();
    expect(h.updates).toBe(1);
  });
});

describe("one shared frame", () => {
  test("several handles in one turn share one frame, each updated once", () => {
    const hs = [handle(), handle(), handle(), handle(), handle()];
    for (const h of hs) {
      scheduleUpdate(h);
      scheduleUpdate(h);
    }
    expect(clock.frames.size).toBe(1);
    expect(clock.timers.size).toBe(0);
    clock.runFrames();
    expect(hs.map((h) => h.updates)).toEqual([1, 1, 1, 1, 1]);
    // Nothing waits any more: the next request arms a fresh frame.
    scheduleUpdate(hs[0]!);
    expect(clock.frames.size).toBe(1);
  });

  test("a handle that aborts while waiting is skipped, the others still run", () => {
    const a = handle();
    const b = handle();
    scheduleUpdate(a);
    scheduleUpdate(b);
    a.stop();
    clock.runFrames();
    expect([a.updates, b.updates]).toEqual([0, 1]);
  });

  test("a request made while the frame runs waits for the next frame", () => {
    const a = handle();
    const b = handle();
    const again = a.update;
    a.update = () => {
      scheduleUpdate(b); // b is not waiting any more: it joins the NEXT frame
      return again();
    };
    scheduleUpdate(a);
    scheduleUpdate(b);
    clock.runFrames();
    expect([a.updates, b.updates]).toEqual([1, 1]);
    scheduleUpdate(a);
    expect(clock.frames.size).toBe(1);
  });

  test("holding frames moves the one shared frame onto one timer", () => {
    const a = handle();
    const b = handle();
    scheduleUpdate(a);
    scheduleUpdate(b);
    const release = holdFrames();
    expect(clock.cancelled).toHaveLength(1);
    expect(clock.timers.size).toBe(1);
    clock.runTimers();
    expect([a.updates, b.updates]).toEqual([1, 1]);
    release();
  });

  test("a hidden page shares one timer, not a frame", () => {
    Object.assign(globalThis, { document: { visibilityState: "hidden" } });
    const a = handle();
    const b = handle();
    scheduleUpdate(a);
    scheduleUpdate(b);
    expect(clock.frames.size).toBe(0);
    expect(clock.timers.size).toBe(1);
    clock.runTimers();
    expect([a.updates, b.updates]).toEqual([1, 1]);
  });
});

describe("useStoreSelect", () => {
  function readerHandle(): Updatable & { updates: number; tasks: Array<() => void> } {
    const tasks: Array<() => void> = [];
    const h = Object.assign(handle(), { tasks });
    h.queueTask = (task) => {
      h.tasks.push(() => task(h.signal));
    };
    return h;
  }

  test("wakes only when the selected value differs from what the last render read", () => {
    const h = readerHandle();
    const store = createStore(0);
    const read = useStoreSelect(h, store, (n) => Math.floor(n / 60));
    expect(read()).toBe(0); // first render
    for (const task of h.tasks) task();
    clock.runFrames();
    expect(h.updates).toBe(0);
    for (let n = 1; n < 60; n++) store.set(n);
    expect(clock.frames.size).toBe(0);
    store.set(60);
    clock.runFrames();
    expect(h.updates).toBe(1);
    // Not read again yet: a further change in the same minute still differs from the last read.
    read();
    store.set(61);
    expect(clock.frames.size).toBe(0);
  });

  test("a change between the first render and the first task wakes at once", () => {
    const h = readerHandle();
    const store = createStore(0);
    const read = useStoreSelect(h, store, (n) => n);
    read();
    store.set(5);
    for (const task of h.tasks) task();
    clock.runFrames();
    expect(h.updates).toBe(1);
  });
});
