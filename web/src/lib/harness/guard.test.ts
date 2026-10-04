import { describe, expect, it, beforeEach, vi } from "vitest";

// The bounded verification poll. These tests pin the BUDGET BEHAVIOUR, not the numbers: how long the
// guard is willing to wait before it gives up (POLL_ATTEMPTS × POLL_DELAY_MS), that it pays that
// price one delay at a time, and that a check passing on attempt N costs only N delays. The two
// constants are a measured judgement call and may be re-tuned (issue #156) — every assertion below
// is written against the constants so a re-tune moves the wall-clock budget and nothing else.
vi.mock("../api", () => ({ fetchPane: vi.fn(), textBeforeLastSend: vi.fn() }));

import { fetchPane, textBeforeLastSend } from "../api";
import { POLL_ATTEMPTS, POLL_DELAY_MS, SETTLE_DELAYS_MS, pollUntil, settleAfterSend } from "./guard";
import { lineText, type StyledLine } from "../blocks";

const mockFetchPane = vi.mocked(fetchPane);

const paneWith = (text: string) => ({ paneId: "w1:p1", text, truncated: false, revision: 0 });

/** The model under test is just the pane's first line — enough to be present, accepted, or replaced. */
const detect = (lines: StyledLine[]): string | null => {
  const first = lines[0] ? lineText(lines[0]) : "";
  return first.startsWith("dialog:") ? first : null;
};
const identity = (a: string, b: string) => a.split(" ")[0] === b.split(" ")[0];

/** A sleep seam that records what it was asked to wait, and never actually waits. */
function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

const run = (
  sleep: (ms: number) => Promise<void>,
  accept: (m: string) => boolean,
  tapped = "dialog:model pointer=1",
) => pollUntil({ paneId: "w1:p1", requestedLines: 600, sleep }, tapped, detect, accept, identity);

// Block body, not a concise arrow: vitest treats a function RETURNED from beforeEach as the
// teardown hook, and the mock is a function — it would be called after every test.
beforeEach(() => {
  mockFetchPane.mockReset();
});

