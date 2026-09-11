import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The bounded-transcript hook, tested in isolation against a mocked fetch. The contract under
// test here is the one the agentic review reproduced (finding F2) and the PRD's refresh story:
// entry + at most ONE delayed retry on an idle pane, coalesced triggers, merge-by-uuid, and
// stale-response discard across a pane address change.

const { fetchHistory } = vi.hoisted(() => ({ fetchHistory: vi.fn() }));
vi.mock("@/lib/api", () => ({ fetchHistory }));

import { useConversation } from "./use-conversation";
import { internScope } from "@/lib/scope";
import type { TranscriptEntry } from "@/lib/types";

function entry(uuid: string, text: string): TranscriptEntry {
  return { uuid, ts: "2026-07-25T06:22:21.253Z", role: "user", parts: [{ kind: "text", text }] };
}
function page(entries: TranscriptEntry[], available = true) {
  return { available, reason: available ? undefined : "disabled", entries, hasMore: false, total: entries.length, fileTruncated: false };
}
/** Flush pending microtasks/promises under fake timers. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

const SETTLE_MS = 1500;
const RETRY_MS = 1200;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useConversation — bounded fetch cadence", () => {
  it("an idle pane fetches on entry plus at most ONE delayed retry, then goes quiet", async () => {
    fetchHistory.mockResolvedValue(page([entry("t1", "hello")]));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_MS + 100); // the bounded retry fires here
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("ok");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // an idle pane must stay quiet
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("a slow in-flight fetch is superseded by the one retry, which does not rearm", async () => {
    let release!: (value: ReturnType<typeof page>) => void;
    fetchHistory.mockImplementationOnce(() => new Promise((res) => (release = res)));
    fetchHistory.mockResolvedValue(page([entry("t1", "hello")]));
    renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_MS + 100); // retry fires while the entry fetch hangs
    });
    // The retry superseded the hung pass (its cleanup aborts it) and resolved.
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    await act(async () => {
      release(page([entry("t1", "late")]));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // no further polling
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping triggers into a single fetch pass", async () => {
    fetchHistory.mockResolvedValue(page([entry("t1", "hello")]));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.refresh();
      result.current.bump();
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("coalesces a trigger arriving just before the delayed retry expires", async () => {
    fetchHistory.mockResolvedValue(page([]));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS - 60); });
    act(() => result.current.bump());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("coalesces send, foreground and explicit events across tasks, then retries journal lag once", async () => {
    fetchHistory.mockResolvedValue(page([entry("t1", "before flush")]));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const before = fetchHistory.mock.calls.length;
    act(() => result.current.bump());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    act(() => result.current.refresh());
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(before + 1);
    fetchHistory.mockResolvedValue(page([entry("t1", "after flush")]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchHistory).toHaveBeenCalledTimes(before + 2);
    expect(result.current.entries[0]?.parts).toEqual([{ kind: "text", text: "after flush" }]);
  });

  it("a mirror change settles into exactly one fetch, plus one bounded retry", async () => {
    fetchHistory.mockResolvedValue(page([]));
    const { rerender } = renderHook(({ mirrorText }) => useConversation({ paneId: "p1", enabled: true, mirrorText }), {
      initialProps: { mirrorText: "tail" },
    });
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    rerender({ mirrorText: "tail + more output" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTLE_MS + 50);
    });
    expect(fetchHistory).toHaveBeenCalledTimes(3); // the settled change, not per-poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RETRY_MS + 100);
    });
    expect(fetchHistory).toHaveBeenCalledTimes(4); // its single bounded retry
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchHistory).toHaveBeenCalledTimes(4);
  });
});

describe("useConversation — source lifecycle", () => {
  it("retains transcript objects while reading Terminal but rejects the paused request", async () => {
    fetchHistory.mockResolvedValueOnce(page([entry("t1", "cached")]));
    const { result, rerender } = renderHook(({ active }) => useConversation({ paneId: "p1", enabled: true, active, mirrorText: "tail" }), { initialProps: { active: true } });
    await settle();
    const cached = result.current.entries;
    let release!: (value: ReturnType<typeof page>) => void;
    fetchHistory.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    act(() => result.current.refresh());
    await settle();
    rerender({ active: false });
    expect(result.current.entries).toBe(cached);
    await act(async () => release(page([entry("late", "must not land")])));
    expect(result.current.entries).toBe(cached);
    fetchHistory.mockResolvedValue(page([entry("t1", "cached")]));
    rerender({ active: true });
    expect(result.current.entries).toBe(cached);
    await settle();
    expect(result.current.entries[0]?.uuid).toBe("t1");
  });

  it.each([
    { scope: { host: "other" }, sourceKey: "crew-a" },
    { scope: { session: "other" }, sourceKey: "crew-a" },
    { scope: {}, sourceKey: "crew-b" },
  ])("rejects late content across observable scope/source changes: %j", async (next) => {
    let release!: (value: ReturnType<typeof page>) => void;
    fetchHistory.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    fetchHistory.mockResolvedValue(page([entry("new", "current source")]));
    const { result, rerender } = renderHook(({ scope, sourceKey }) => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail", scope: internScope(scope), sourceKey }), {
      initialProps: { scope: {}, sourceKey: "crew-a" },
    });
    await settle();
    rerender(next);
    await settle();
    await act(async () => release(page([entry("old", "previous source")])));
    expect(result.current.entries.map(e => e.uuid)).toEqual(["new"]);
  });

  it("does not fetch again for an equivalent scope object on a pane poll", async () => {
    fetchHistory.mockResolvedValue(page([]));
    const { rerender } = renderHook(({ scope }) => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail", scope }), { initialProps: { scope: { host: "same" } } });
    await settle();
    rerender({ scope: { host: "same" } });
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(1);
  });

  it("arms a fresh bounded retry when the same hook moves to a new address", async () => {
    fetchHistory.mockResolvedValue(page([]));
    const { rerender } = renderHook(({ paneId }) => useConversation({ paneId, enabled: true, mirrorText: "tail" }), {
      initialProps: { paneId: "p1" },
    });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    rerender({ paneId: "p2" });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchHistory).toHaveBeenCalledTimes(4);
  });
});

describe("useConversation — thread semantics", () => {
  it("honors a successful empty page after a populated page", async () => {
    fetchHistory.mockResolvedValueOnce(page([entry("old", "previous turn")]));
    fetchHistory.mockResolvedValue(page([]));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    expect(result.current.entries).toHaveLength(1);
    act(() => result.current.refresh());
    await settle();
    expect(result.current.state).toBe("ok");
    expect(result.current.entries).toEqual([]);
  });

  it("clears the cache on observed session loss and rejects its pending response on recovery", async () => {
    fetchHistory.mockResolvedValueOnce(page([entry("old", "previous session")]));
    const { result, rerender } = renderHook(({ enabled }) => useConversation({ paneId: "p1", enabled, mirrorText: "tail" }), {
      initialProps: { enabled: true },
    });
    await settle();
    expect(result.current.entries).toHaveLength(1);
    let release!: (value: ReturnType<typeof page>) => void;
    fetchHistory.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    act(() => result.current.refresh());
    await settle();
    rerender({ enabled: false });
    expect(result.current.entries).toEqual([]);
    fetchHistory.mockResolvedValue(page([]));
    rerender({ enabled: true });
    expect(result.current.entries).toEqual([]);
    await settle();
    expect(result.current.state).toBe("ok");
    await act(async () => release(page([entry("stale", "old session response")])));
    expect(result.current.entries).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(result.current.entries).toEqual([]);
  });

  it("invalidates cached entries when the history response reports no session", async () => {
    fetchHistory.mockResolvedValueOnce(page([entry("old", "previous session")]));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    fetchHistory.mockResolvedValue({ ...page([], false), reason: "no-session" });
    act(() => result.current.refresh());
    await settle();
    expect(result.current.state).toBe("no-session");
    expect(result.current.entries).toEqual([]);
  });
  it("replaces a re-fetched entry by uuid instead of duplicating it", async () => {
    fetchHistory.mockResolvedValueOnce(page([entry("t1", "first read")]));
    fetchHistory.mockResolvedValue(page([entry("t1", "REPLACED")]));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    expect(result.current.entries).toHaveLength(1);
    act(() => result.current.refresh());
    await settle();
    // Same uuid, later tool results: the on-screen copy is replaced, not duplicated.
    expect(result.current.entries).toHaveLength(1);
    // SAFETY: the fixture part is a text part; the assertion itself is the invariant check.
    expect(result.current.entries[0]!.parts[0]).toMatchObject({ kind: "text", text: "REPLACED" });
  });

  it("keeps cached entries visible when a later pass reports the transcript unavailable", async () => {
    fetchHistory.mockResolvedValueOnce(page([entry("t1", "hello")]));
    fetchHistory.mockResolvedValue(page([], false));
    const { result } = renderHook(() => useConversation({ paneId: "p1", enabled: true, mirrorText: "tail" }));
    await settle();
    expect(result.current.entries).toHaveLength(1);
    act(() => result.current.refresh());
    await settle();
    expect(result.current.state).toBe("disabled");
    expect(result.current.entries).toHaveLength(1); // the cache is retained for the view to keep
  });

  it("discards a stale response that answers a previous pane address", async () => {
    let releaseP1!: (value: ReturnType<typeof page>) => void;
    fetchHistory.mockImplementationOnce(() => new Promise((res) => (releaseP1 = res)));
    fetchHistory.mockResolvedValue(page([entry("p2-entry", "from pane two")]));
    const { result, rerender } = renderHook(({ paneId }) => useConversation({ paneId, enabled: true, mirrorText: "tail" }), {
      initialProps: { paneId: "p1" },
    });
    await settle(); // p1's fetch is hung
    rerender({ paneId: "p2" }); // address change: clears, aborts, refetches
    await settle();
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]!.uuid).toBe("p2-entry");
    // The late p1 response must never land.
    await act(async () => {
      releaseP1(page([entry("stale", "from pane one")]));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.entries[0]!.uuid).toBe("p2-entry");
  });
});