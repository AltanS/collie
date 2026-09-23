import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneReadResponse } from "@/lib/types";

// The read a row starts on `pointerdown` (lib/pane-prefetch.ts), handed to the pane loader once.
// `fetchPane` is replaced so each case counts the reads and decides when they answer.

const fetchPane = vi.fn<(...args: unknown[]) => Promise<PaneReadResponse>>();
vi.mock("@/lib/api", () => ({ fetchPane: (...args: unknown[]) => fetchPane(...args) }));

const { PREFETCH_TTL_MS, prefetchPane, resetPanePrefetch, takePanePrefetch } = await import("./pane-prefetch");

const body = (text: string): PaneReadResponse => ({ paneId: "w1:p1", text, truncated: false, revision: 1 });
const LEAD = undefined;
const PEER = { host: "minibuch" };

beforeEach(() => {
  fetchPane.mockReset();
  fetchPane.mockImplementation(async () => body("hello"));
});

afterEach(() => {
  resetPanePrefetch();
  vi.useRealTimers();
});

describe("the pane prefetch", () => {
  it("reads without marking the pane seen, since a finger landing may be a scroll", () => {
    void prefetchPane("w1:p1", LEAD, 600);
    expect(fetchPane).toHaveBeenCalledExactlyOnceWith("w1:p1", 600, LEAD, undefined, { seen: false });
  });

  it("hands the read to the loader once, and never again", async () => {
    void prefetchPane("w1:p1", LEAD, 600);
    const taken = takePanePrefetch("w1:p1", LEAD, 600);
    expect(taken).toBeDefined();
    await expect(taken).resolves.toMatchObject({ text: "hello" });
    expect(takePanePrefetch("w1:p1", LEAD, 600)).toBeUndefined();
  });

  it("keeps a read apart per machine: another host's w1:p1 is not this one", () => {
    void prefetchPane("w1:p1", PEER, 600);
    expect(takePanePrefetch("w1:p1", LEAD, 600)).toBeUndefined();
    expect(takePanePrefetch("w1:p1", PEER, 600)).toBeDefined();
  });

  it("does not hand out a read asked with another scrollback window", () => {
    void prefetchPane("w1:p1", LEAD, 600);
    expect(takePanePrefetch("w1:p1", LEAD, 1200)).toBeUndefined();
  });

  it("stops offering a read once it is older than the TTL", () => {
    vi.useFakeTimers();
    void prefetchPane("w1:p1", LEAD, 600);
    vi.advanceTimersByTime(PREFETCH_TTL_MS);
    expect(takePanePrefetch("w1:p1", LEAD, 600)).toBeUndefined();
  });

  it("reuses a fresh read for a finger that lands on the same row again", () => {
    vi.useFakeTimers();
    void prefetchPane("w1:p1", LEAD, 600);
    vi.advanceTimersByTime(PREFETCH_TTL_MS - 1);
    void prefetchPane("w1:p1", LEAD, 600);
    expect(fetchPane).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    void prefetchPane("w1:p1", LEAD, 600);
    expect(fetchPane).toHaveBeenCalledTimes(2);
  });

  it("settles without rejecting when the read fails, and the loader sees the failure", async () => {
    fetchPane.mockImplementation(async () => {
      throw new Error("bridge down");
    });
    await expect(prefetchPane("w1:p1", LEAD, 600)).resolves.toBeUndefined();
    await expect(takePanePrefetch("w1:p1", LEAD, 600)).rejects.toThrow("bridge down");
  });

  it("settles only when the answer is in", async () => {
    let answer = (_: PaneReadResponse) => {};
    fetchPane.mockImplementation(() => new Promise((r) => (answer = r)));
    let done = false;
    void prefetchPane("w1:p1", LEAD, 600).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    answer(body("late"));
    await vi.waitFor(() => expect(done).toBe(true));
  });
});