describe("pollUntil — the verification budget", () => {
  it("gives up after exactly POLL_ATTEMPTS reads spaced POLL_DELAY_MS apart", async () => {
    mockFetchPane.mockResolvedValue(paneWith("dialog:model pointer=1")); // the state never arrives
    const { waits, sleep } = recordingSleep();

    await expect(run(sleep, () => false)).resolves.toEqual({ status: "timeout" });
    expect(mockFetchPane).toHaveBeenCalledTimes(POLL_ATTEMPTS);
    expect(waits).toEqual(Array<number>(POLL_ATTEMPTS).fill(POLL_DELAY_MS));
    expect(waits.reduce((a, b) => a + b, 0)).toBe(POLL_ATTEMPTS * POLL_DELAY_MS);
  });

  it("pays one POLL_DELAY_MS before the FIRST read — the earliest a tap can be verified", async () => {
    mockFetchPane.mockResolvedValue(paneWith("dialog:model pointer=2"));
    const { waits, sleep } = recordingSleep();

    await expect(run(sleep, (m) => m.endsWith("pointer=2"))).resolves.toEqual({
      status: "ok",
      model: "dialog:model pointer=2",
      revision: expect.any(Number),
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([POLL_DELAY_MS]);
  });

  it("stops the moment the check passes on attempt N, paying only N delays", async () => {
    const n = 3;
    expect(n).toBeLessThan(POLL_ATTEMPTS);
    for (let i = 1; i < n; i++) mockFetchPane.mockResolvedValueOnce(paneWith("dialog:model pointer=1"));
    mockFetchPane.mockResolvedValue(paneWith("dialog:model pointer=2"));
    const { waits, sleep } = recordingSleep();

    await expect(run(sleep, (m) => m.endsWith("pointer=2"))).resolves.toEqual({
      status: "ok",
      model: "dialog:model pointer=2",
      revision: expect.any(Number),
    });
    expect(mockFetchPane).toHaveBeenCalledTimes(n);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(n * POLL_DELAY_MS);
  });

  it("spends the whole budget on transient read failures rather than bailing early", async () => {
    mockFetchPane.mockImplementation(async () => {
      throw new Error("network hiccup");
    });
    const { waits, sleep } = recordingSleep();

    // Never saw the dialog at all ⇒ "drifted", not a retryable timeout: no blind key may follow.
    await expect(run(sleep, () => true)).resolves.toEqual({ status: "drifted" });
    expect(waits).toHaveLength(POLL_ATTEMPTS);
  });

  it("abandons the budget as soon as the dialog's identity changes", async () => {
    mockFetchPane.mockResolvedValue(paneWith("dialog:permissions pointer=1")); // a different dialog
    const { waits, sleep } = recordingSleep();

    // The drifted model comes back, so a caller can say which field differed.
    await expect(run(sleep, () => false)).resolves.toEqual({
      status: "drifted",
      model: "dialog:permissions pointer=1",
    });
    expect(waits).toEqual([POLL_DELAY_MS]); // one attempt, not the full budget
  });
});

// settleAfterSend: after a key, wait until the pane text leaves what it showed at the send, or give up
// at a short bound. Virtual time throughout: the sleep seam advances a clock and the reader answers by
// that clock, so nothing here waits for real.
describe("settleAfterSend", () => {
  const BOUND_MS = SETTLE_DELAYS_MS.reduce((a, b) => a + b, 0);

  /** A pane whose text turns from "before" to "after" at `changeAtMs` of virtual time. */
  function virtualPane(changeAtMs: number) {
    let now = 0;
    let reads = 0;
    return {
      reads: () => reads,
      now: () => now,
      sleep: async (ms: number) => void (now += ms),
      read: async () => {
        reads += 1;
        return { text: now >= changeAtMs ? "after" : "before" };
      },
    };
  }

  const settle = (pane: ReturnType<typeof virtualPane>, from: string | undefined = "before") =>
    settleAfterSend({ paneId: "w1:p1", requestedLines: 200, from, sleep: pane.sleep, read: pane.read });

  it("the bound is about 1.2 s and the first read comes about 60 ms after the send", () => {
    expect(BOUND_MS).toBeGreaterThanOrEqual(1100);
    expect(BOUND_MS).toBeLessThanOrEqual(1300);
    expect(SETTLE_DELAYS_MS[0]).toBeGreaterThanOrEqual(50);
    expect(SETTLE_DELAYS_MS[0]).toBeLessThanOrEqual(70);
  });

  it.each([0, 20])("returns on the first read when the repaint lands at %i ms", async (changeAt) => {
    const pane = virtualPane(changeAt);
    await expect(settle(pane)).resolves.toBe(true);
    expect(pane.reads()).toBe(1);
    expect(pane.now()).toBe(SETTLE_DELAYS_MS[0]);
  });

  it("returns as soon as a changed read is seen when the repaint is slow (300 ms)", async () => {
    const pane = virtualPane(300);
    await expect(settle(pane)).resolves.toBe(true);
    expect(pane.reads()).toBeGreaterThan(1);
    expect(pane.reads()).toBeLessThan(SETTLE_DELAYS_MS.length);
    expect(pane.now()).toBeLessThanOrEqual(BOUND_MS);
  });

  it("gives up at its bound when nothing ever changes (2000 ms), with a bounded number of reads", async () => {
    const pane = virtualPane(2000);
    await expect(settle(pane)).resolves.toBe(false);
    expect(pane.reads()).toBe(SETTLE_DELAYS_MS.length);
    expect(pane.now()).toBe(BOUND_MS);
  });

  it("never throws: a failing read counts as unchanged", async () => {
    const waits: number[] = [];
    const settled = await settleAfterSend({
      paneId: "w1:p1",
      requestedLines: 200,
      from: "before",
      sleep: async (ms) => void waits.push(ms),
      read: async () => {
        throw new Error("bridge down");
      },
    });
    expect(settled).toBe(false);
    expect(waits).toEqual([...SETTLE_DELAYS_MS]);
  });

  it("takes its baseline from the text at the latest send when none is passed, and waits for nothing without one", async () => {
    const pane = virtualPane(20);
    vi.mocked(textBeforeLastSend).mockReturnValueOnce("before");
    await expect(
      settleAfterSend({ paneId: "w1:p1", requestedLines: 200, sleep: pane.sleep, read: pane.read }),
    ).resolves.toBe(true);

    const idle = virtualPane(2000);
    vi.mocked(textBeforeLastSend).mockReturnValueOnce(undefined);
    await expect(
      settleAfterSend({ paneId: "w1:p1", requestedLines: 200, sleep: idle.sleep, read: idle.read }),
    ).resolves.toBe(false);
    expect(idle.reads()).toBe(0);
  });
});
