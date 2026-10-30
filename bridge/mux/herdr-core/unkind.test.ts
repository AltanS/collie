// The adapter against the unkind parts of the real core (M78 spec 02). Each test turns one switch of
// the fake on (fake-core.ts, every switch cites its HC_API.md line) and pins what the adapter does.
// "Pinned" means the behaviour was there before the test and the test keeps it; "fixed" names the
// test that failed before the change beside it.

import { describe, expect, test } from "bun:test";
import { STATUS_RANK } from "../../types.ts";
import { HerdrCoreMux } from "./adapter.ts";
import { DEFAULT_HC_TIMEOUT_MS, type WireRead } from "./client.ts";
import { FakeHcCore, KEY_HOLD_MS, ManualClock } from "./fake-core.ts";

interface Built {
  readonly fake: FakeHcCore;
  readonly adapter: HerdrCoreMux;
  readonly clock: ManualClock;
}

function build(): Built {
  const fake = new FakeHcCore();
  return { fake, adapter: new HerdrCoreMux(fake, "/home/dev"), clock: new ManualClock() };
}

const VIEWPORT = { scope: "viewport", lines: 120, styling: "preserve" } as const;
const RECENT = { scope: "recent", lines: 200, styling: "preserve" } as const;

function reason(outcome: { ok: boolean; reason?: string }): string {
  return outcome.ok ? "ok" : (outcome.reason ?? "?");
}

describe("the key hold: a key press after a raw write is answered about 3 s later (HC_API.md, The key hold)", () => {
  test("the first key after typed text waits out the rest of the hold, and keys keep their order", async () => {
    const { fake, adapter, clock } = build();
    fake.holdKeysAfterRawWrite(clock);
    expect((await adapter.typeText("t2", "hello")).ok).toBe(true);
    const before = clock.now();
    expect((await adapter.writeKeys("t2", ["Enter"])).ok).toBe(true);
    expect(clock.now() - before).toBe(KEY_HOLD_MS);
    expect(fake.writes().map((w) => [w.kind, w.payload])).toEqual([
      ["text", ["hello"]],
      ["keys", ["enter"]],
    ]);
  });

  test.each([
    [0, KEY_HOLD_MS],
    [2500, KEY_HOLD_MS - 2500],
    [3500, 0],
  ])("a key %d ms after the write waits %d ms (the measured gaps)", async (gap, waited) => {
    const { fake, adapter, clock } = build();
    fake.holdKeysAfterRawWrite(clock);
    await adapter.typeText("t2", "hello");
    await clock.wait(gap);
    const before = clock.now();
    await adapter.writeKeys("t2", ["Enter"]);
    expect(clock.now() - before).toBe(waited);
  });

  test("a key with no raw write before it is not held", async () => {
    const { fake, adapter, clock } = build();
    fake.holdKeysAfterRawWrite(clock);
    await adapter.writeKeys("t2", ["Up"]);
    expect(clock.now()).toBe(0);
  });

  test("the adapter adds no wait of its own: the call that follows the hold is still inside the client's call budget", () => {
    expect(KEY_HOLD_MS).toBeLessThan(DEFAULT_HC_TIMEOUT_MS);
  });

  test("an early answer returns at once, and the keys reach the program when the hold is over", async () => {
    const { fake, adapter, clock } = build();
    fake.holdKeysAfterRawWrite(clock, { answer: "early" });
    await adapter.typeText("t2", "hello");
    expect((await adapter.writeKeys("t2", ["Enter"])).ok).toBe(true);
    expect(clock.now()).toBe(0);
    expect(fake.writes().map((w) => w.kind)).toEqual(["text"]);
    await clock.wait(KEY_HOLD_MS);
    await adapter.readGrid("t2", VIEWPORT);
    expect(fake.writes().map((w) => w.kind)).toEqual(["text", "keys"]);
  });
});

