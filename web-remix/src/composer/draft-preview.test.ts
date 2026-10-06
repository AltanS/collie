/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { createStableDraft, isSelfEcho, normalizeDraft, type DraftTimers } from "./draft-preview";

class FakeTimers implements DraftTimers {
  now = 0;
  #next = 1;
  #queue = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): number {
    const id = this.#next++;
    this.#queue.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: number): void {
    this.#queue.delete(id);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, e] of this.#queue) {
      if (e.at > this.now) continue;
      this.#queue.delete(id);
      e.fn();
    }
  }
}

describe("normalizeDraft and isSelfEcho", () => {
  test("trims and collapses whitespace", () => {
    expect(normalizeDraft("  a \n  b\t c ")).toBe("a b c");
  });

  test("the same text after normalisation is our own echo", () => {
    expect(isSelfEcho("fix  the bug", "fix the bug\n")).toBe(true);
    expect(isSelfEcho("fix the bug", "fix the build")).toBe(false);
  });

  test("a truncated head with an ellipsis is an echo, but only past 8 characters", () => {
    expect(isSelfEcho("please refactor the whole…", "please refactor the whole module and add tests")).toBe(true);
    expect(isSelfEcho("ok…", "ok then do the thing")).toBe(false);
  });

  test("the adapter's own evidence counts, for a harness that swaps a send for a token", () => {
    expect(isSelfEcho("[Pasted text #1 +40 lines]", "forty lines of text", () => true)).toBe(true);
    expect(isSelfEcho("[Pasted text #1 +40 lines]", "forty lines of text", () => false)).toBe(false);
    expect(isSelfEcho("[Pasted text #1 +40 lines]", "forty lines of text")).toBe(false);
  });
});

describe("createStableDraft: 1.5 s on the line before it surfaces", () => {
  const rig = () => {
    const timers = new FakeTimers();
    const controller = new AbortController();
    const draft = createStableDraft(controller.signal, timers);
    return { timers, controller, draft };
  };

  test("a draft surfaces only after it has held, with the latest raw text", () => {
    const { timers, draft } = rig();
    draft.set("hello");
    expect(draft.value.get()).toBeNull();
    timers.advance(1000);
    draft.set("hello "); // cosmetic wobble: same key, clock keeps running
    timers.advance(500);
    expect(draft.value.get()).toBe("hello ");
  });

  test("a real edit restarts the clock", () => {
    const { timers, draft } = rig();
    draft.set("hello");
    timers.advance(1400);
    draft.set("hello world");
    timers.advance(1400);
    expect(draft.value.get()).toBeNull();
    timers.advance(100);
    expect(draft.value.get()).toBe("hello world");
  });

  test("a cleared line drops it at once and cancels the pending promotion", () => {
    const { timers, draft } = rig();
    draft.set("hello");
    timers.advance(1500);
    expect(draft.value.get()).toBe("hello");
    draft.set(null);
    expect(draft.value.get()).toBeNull();
    draft.set("again");
    draft.set(null);
    timers.advance(5000);
    expect(draft.value.get()).toBeNull();
  });

  test("an already promoted draft survives a cosmetic change in place", () => {
    const { timers, draft } = rig();
    draft.set("hello");
    timers.advance(1500);
    draft.set("hello  ");
    expect(draft.value.get()).toBe("hello");
  });

  test("a promoted draft goes blank while a different one proves itself", () => {
    const { timers, draft } = rig();
    draft.set("one");
    timers.advance(1500);
    draft.set("two");
    expect(draft.value.get()).toBeNull();
    timers.advance(1500);
    expect(draft.value.get()).toBe("two");
  });

  test("the timer ends with the signal", () => {
    const { timers, controller, draft } = rig();
    draft.set("hello");
    controller.abort();
    timers.advance(5000);
    expect(draft.value.get()).toBeNull();
    draft.set("later");
    timers.advance(5000);
    expect(draft.value.get()).toBeNull();
  });
});
