import { describe, expect, test } from "bun:test";

import { muxOk, muxUnreachable, type MuxOutcome, type MuxSnapshot, type MuxWatchOptions } from "../types.ts";
import { DURABLE_BUDGETS, type DurableBudget } from "./adapter.ts";
import { toMuxSnapshot, type DurableSnapshot } from "./protocol.ts";
import { snapshotFixture } from "./fixture.ts";
import {
  DurableWatch,
  type DurablePoller,
  type PollCadence,
  type WatchClock,
  type WatchTimer,
} from "./watch.ts";

// THE WATCH'S LIFECYCLE AND ITS COMPARISONS. The conformance suite proves the watch comes up and
// goes down once. These prove what it fires, when, and that it leaves no timer behind.

/** A clock that fires on demand and remembers the delay it was asked for. */
class TestClock implements WatchClock {
  private readonly armed = new Map<WatchTimer, () => void>();
  readonly delays: number[] = [];

  setTimeout(fn: () => void, ms: number): WatchTimer {
    const token = globalThis.setTimeout(() => undefined, 0);
    globalThis.clearTimeout(token);
    this.armed.set(token, fn);
    this.delays.push(ms);
    return token;
  }

  clearTimeout(handle: WatchTimer): void {
    this.armed.delete(handle);
  }

  get live(): number {
    return this.armed.size;
  }

  fire(): void {
    const [first] = [...this.armed.entries()];
    if (first === undefined) return;
    this.armed.delete(first[0]);
    first[1]();
  }
}

const EPOCH = "e4b1c7a09d3f5e826b7a1c0d94f3e582";

function layout(change: (snapshot: DurableSnapshot) => DurableSnapshot = (same) => same): DurableSnapshot {
  const raw = snapshotFixture();
  return change({ rev: 1, epoch: EPOCH, ...raw, starters: raw.starters });
}

/** A poller the test steers: whatever it holds now is what the next census reads. */
class ScriptedPoller implements DurablePoller {
  reads = 0;
  /** The transport row whose cadence the watch reads. The socket's unless a test says otherwise. */
  budget: DurableBudget = DURABLE_BUDGETS.socket;
  /** The layout the program shows, or the reason it cannot be read. */
  layout: DurableSnapshot | null;
  failure: string | null;

  constructor(start: DurableSnapshot | string) {
    this.layout = start instanceof Object ? start : null;
    this.failure = start instanceof Object ? null : start;
  }

  set shown(next: DurableSnapshot) {
    this.layout = next;
    this.failure = null;
  }

  fail(detail: string): void {
    this.failure = detail;
  }

  poll(): Promise<MuxOutcome<MuxSnapshot>> {
    this.reads += 1;
    if (this.failure !== null || this.layout === null) return Promise.resolve(muxUnreachable(this.failure ?? "no layout"));
    return Promise.resolve(muxOk(toMuxSnapshot(this.layout)));
  }

  held(): DurableSnapshot | null {
    return this.failure === null ? this.layout : null;
  }

  pollCadence(): PollCadence {
    return { watchedMs: this.budget.watchedPollMs, idleMs: this.budget.idlePollMs };
  }
}

interface Seen {
  up: number;
  down: string[];
  topology: number;
  panes: string[];
}