describe("terminal.read: incomplete while a full-screen app works (HC_API.md, terminal.read)", () => {
  test("a history read of a working full-screen app is stitched and incomplete, and the grid says partial, not truncated", async () => {
    const { fake, adapter } = build();
    fake.fullScreenApp("t1", true);
    const wire = await fake.readTerminal("t1", 200);
    expect(wire).toMatchObject({ how: "stitched", complete: false, why: "working" });
    const grid = await adapter.readGrid("t1", RECENT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.partial).toBe(true);
    expect(grid.value.truncated).toBe(false);
  });

  test("the same app idle reads stitched and complete; a plain terminal reads history; no history reads the screen", async () => {
    const { fake } = build();
    fake.fullScreenApp("t1", false);
    expect(await fake.readTerminal("t1", 200)).toMatchObject({ how: "stitched", complete: true });
    expect(await fake.readTerminal("t2", 200)).toMatchObject({ how: "history", complete: true });
    fake.fullScreenApp("t1", true);
    expect(await fake.readTerminal("t1", 0)).toMatchObject({ how: "screen", complete: true });
  });

  test("the adapter's viewport read asks for no history, so a working full-screen app still reads whole", async () => {
    const { fake, adapter } = build();
    fake.fullScreenApp("t1", true);
    const grid = await adapter.readGrid("t1", VIEWPORT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.partial).toBeUndefined();
    expect(grid.value.truncated).toBe(false);
    expect(grid.value.text).toContain("Allow edit to src/x.ts?");
  });

  test("a read of any scope the core calls incomplete is shown with its rows and marked partial, never refused", async () => {
    class PartialScreen extends FakeHcCore {
      override async readTerminal(address: string, lines: number): Promise<WireRead> {
        const whole = await super.readTerminal(address, lines);
        return { ...whole, complete: false, why: "working" };
      }
    }
    const adapter = new HerdrCoreMux(new PartialScreen(), "/home/dev");
    for (const request of [VIEWPORT, RECENT]) {
      const grid = await adapter.readGrid("t1", request);
      if (!grid.ok) throw new Error(grid.detail);
      expect(grid.value.partial).toBe(true);
      expect(grid.value.truncated).toBe(false);
      expect(grid.value.text).toContain("Allow edit to src/x.ts?");
    }
  });
});

describe("the size the last active viewer sets (HC_API.md, The terminal record)", () => {
  test("a resize between two reads changes the rows and columns of the grid, and moves the revision", async () => {
    const { fake, adapter } = build();
    const first = await adapter.readGrid("t3", VIEWPORT);
    if (!first.ok) throw new Error(first.detail);
    expect(first.value.text.split("\n")).toHaveLength(6);
    fake.resize("t3", 4, 9);
    const second = await adapter.readGrid("t3", VIEWPORT);
    if (!second.ok) throw new Error(second.detail);
    const rows = second.value.text.split("\n");
    expect(rows).toHaveLength(9);
    expect(Math.max(...rows.map((row) => row.length))).toBeLessThanOrEqual(4);
    expect(second.value.revision).toBe(first.value.revision + 1);
  });

  test("the terminal record carries the new size", async () => {
    const { fake } = build();
    fake.resize("t3", 132, 40);
    expect(await fake.getTerminal("t3")).toMatchObject({ cols: 132, rows: 40 });
  });
});

describe("a program's state words (HC_API.md, Status)", () => {
  test("done is Collie's done, never idle; error is unknown, and the pane is still the agent", async () => {
    const { fake, adapter } = build();
    const statuses = async (): Promise<string[]> => (await adapter.snapshot()).panes.filter((p) => p.paneId === "t1").map((p) => `${p.agent}:${p.status}`);
    for (const [state, expected] of [
      ["idle", "claude:idle"],
      ["working", "claude:working"],
      ["done", "claude:done"],
      ["blocked", "claude:blocked"],
      ["error", "claude:unknown"],
    ] as const) {
      fake.reportState("t1", state);
      expect(await statuses()).toEqual([expected]);
    }
  });

  test("done and idle are two marks the phone ranks apart; error shares unknown's mark", () => {
    expect(STATUS_RANK.done).not.toBe(STATUS_RANK.idle);
    expect(Object.keys(STATUS_RANK).toSorted()).toEqual(["blocked", "done", "idle", "unknown", "working"]);
  });
});

