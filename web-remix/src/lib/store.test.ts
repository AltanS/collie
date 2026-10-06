/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createStore, framesHeld, holdFrames, scheduleUpdate, type Updatable } from "./store";

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
