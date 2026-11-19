// The slow cases of stale-word.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, expect, test } from "bun:test";
import { DATA_PANE, dataDescribe, dataRig, type DataRig } from "./data-rig.ts";
import { PART_RATE_BURST } from "./server.ts";

const rigs: DataRig[] = [];

afterEach(() => {
  for (const made of rigs.splice(0)) made.stop();
});

/** A rig whose hub reads a clock the test moves. */
async function rig(): Promise<{ r: DataRig; clock: { at: number } }> {
  const clock = { at: 1_000_000 };
  const r = await dataRig({ harness: "claude", version: "2.1.200", now: () => clock.at });
  rigs.push(r);
  return { r, clock };
}

dataDescribe("a lost turn.end", () => {
  test("a turn.end refused 429 past the burst is a real loss; its retry a second later lands", async () => {
    const { r } = await rig();
    const part = await r.part();
    await part.event("turn.start", { turn: "t1", seq: 1 });
    // A burst of rows spends the part's bucket, so the turn end right after it is refused.
    for (let i = 0; i < PART_RATE_BURST; i += 1) await part.event("row", { door: "response" });
    expect((await part.event("turn.end", { turn: "t1", seq: 2 })).status).toBe(429);
    expect(r.hub.turnOf(DATA_PANE)).toBe("running");
    await Bun.sleep(1100);
    expect((await part.event("turn.end", { turn: "t1", seq: 2 })).status).toBe(204);
    expect(r.hub.turnOf(DATA_PANE)).toBe("idle");
  });
});
