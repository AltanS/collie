// The adapter against the unkind parts of the real core (M78 spec 02). Each test turns one switch of
// the fake on (fake-core.ts, every switch cites its HC_API.md line) and pins what the adapter does.
// "Pinned" means the behaviour was there before the test and the test keeps it; "fixed" names the
// test that failed before the change beside it.

import { describe, expect, test } from "bun:test";
import { STATUS_RANK } from "../../types.ts";
import { HerdrCoreMux, HISTORY_READ_BACKOFF_MAX_MS, HISTORY_READ_BACKOFF_MS, HISTORY_READ_BUDGET_MS } from "./adapter.ts";
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

describe("a history read that hangs (HC_API.md, terminal.read `lines` and `how: stitched`; M78 spec 03, pi 2 and 3)", () => {
  // The real core gave no answer to `lines: 60` in 30 s while a pi dialog stood, and answered
  // `lines: 0` in 0.1 s. Fixed: before the budget the read waited out the client's 5 s and refused.
  // No backoff here: these pin the budget alone. The backoff has its own describe below.
  function slow(budget = 40): Built & { lines: string[] } {
    const fake = new FakeHcCore();
    const lines: string[] = [];
    return { fake, adapter: new HerdrCoreMux(fake, "/home/dev", { historyBudgetMs: budget, historyBackoffMs: 0, log: (line) => lines.push(line) }), clock: new ManualClock(), lines };
  }

  test("the budget is 2 s, inside the client's own call budget", () => {
    expect(HISTORY_READ_BUDGET_MS).toBe(2000);
    expect(HISTORY_READ_BUDGET_MS).toBeLessThan(DEFAULT_HC_TIMEOUT_MS);
  });

  test("a history read that never answers: the screen's rows, truncated, within the budget (the default 2 s)", async () => {
    const fake = new FakeHcCore();
    const adapter = new HerdrCoreMux(fake, "/home/dev", { log: () => undefined });
    fake.hangHistoryReads("t1");
    const started = performance.now();
    const grid = await adapter.readGrid("t1", RECENT);
    const took = performance.now() - started;
    if (!grid.ok) throw new Error(grid.detail);
    expect(took).toBeGreaterThanOrEqual(HISTORY_READ_BUDGET_MS - 20);
    expect(took).toBeLessThan(HISTORY_READ_BUDGET_MS + 500);
    expect(grid.value.truncated).toBe(true);
    expect(grid.value.partial).toBeUndefined();
    expect(grid.value.text).toContain("Allow edit to src/x.ts?");
    expect(grid.value.text).not.toContain("earlier line");
  });

  test("a fast history read is unchanged: history rows, not truncated, no log line", async () => {
    const { adapter, lines } = slow();
    const grid = await adapter.readGrid("t1", RECENT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.truncated).toBe(false);
    expect(grid.value.text).toContain("earlier line 1");
    expect(grid.value.text).toContain("Allow edit to src/x.ts?");
    expect(lines).toEqual([]);
  });

  test("the hang is logged once per pane, not once per poll, and again after the pane's history answered", async () => {
    const { fake, adapter, lines } = slow();
    fake.hangHistoryReads("t1");
    for (let poll = 0; poll < 3; poll++) expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("t1");
    expect(lines[0]).not.toMatch(/claude|pi\b|codex/i);
    // The held read must end first: while it runs on the core, no other history read starts.
    fake.hangHistoryReads("t1", false);
    fake.answerHungReads();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const answered = await adapter.readGrid("t1", RECENT);
    if (!answered.ok) throw new Error(answered.detail);
    expect(answered.value.truncated).toBe(false);
    fake.hangHistoryReads("t1");
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(lines).toHaveLength(2);
  });

  test("the late history answer is dropped: the next read is a fresh one, and nothing throws", async () => {
    const { fake, adapter } = slow();
    fake.hangHistoryReads("t1");
    const cut = await adapter.readGrid("t1", RECENT);
    if (!cut.ok) throw new Error(cut.detail);
    fake.hangHistoryReads("t1", false);
    fake.answerHungReads();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const whole = await adapter.readGrid("t1", RECENT);
    if (!whole.ok) throw new Error(whole.detail);
    expect(whole.value.truncated).toBe(false);
    expect(whole.value.text).toContain("earlier line 1");
  });

  test("the viewport read is never held by the switch", async () => {
    const { fake, adapter, lines } = slow();
    fake.hangHistoryReads("t1");
    const grid = await adapter.readGrid("t1", VIEWPORT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.truncated).toBe(false);
    expect(lines).toEqual([]);
  });

  test("a history read that fails inside the budget still fails the read", async () => {
    const { adapter } = slow();
    const grid = await adapter.readGrid("t99", RECENT);
    expect(reason(grid)).not.toBe("ok");
  });
});