describe("keep: a lost program is replaced by a shell in place (HC_API.md, The terminal record)", () => {
  test("the agent becomes a shell at the same address, in the same place, and the watch hears it", async () => {
    const { fake, adapter } = build();
    const before = (await adapter.snapshot()).panes.find((p) => p.paneId === "t1");
    expect(before).toMatchObject({ agent: "claude", status: "blocked" });
    let topology = 0;
    const watch = adapter.watch({ panes: ["t1"], onTopologyChange: () => (topology += 1), onPaneChange: () => {}, onUp: () => {}, onDown: () => {} });
    await Promise.resolve();
    fake.loseProgram("t1");
    const after = (await adapter.snapshot()).panes.find((p) => p.paneId === "t1");
    expect(after).toMatchObject({ paneId: "t1", agent: "shell", status: "unknown", spaceId: before?.spaceId, tabId: before?.tabId, alive: true });
    expect(topology).toBe(2);
    watch.close();
    const grid = await adapter.readGrid("t1", VIEWPORT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.text).toContain("t1$");
  });

  test("a terminal without keep is a finished record: it leaves the snapshot and every write answers gone", async () => {
    const { fake, adapter } = build();
    fake.loseProgram("t4");
    expect((await adapter.snapshot()).panes.map((p) => p.paneId)).not.toContain("t4");
    expect(reason(await adapter.writeKeys("t4", ["Enter"]))).toBe("gone");
    expect(reason(await adapter.typeText("t4", "x"))).toBe("gone");
    expect(reason(await adapter.closePane("t4"))).toBe("gone");
  });
});

describe("a core stop and start (HC_API.md, error kinds finished and unavailable)", () => {
  test("while it is stopped every call is unreachable, and a stream ends", async () => {
    const { fake, adapter } = build();
    let down = 0;
    const watch = adapter.watch({ panes: [], onTopologyChange: () => {}, onPaneChange: () => {}, onUp: () => {}, onDown: () => (down += 1) });
    await Promise.resolve();
    fake.stopCore();
    expect(down).toBe(1);
    expect(adapter.snapshot()).rejects.toThrow();
    expect(reason(await adapter.writeKeys("t2", ["Enter"]))).toBe("unreachable");
    expect(reason(await adapter.readGrid("t2", VIEWPORT))).toBe("unreachable");
    watch.close();
  });

  test("a kept terminal comes back as a shell at its address, a terminal without keep answers gone", async () => {
    const { fake, adapter } = build();
    fake.stopCore();
    fake.startCore();
    const panes = (await adapter.snapshot()).panes;
    expect(panes.map((p) => [p.paneId, p.agent])).toEqual([
      ["t1", "shell"],
      ["t2", "shell"],
      ["t3", "shell"],
    ]);
    expect((await adapter.writeKeys("t1", ["Enter"])).ok).toBe(true);
    expect(reason(await adapter.writeKeys("t4", ["Enter"]))).toBe("gone");
  });

  test("a kept terminal still waiting for its shell is refused, neither gone nor unreachable, and takes keys after", async () => {
    const { fake, adapter } = build();
    fake.stopCore();
    fake.startCore({ shellsReady: false });
    expect(reason(await adapter.writeKeys("t1", ["Enter"]))).toBe("refused");
    expect(reason(await adapter.typeText("t1", "ls"))).toBe("refused");
    fake.shellsReady();
    expect((await adapter.typeText("t1", "ls")).ok).toBe(true);
  });
});