function watching(poller: ScriptedPoller, clock: TestClock, panes: string[] = ["conv-01"], attention?: () => "watched" | "idle") {
  const seen: Seen = { up: 0, down: [], topology: 0, panes: [] };
  const options: MuxWatchOptions = {
    panes,
    onUp: () => (seen.up += 1),
    onDown: (reason) => seen.down.push(reason),
    onTopologyChange: () => (seen.topology += 1),
    onPaneChange: (paneId) => seen.panes.push(paneId),
  };
  if (attention !== undefined) options.attention = attention;
  return { seen, watch: new DurableWatch(poller, options, clock) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("the durable watch", () => {
  test("it comes up after the first good read and fires nothing for the layout it started from", async () => {
    const clock = new TestClock();
    const { seen } = watching(new ScriptedPoller(layout()), clock);
    await settle();
    expect(seen).toEqual({ up: 1, down: [], topology: 0, panes: [] });
    expect(clock.live).toBe(1);
  });

  test("a program that is down ends the watch at once with its detail, and arms no timer", async () => {
    const clock = new TestClock();
    const { seen } = watching(new ScriptedPoller("starting"), clock);
    await settle();
    expect(seen).toEqual({ up: 0, down: ["starting"], topology: 0, panes: [] });
    expect(clock.live).toBe(0);
  });

  test("a program that goes away later ends the watch once", async () => {
    const clock = new TestClock();
    const poller = new ScriptedPoller(layout());
    const { seen } = watching(poller, clock);
    await settle();
    poller.fail("no answer within 1000ms");
    clock.fire();
    await settle();
    expect(seen.down).toEqual(["no answer within 1000ms"]);
    expect(clock.live).toBe(0);
    clock.fire();
    await settle();
    expect(seen.down).toHaveLength(1);
  });

  test("a renamed tab, an added pane and a changed status each tell the caller to re-read the topology", async () => {
    const clock = new TestClock();
    const poller = new ScriptedPoller(layout());
    const { seen } = watching(poller, clock);
    await settle();

    poller.shown = layout((snapshot) => ({ ...snapshot, tabs: snapshot.tabs.map((tab) => ({ ...tab, title: `${tab.title}!` })) }));
    clock.fire();
    await settle();
    expect(seen.topology).toBe(1);

    poller.shown = layout((snapshot) => ({ ...snapshot, panes: snapshot.panes.slice(1) }));
    clock.fire();
    await settle();
    expect(seen.topology).toBe(2);

    poller.shown = layout((snapshot) => ({ ...snapshot, panes: snapshot.panes.map((pane) => ({ ...pane, state: "working" })) }));
    clock.fire();
    await settle();
    expect(seen.topology).toBe(3);
  });

  test("an unchanged read fires nothing", async () => {
    const clock = new TestClock();
    const { seen } = watching(new ScriptedPoller(layout()), clock);
    await settle();
    clock.fire();
    await settle();
    clock.fire();
    await settle();
    expect(seen).toEqual({ up: 1, down: [], topology: 0, panes: [] });
  });

  test("a watched pane fires when its state, its turn or its asks change, and an unwatched pane does not", async () => {
    const clock = new TestClock();
    const poller = new ScriptedPoller(layout());
    const { seen } = watching(poller, clock, ["conv-01", "conv-02"]);
    await settle();

    poller.shown = layout((snapshot) => ({
      ...snapshot,
      panes: snapshot.panes.map((pane) => (pane.id === "conv-01" ? { ...pane, turnId: "turn-01-b" } : pane)),
    }));
    clock.fire();
    await settle();
    expect(seen.panes).toEqual(["conv-01"]);

    poller.shown = layout((snapshot) => ({
      ...snapshot,
      panes: snapshot.panes.map((pane) => {
        if (pane.id === "conv-01") return { ...pane, turnId: "turn-01-b" };
        if (pane.id === "conv-02") return { ...pane, openAsks: [] };
        if (pane.id === "conv-03") return { ...pane, state: "working" };
        return pane;
      }),
    }));
    clock.fire();
    await settle();
    expect(seen.panes).toEqual(["conv-01", "conv-02"]);
  });

  test("it polls faster while a phone is watching and at the ceiling otherwise", async () => {
    const clock = new TestClock();
    let attention: "watched" | "idle" = "idle";
    watching(new ScriptedPoller(layout()), clock, [], () => attention);
    await settle();
    attention = "watched";
    clock.fire();
    await settle();
    expect(clock.delays).toEqual([3000, 1000]);
  });

  test("over https it polls every 2 s while watched and every 10 s otherwise, because each poll is billed", async () => {
    const clock = new TestClock();
    let attention: "watched" | "idle" = "idle";
    const poller = new ScriptedPoller(layout());
    poller.budget = DURABLE_BUDGETS.https;
    watching(poller, clock, [], () => attention);
    await settle();
    attention = "watched";
    clock.fire();
    await settle();
    expect(clock.delays).toEqual([10_000, 2000]);
    for (const row of Object.values(DURABLE_BUDGETS)) expect(row.watchedPollMs).toBeLessThan(row.idlePollMs);
  });

  test("close brings it down exactly once, leaves no timer, and a late read changes nothing", async () => {
    const clock = new TestClock();
    const poller = new ScriptedPoller(layout());
    const { seen, watch } = watching(poller, clock);
    await settle();
    watch.close();
    watch.close();
    expect(seen.down).toEqual(["closed"]);
    expect(clock.live).toBe(0);
    const reads = poller.reads;
    clock.fire();
    await settle();
    expect(poller.reads).toBe(reads);
  });

  test("closing while the first read is still in flight leaves no timer behind", async () => {
    const clock = new TestClock();
    const { seen, watch } = watching(new ScriptedPoller(layout()), clock);
    watch.close();
    await settle();
    expect(seen.up).toBe(0);
    expect(seen.down).toEqual(["closed"]);
    expect(clock.live).toBe(0);
  });
});

// THE PANE LOG'S SEAM: the events read starts after a census and the census does not wait for it.
describe("the durable watch and the events read", () => {
  /** A poller whose events read the test steers. */
  class EventPoller extends ScriptedPoller {
    syncs = 0;
    answers: Promise<readonly string[]> = Promise.resolve([]);

    syncEvents(): Promise<readonly string[]> {
      this.syncs += 1;
      return this.answers;
    }
  }

  test("an events read starts after each census, and a read that never ends does not hold the next census", async () => {
    const clock = new TestClock();
    const poller = new EventPoller(layout());
    poller.answers = new Promise<readonly string[]>(() => undefined);
    const { seen } = watching(poller, clock);
    await settle();
    expect(poller.syncs).toBe(1);
    expect(seen.up).toBe(1);

    // The first events read is still pending, and the timer for the next census is armed all the same.
    expect(clock.live).toBe(1);
    clock.fire();
    await settle();
    expect(poller.reads).toBe(2);
    expect(poller.syncs).toBe(2);
  });

  test("a watched pane whose log gained rows is poked, and an unwatched one is not", async () => {
    const clock = new TestClock();
    const poller = new EventPoller(layout());
    poller.answers = Promise.resolve(["conv-01", "conv-03"]);
    const { seen } = watching(poller, clock, ["conv-01", "conv-02"]);
    await settle();
    expect(seen.panes).toEqual(["conv-01"]);
  });

  test("a failed events read is not the watch's failure", async () => {
    const clock = new TestClock();
    const poller = new EventPoller(layout());
    poller.answers = Promise.reject(new Error("disk full"));
    const { seen } = watching(poller, clock);
    await settle();
    expect(seen).toEqual({ up: 1, down: [], topology: 0, panes: [] });
    expect(clock.live).toBe(1);
  });

  test("an answer that arrives after the watch closed pokes nothing", async () => {
    const clock = new TestClock();
    const poller = new EventPoller(layout());
    let finish: (ids: readonly string[]) => void = () => undefined;
    poller.answers = new Promise<readonly string[]>((resolve) => {
      finish = resolve;
    });
    const { seen, watch } = watching(poller, clock, ["conv-01"]);
    await settle();
    watch.close();
    finish(["conv-01"]);
    await settle();
    expect(seen.panes).toEqual([]);
  });
});