describe("a slow history read holds the terminal's keys (M78 report 10, case 2; hc 0.1.14 under pi's permission dialog)", () => {
  // The real core took 25 s for one history read under the dialog, ran a terminal's history reads and
  // key presses one at a time, and kept running a read Collie had given up on. Fixed: before the change
  // every `recent` poll queued one more 25 s read, and the pane's keys never answered again.
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const DIALOG = "Allow edit to src/x.ts?";

  interface Jammed {
    readonly fake: FakeHcCore;
    readonly adapter: HerdrCoreMux;
    readonly lines: string[];
  }

  /** t1 with slow history reads, an adapter with a 20 ms budget, and its log lines. */
  function jam(now: () => number = () => Date.now(), keysTimeoutMs: number | null = null): Jammed {
    const fake = new FakeHcCore();
    const lines: string[] = [];
    const adapter = new HerdrCoreMux(fake, "/home/dev", { historyBudgetMs: 20, now, log: (line) => lines.push(line) });
    fake.slowHistoryReads("t1", { keysTimeoutMs });
    return { fake, adapter, lines };
  }

  function keysSent(fake: FakeHcCore): (readonly string[])[] {
    return fake.writes().filter((w) => w.kind === "keys").map((w) => w.payload);
  }

  test("the backoff is 30 s", () => {
    expect(HISTORY_READ_BACKOFF_MS).toBe(30_000);
  });

  test("ten recent reads during one slow history read start one core read and answer the screen alone; a key then waits for that one read only", async () => {
    const { fake, adapter } = jam();
    const grids = await Promise.all(Array.from({ length: 10 }, () => adapter.readGrid("t1", RECENT)));
    for (const grid of grids) {
      if (!grid.ok) throw new Error(grid.detail);
      expect(grid.value.truncated).toBe(true);
      expect(grid.value.text).toContain(DIALOG);
      expect(grid.value.text).not.toContain("earlier line");
    }
    // Polls past the budget, while the read still runs on the core: still that one read.
    for (let poll = 0; poll < 5; poll++) expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(fake.historyReads("t1")).toBe(1);
    expect(fake.pendingSlowReads("t1")).toBe(1);
    const key = adapter.writeKeys("t1", ["Down"]);
    expect(fake.endSlowRead("t1")).toBe(true);
    expect(await key).toEqual({ ok: true, value: undefined });
    // Nothing else queued: before the fix fourteen more reads stood between the key and the program.
    expect(fake.pendingSlowReads("t1")).toBe(0);
    expect(keysSent(fake)).toEqual([["down"]]);
  });

  test("a pane whose program reports blocked starts no history read at all, so its keys answer at once", async () => {
    const { fake, adapter } = jam();
    await adapter.snapshot(); // t1 is Claude, blocked on a permission
    for (let poll = 0; poll < 3; poll++) {
      const grid = await adapter.readGrid("t1", RECENT);
      if (!grid.ok) throw new Error(grid.detail);
      expect(grid.value.truncated).toBe(true);
      expect(grid.value.text).toContain(DIALOG);
    }
    expect(fake.historyReads("t1")).toBe(0);
    expect(await adapter.writeKeys("t1", ["Down"])).toEqual({ ok: true, value: undefined });
    expect(keysSent(fake)).toEqual([["down"]]);
    // Off the dialog, the next snapshot frees the history read again.
    fake.slowHistoryReads("t1", { on: false });
    fake.reportState("t1", "working");
    await adapter.snapshot();
    const grid = await adapter.readGrid("t1", RECENT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.truncated).toBe(false);
    expect(grid.value.text).toContain("earlier line 1");
    expect(fake.historyReads("t1")).toBe(1);
  });

  test("a screen that changes on every read does not end the backoff: no second history read for 30 s, one log line (fixed)", async () => {
    // pi's dialog redraws every frame (its spinner, the cursor). Before the fix a new screen text
    // ended the backoff, and one dialog started ten 25 s history reads back to back.
    let now = 1_000;
    let frame = 0;
    const { fake, adapter, lines } = jam(() => now);
    const spin = (): void => {
      frame += 1;
      fake.setScreen("t1", ["pi", "", DIALOG, `  ${"|/-\\"[frame % 4] ?? "|"} waiting ${String(frame)}`]);
    };
    spin();
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(lines).toEqual(["[herdr-core] pane t1: history read slow (no answer in 20 ms), screen-only reads for 30 s after it ends"]);
    for (let poll = 0; poll < 5; poll++) {
      spin();
      expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    }
    fake.endSlowRead("t1");
    await tick();
    for (let poll = 0; poll < 10; poll++) {
      spin();
      now += 1_500;
      const grid = await adapter.readGrid("t1", RECENT);
      if (!grid.ok) throw new Error(grid.detail);
      expect(grid.value.truncated).toBe(true);
      expect(grid.value.text).toContain(`waiting ${String(frame)}`);
    }
    now += HISTORY_READ_BACKOFF_MS - 15_000 - 1;
    spin();
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(fake.historyReads("t1")).toBe(1);
    // The keys answer at once: no history read stands in front of them.
    expect(await adapter.writeKeys("t1", ["Down"])).toEqual({ ok: true, value: undefined });
    fake.slowHistoryReads("t1", { on: false });
    now += 1;
    const grid = await adapter.readGrid("t1", RECENT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.truncated).toBe(false);
    expect(fake.historyReads("t1")).toBe(2);
    expect(lines).toHaveLength(1);
  });

  test("each slow read in a row doubles the wait up to 5 min, logged once per doubling; a fast read resets it to 30 s", async () => {
    expect(HISTORY_READ_BACKOFF_MAX_MS).toBe(300_000);
    let now = 1_000;
    const { fake, adapter, lines } = jam(() => now);
    const waits = [30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
    for (const [index, wait] of waits.entries()) {
      expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
      expect(fake.historyReads("t1")).toBe(index + 1);
      fake.endSlowRead("t1");
      await tick();
      now += wait - 1;
      expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
      expect(fake.historyReads("t1")).toBe(index + 1);
      now += 1;
    }
    expect(lines).toEqual([
      "[herdr-core] pane t1: history read slow (no answer in 20 ms), screen-only reads for 30 s after it ends",
      "[herdr-core] pane t1: history read slow again, screen-only reads for 60 s after it ends",
      "[herdr-core] pane t1: history read slow again, screen-only reads for 120 s after it ends",
      "[herdr-core] pane t1: history read slow again, screen-only reads for 240 s after it ends",
      "[herdr-core] pane t1: history read slow again, screen-only reads for 300 s after it ends",
    ]);
    // A history read inside the budget resets the wait: the next slow one waits 30 s again.
    fake.slowHistoryReads("t1", { on: false });
    const fast = await adapter.readGrid("t1", RECENT);
    if (!fast.ok) throw new Error(fast.detail);
    expect(fast.value.truncated).toBe(false);
    fake.slowHistoryReads("t1");
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    fake.endSlowRead("t1");
    await tick();
    const reads = fake.historyReads("t1");
    now += HISTORY_READ_BACKOFF_MS - 1;
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(fake.historyReads("t1")).toBe(reads);
    fake.slowHistoryReads("t1", { on: false });
    now += 1;
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(fake.historyReads("t1")).toBe(reads + 1);
    expect(lines.slice(5)).toEqual(["[herdr-core] pane t1: history read slow (no answer in 20 ms), screen-only reads for 30 s after it ends"]);
  });

  test("a read whose hint says blocked starts no history read, so a pane the core reports working takes keys at once", async () => {
    // pi reports `working` while its dialog waits; the bridge's engine reads the screen's ask and says so.
    const { fake, adapter, lines } = jam();
    fake.reportState("t1", "working");
    await adapter.snapshot();
    for (let poll = 0; poll < 3; poll++) {
      const grid = await adapter.readGrid("t1", { ...RECENT, hint: { blocked: true } });
      if (!grid.ok) throw new Error(grid.detail);
      expect(grid.value.truncated).toBe(true);
      expect(grid.value.text).toContain(DIALOG);
    }
    expect(fake.historyReads("t1")).toBe(0);
    expect(await adapter.writeKeys("t1", ["Down"])).toEqual({ ok: true, value: undefined });
    expect(keysSent(fake)).toEqual([["down"]]);
    expect(lines).toEqual([]);
    // Without the hint the history read runs again.
    fake.slowHistoryReads("t1", { on: false });
    const grid = await adapter.readGrid("t1", { ...RECENT, hint: { blocked: false } });
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.truncated).toBe(false);
    expect(fake.historyReads("t1")).toBe(1);
  });

  test("or until the backoff passed, counted from the end of the slow read, not from the budget", async () => {
    let now = 1_000;
    const { fake, adapter } = jam(() => now);
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    // The core still runs the read a minute later: no second one starts.
    now += 60_000;
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(fake.historyReads("t1")).toBe(1);
    fake.endSlowRead("t1");
    await tick();
    fake.slowHistoryReads("t1", { on: false });
    now += HISTORY_READ_BACKOFF_MS - 1;
    expect((await adapter.readGrid("t1", RECENT)).ok).toBe(true);
    expect(fake.historyReads("t1")).toBe(1);
    now += 1;
    const grid = await adapter.readGrid("t1", RECENT);
    if (!grid.ok) throw new Error(grid.detail);
    expect(grid.value.truncated).toBe(false);
    expect(fake.historyReads("t1")).toBe(2);
  });

  test("a key the core does not confirm in time is unconfirmed, not a failure, and lands once when its turn comes", async () => {
    const { fake, adapter } = jam(undefined, 20);
    const held = fake.readTerminal("t1", 60); // a history read already on the core, as from an earlier poll
    const sent = await adapter.writeKeys("t1", ["Down"]);
    expect(reason(sent)).toBe("unconfirmed");
    if (sent.ok) throw new Error("expected unconfirmed");
    expect(sent.detail).toContain("may still arrive");
    expect(keysSent(fake)).toEqual([]);
    fake.endSlowRead("t1");
    await held;
    await tick();
    // The real `Down` reached pi after the bridge had called it failed. It lands once: nothing resent it.
    expect(keysSent(fake)).toEqual([["down"]]);
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
