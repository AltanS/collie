import { describe, expect, test } from "bun:test";

import { RefreshCoalescer } from "./refresh.ts";

// What the coalescer must get right is one property: a burst of "look now" is ONE listing, and
// everybody in the burst gets that listing's answer. Its failure mode is silent (three processes
// where one would do), so it is pinned rather than trusted.

/** A "look" that resolves only when the test says so, and counts how often it was started. */
function deferred() {
  let release = (): void => undefined;
  let reject = (_err: Error): void => undefined;
  let started = 0;
  const look = (): Promise<void> => {
    started += 1;
    return new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
  };
  return {
    look,
    started: () => started,
    release: () => release(),
    fail: (err: Error) => reject(err),
  };
}

describe("RefreshCoalescer", () => {
  test("three callers during one in-flight look share it, and it runs once", async () => {
    const gate = deferred();
    const coalescer = new RefreshCoalescer();
    const first = coalescer.run("primary", gate.look);
    const second = coalescer.run("primary", gate.look);
    const third = coalescer.run("primary", gate.look);
    expect(gate.started()).toBe(1);
    // The SAME promise, not merely an equivalent one: a joining caller awaits the very work that is
    // already happening.
    expect(second).toBe(first);
    expect(third).toBe(first);
    gate.release();
    await Promise.all([first, second, third]);
    expect(gate.started()).toBe(1);
  });

  test("a caller arriving after the first settled starts a fresh look", async () => {
    const gate = deferred();
    const coalescer = new RefreshCoalescer();
    const first = coalescer.run("primary", gate.look);
    gate.release();
    await first;
    expect(coalescer.pending).toBe(0);
    const second = coalescer.run("primary", gate.look);
    expect(gate.started()).toBe(2);
    gate.release();
    await second;
  });

  test("two sessions do not share a look — one multiplexer's listing says nothing about another's", () => {
    const gate = deferred();
    const coalescer = new RefreshCoalescer();
    const primary = coalescer.run("primary", gate.look);
    const other = coalescer.run("laptop", gate.look);
    expect(other).not.toBe(primary);
    expect(gate.started()).toBe(2);
    gate.release();
  });

  test("a failed look clears the slot, so the next caller retries rather than joining a rejection", async () => {
    const gate = deferred();
    const coalescer = new RefreshCoalescer();
    const first = coalescer.run("primary", gate.look);
    gate.fail(new Error("the multiplexer did not answer"));
    await expect(first).rejects.toThrow("the multiplexer did not answer");
    expect(coalescer.pending).toBe(0);
    const second = coalescer.run("primary", gate.look);
    expect(second).not.toBe(first);
    gate.release();
    await second;
  });
});
