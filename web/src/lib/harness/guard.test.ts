import { describe, expect, it, beforeEach, vi } from "vitest";

// The bounded verification poll. These tests pin the BUDGET BEHAVIOUR, not the numbers: how long the
// guard is willing to wait before it gives up (POLL_ATTEMPTS × POLL_DELAY_MS), that it pays that
// price one delay at a time, and that a check passing on attempt N costs only N delays. The two
// constants are a measured judgement call and may be re-tuned (issue #156) — every assertion below
// is written against the constants so a re-tune moves the wall-clock budget and nothing else.
vi.mock("../api", () => ({ fetchPane: vi.fn() }));

import { fetchPane } from "../api";
import { POLL_ATTEMPTS, POLL_DELAY_MS, pollUntil } from "./guard";
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

    await expect(run(sleep, () => false)).resolves.toBe("timeout");
    expect(mockFetchPane).toHaveBeenCalledTimes(POLL_ATTEMPTS);
    expect(waits).toEqual(Array<number>(POLL_ATTEMPTS).fill(POLL_DELAY_MS));
    expect(waits.reduce((a, b) => a + b, 0)).toBe(POLL_ATTEMPTS * POLL_DELAY_MS);
  });

  it("pays one POLL_DELAY_MS before the FIRST read — the earliest a tap can be verified", async () => {
    mockFetchPane.mockResolvedValue(paneWith("dialog:model pointer=2"));
    const { waits, sleep } = recordingSleep();

    await expect(run(sleep, (m) => m.endsWith("pointer=2"))).resolves.toBe("ok");
    expect(mockFetchPane).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([POLL_DELAY_MS]);
  });

  it("stops the moment the check passes on attempt N, paying only N delays", async () => {
    const n = 3;
    expect(n).toBeLessThan(POLL_ATTEMPTS);
    for (let i = 1; i < n; i++) mockFetchPane.mockResolvedValueOnce(paneWith("dialog:model pointer=1"));
    mockFetchPane.mockResolvedValue(paneWith("dialog:model pointer=2"));
    const { waits, sleep } = recordingSleep();

    await expect(run(sleep, (m) => m.endsWith("pointer=2"))).resolves.toBe("ok");
    expect(mockFetchPane).toHaveBeenCalledTimes(n);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(n * POLL_DELAY_MS);
  });

  it("spends the whole budget on transient read failures rather than bailing early", async () => {
    mockFetchPane.mockImplementation(async () => {
      throw new Error("network hiccup");
    });
    const { waits, sleep } = recordingSleep();

    // Never saw the dialog at all ⇒ "drifted", not a retryable timeout: no blind key may follow.
    await expect(run(sleep, () => true)).resolves.toBe("drifted");
    expect(waits).toHaveLength(POLL_ATTEMPTS);
  });

  it("abandons the budget as soon as the dialog's identity changes", async () => {
    mockFetchPane.mockResolvedValue(paneWith("dialog:permissions pointer=1")); // a different dialog
    const { waits, sleep } = recordingSleep();

    await expect(run(sleep, () => false)).resolves.toBe("drifted");
    expect(waits).toEqual([POLL_DELAY_MS]); // one attempt, not the full budget
  });
});
