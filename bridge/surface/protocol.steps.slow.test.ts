// The slow cases of protocol.steps.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { FakePane, rig, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("the lock", () => {
  test("an S0 read that hangs is cut at S0's bound, not the request's", async () => {
    const r = rig();
    r.pane.beforeRead = (_p, n) => (n === 2 ? new Promise<void>(() => undefined) : undefined);
    const started = Date.now();
    const answer = await r.send("hung read");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound" });
    // 1200 ms less the 120 ms gap the fake clock skipped; far under the request's 7600 ms.
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.pane.calls).toEqual([]);
  });
});

describe("bounded lock", () => {
  test("a read that hangs before the write ends the step, never types, and the next tap is accepted", async () => {
    const pane = new FakePane();
    const r = rig({ pane });
    pane.beforeRead = (_p, n) => (n === 2 ? new Promise<void>(() => undefined) : undefined);
    const answer = await r.send("this S0 read never answers");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "bound", keys: [] });
    expect(pane.calls).toEqual([]);
    pane.beforeRead = null;
    expect((await r.send("the next tap")).receipt?.outcome).toBe("sent");
  });
});
