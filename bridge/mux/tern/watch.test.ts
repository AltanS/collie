import { describe, expect, test } from "bun:test";

import type { MuxWatchOptions } from "../types.ts";
import type { TernExec, TernRunResult, TernStreamHandlers } from "./exec.ts";
import { FakeTern } from "./fixture.ts";
import { type WatchClock, type WatchTimer, TernWatch } from "./watch.ts";

// THE WATCH'S LIFECYCLE — what the conformance suite cannot see. It proves the watch comes up and goes
// down once; it cannot see a census timer that outlives its stream, which is how a tern that kept
// restarting grew one `tern ls` every 5 s per reconnect.

/** A clock that fires on demand and counts the timers still armed. Nothing here waits on real time. */
class TestClock implements WatchClock {
  private readonly armed = new Map<WatchTimer, () => void>();

  setInterval(fn: () => void): WatchTimer {
    const token = globalThis.setTimeout(() => undefined, 0);
    globalThis.clearTimeout(token);
    this.armed.set(token, fn);
    return token;
  }

  clearInterval(handle: WatchTimer): void {
    this.armed.delete(handle);
  }

  get live(): number {
    return this.armed.size;
  }

  tick(): void {
    for (const fn of this.armed.values()) fn();
  }
}

interface Seen {
  up: number;
  down: string[];
  topology: number;
}

function options(seen: Seen): MuxWatchOptions {
  return {
    panes: [],
    onUp: () => (seen.up += 1),
    onDown: (reason) => seen.down.push(reason),
    onTopologyChange: () => (seen.topology += 1),
    onPaneChange: () => undefined,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A tern whose stream dies at once and whose listing fails: the daemon is down. */
function deadTern(): TernExec & { listings: number } {
  const exec = {
    listings: 0,
    run(args: readonly string[]): Promise<TernRunResult> {
      if (args[0] === "ls") exec.listings += 1;
      return Promise.resolve({ code: 1, stdout: "", stderr: "the session daemon did not answer" });
    },
    events(handlers: TernStreamHandlers) {
      queueMicrotask(() => handlers.onExit("the tern event stream ended"));
      return { kill: () => undefined };
    },
  };
  return exec;
}

describe("TernWatch lifecycle", () => {
  test("a stream that ends takes the census timer with it, and says down once", async () => {
    const clock = new TestClock();
    const seen: Seen = { up: 0, down: [], topology: 0 };
    const exec = deadTern();
    const watch = new TernWatch(exec, options(seen), clock);
    await settle();
    expect(clock.live).toBe(0);
    expect(seen.down).toHaveLength(1);
    const before = exec.listings;
    clock.tick();
    await settle();
    expect(exec.listings).toBe(before);
    watch.close();
  });

  test("it does not say up while tern is down", async () => {
    const clock = new TestClock();
    const seen: Seen = { up: 0, down: [], topology: 0 };
    const watch = new TernWatch(deadTern(), options(seen), clock);
    await settle();
    expect(seen.up).toBe(0);
    expect(seen.down).toHaveLength(1);
    watch.close();
  });

  test("it says up after the first listing answers, and not before", async () => {
    const clock = new TestClock();
    const seen: Seen = { up: 0, down: [], topology: 0 };
    const watch = new TernWatch(new FakeTern(), options(seen), clock);
    expect(seen.up).toBe(0);
    await settle();
    expect(seen.up).toBe(1);
    expect(clock.live).toBe(1);
    watch.close();
    watch.close();
    expect(clock.live).toBe(0);
    expect(seen.down).toEqual(["closed"]);
  });

  test("a listing slower than the interval is not stacked", async () => {
    const clock = new TestClock();
    const seen: Seen = { up: 0, down: [], topology: 0 };
    let listings = 0;
    let release: () => void = () => undefined;
    const exec: TernExec = {
      run: () => {
        listings += 1;
        return new Promise<TernRunResult>((resolve) => {
          release = () => resolve({ code: 0, stdout: JSON.stringify({ sessions: [] }), stderr: "" });
        });
      },
      events: () => ({ kill: () => undefined }),
    };
    const watch = new TernWatch(exec, options(seen), clock);
    clock.tick();
    clock.tick();
    expect(listings).toBe(1);
    release();
    await settle();
    watch.close();
  });

  test("a change between two listings pokes the topology", async () => {
    const clock = new TestClock();
    const seen: Seen = { up: 0, down: [], topology: 0 };
    const fake = new FakeTern();
    const watch = new TernWatch(fake, options(seen), clock);
    await settle();
    expect(seen.topology).toBe(0);
    await fake.pokeTopologyOutOfBand();
    clock.tick();
    await settle();
    expect(seen.topology).toBe(1);
    watch.close();
  });
});
