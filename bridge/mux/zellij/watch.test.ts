import { describe, expect, test } from "bun:test";

import { FakeZellij, zellijWorld } from "./fixture.ts";
import {
  ZELLIJ_CENSUS_MAX_MS,
  ZELLIJ_CENSUS_MIN_MS,
  ZELLIJ_WATCHED_MAX_MS,
  ZELLIJ_WATCHED_MIN_MS,
  ZellijWatch,
  type WatchClock,
  type WatchTimer,
} from "./watch.ts";
import type { MuxAttention, MuxWatchOptions } from "../types.ts";

// THE CENSUS CADENCE — zellij's only source of topology, so the numbers ARE the freshness promise.
//
// The conformance suite proves the watch keeps the contract's promise; nothing in it can prove the
// SCHEDULE, because the contract deliberately does not have one. These do: what the interval is
// while nobody is looking, what it becomes when somebody is, and that `refresh()` puts it back on
// the floor. All three are invisible when wrong — the watch still works, it just works late or
// works too hard.

/** A clock that records what was scheduled and fires it on demand. Nothing here waits on real time. */
class TestClock implements WatchClock {
  readonly delays: number[] = [];
  private pending: (() => void) | null = null;

  setTimeout(fn: () => void, ms: number): WatchTimer {
    this.delays.push(ms);
    this.pending = fn;
    // A REAL platform timer as the token, cancelled the instant it is made: the watch only ever
    // hands it back to `clearTimeout` below, so it never fires — and minting it this way keeps the
    // handle the platform's own type rather than an integer cast into it.
    const token = globalThis.setTimeout(() => undefined, 0);
    globalThis.clearTimeout(token);
    return token;
  }

  clearTimeout(): void {
    this.pending = null;
  }

  /** Run whatever is armed, as the platform would when its delay elapsed. */
  fire(): void {
    const fn = this.pending;
    this.pending = null;
    fn?.();
  }

  /** The delay most recently armed — what the next census is actually waiting for. */
  get next(): number | undefined {
    return this.delays.at(-1);
  }
}

/** A started watch over the fixture's world, with a clock the test drives. */
function watching(attention?: () => MuxAttention) {
  const fake = new FakeZellij();
  const { session } = zellijWorld(fake);
  const clock = new TestClock();
  const options: MuxWatchOptions = {
    panes: [],
    onTopologyChange: () => undefined,
    onPaneChange: () => undefined,
    onUp: () => undefined,
    onDown: () => undefined,
  };
  if (attention !== undefined) options.attention = attention;
  const watch = new ZellijWatch(session, options, clock);
  return { fake, clock, watch };
}

/** Let every pending microtask and I/O turn of the fake transport run out. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Run `count` censuses back to back, letting each settle. */
async function censuses(clock: TestClock, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    clock.fire();
    await settle();
  }
}

describe("the zellij census cadence", () => {
  test("with nobody looking it relaxes from the idle floor to the idle ceiling", async () => {
    const { clock, watch } = watching();
    watch.start();
    await settle();
    // The FIRST census only establishes a baseline, so nothing "changed" and the interval has
    // already begun doubling away from the floor.
    expect(clock.next).toBe(ZELLIJ_CENSUS_MIN_MS * 2);
    await censuses(clock, 6);
    expect(clock.next).toBe(ZELLIJ_CENSUS_MAX_MS);
    watch.close();
  });

  test("a watching phone caps it at the watched ceiling, however relaxed it had become", async () => {
    let attention: MuxAttention = "idle";
    const { clock, watch } = watching(() => attention);
    watch.start();
    await settle();
    await censuses(clock, 6);
    expect(clock.next).toBe(ZELLIJ_CENSUS_MAX_MS);
    // The operator picks the phone up. The very next re-arm is inside the watched pair — it does
    // NOT carry on doubling from twelve seconds, which is the whole point of clamping from both ends.
    attention = "watched";
    await censuses(clock, 1);
    expect(clock.next).toBe(ZELLIJ_WATCHED_MAX_MS);
    watch.close();
  });

  test("refresh() puts the next census on the floor of whichever pair is in force", async () => {
    let attention: MuxAttention = "idle";
    const { clock, watch } = watching(() => attention);
    watch.start();
    await settle();
    await censuses(clock, 6);
    expect(clock.next).toBe(ZELLIJ_CENSUS_MAX_MS);

    await watch.refresh();
    expect(clock.next).toBe(ZELLIJ_CENSUS_MIN_MS);

    attention = "watched";
    await watch.refresh();
    expect(clock.next).toBe(ZELLIJ_WATCHED_MIN_MS);
    watch.close();
  });

  test("refresh() on a closed watch does nothing at all — no census, no timer", async () => {
    const { clock, watch } = watching();
    watch.start();
    await settle();
    watch.close();
    const armed = clock.delays.length;
    await watch.refresh();
    expect(clock.delays.length).toBe(armed);
    expect(watch.ended).toBe(true);
  });
});
