import { describe, expect, test } from "bun:test";

import { EventPoker } from "../../event-poker.ts";
import type { MuxWatchOptions } from "../types.ts";
import { RexMux } from "./adapter.ts";
import type { RexExec, RexRunResult, RexStreamClient, RexStreamHandlers } from "./exec.ts";
import { RexWatch, type WatchClock, type WatchTimer } from "./watch.ts";

/** A rex that answers every census with no sessions and hands out event streams the test ends. */
class StreamRex implements RexExec {
  readonly streams: RexStreamHandlers[] = [];
  kills = 0;
  run(args: readonly string[]): Promise<RexRunResult> {
    if (args[0] === "ls") return Promise.resolve({ code: 0, stdout: JSON.stringify({ sessions: [] }), stderr: "" });
    return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
  }
  events(handlers: RexStreamHandlers): RexStreamClient {
    this.streams.push(handlers);
    return { kill: () => void (this.kills += 1) };
  }
}

/** A clock whose interval never fires on its own, and that says whether it is still armed. */
class HeldClock implements WatchClock {
  armed = 0;
  setInterval(): WatchTimer {
    this.armed += 1;
    return setTimeout(() => undefined, 0);
  }
  clearInterval(handle: WatchTimer): void {
    clearTimeout(handle);
    this.armed -= 1;
  }
}

interface Seen {
  up: number;
  down: string[];
  topology: number;
  panes: string[];
}

function watchOptions() {
  const seen: Seen = { up: 0, down: [], topology: 0, panes: [] };
  const options: MuxWatchOptions = {
    panes: [],
    onUp: () => void (seen.up += 1),
    onDown: (reason) => void seen.down.push(reason),
    onTopologyChange: () => void (seen.topology += 1),
    onPaneChange: (paneId) => void seen.panes.push(paneId),
  };
  return { seen, options };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the rex watch", () => {
  test("when the events child ends, the watch ends once: one onDown, the census timer cleared, no second child", async () => {
    const rex = new StreamRex();
    const clock = new HeldClock();
    const { seen, options } = watchOptions();
    const watch = new RexWatch(rex, options, clock);
    await settle();
    expect(seen.up).toBe(1);
    expect(clock.armed).toBe(1);

    rex.streams[0]!.onExit("the rex event stream ended");
    rex.streams[0]!.onExit("the rex event stream ended");
    expect(seen.down).toEqual(["the rex event stream ended"]);
    expect(clock.armed).toBe(0);
    expect(rex.streams.length).toBe(1);
    watch.close();
    expect(seen.down.length).toBe(1);
  });

  test("a malformed line is ignored, and the next good line still arrives", async () => {
    const rex = new StreamRex();
    const { seen, options } = watchOptions();
    const watch = new RexWatch(rex, options, new HeldClock());
    await settle();
    const stream = rex.streams[0]!;
    for (const line of ["", "not json", '{"type":', "[1,2]", '{"type":"session_event","payload":{"event":"x"}}']) stream.onLine(line);
    expect(seen.topology).toBe(0);
    expect(seen.panes).toEqual([]);
    expect(seen.down).toEqual([]);
    stream.onLine(JSON.stringify({ type: "session_created" }));
    expect(seen.topology).toBe(1);
    watch.close();
  });

  test("through the event poker, an ended stream is restarted once, after the backoff", async () => {
    const rex = new StreamRex();
    const poker = new EventPoker(new RexMux(rex, { log: () => undefined }), { backoffMs: [40] });
    poker.start();
    await settle();
    expect(rex.streams.length).toBe(1);

    rex.streams[0]!.onExit("the rex event stream ended");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rex.streams.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rex.streams.length).toBe(2);
    poker.stop();
  });
});
