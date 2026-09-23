import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangesResponse } from "@/lib/types";

const fetchChanges = vi.fn<(...args: unknown[]) => Promise<ChangesResponse>>();
vi.mock("@/lib/api", () => ({ fetchChanges: (...args: unknown[]) => fetchChanges(...args) }));

const { resetChangeCountCache, useWorkspaceChangeCounts } = await import("./use-workspace-change-counts");
const { CHANGES_POLL_MS } = await import("./use-visible-interval");

const CLEAN: ChangesResponse = { available: true, root: "/r", truncated: false, repos: [] };
const targets = [
  { key: "a", workspaceId: "w1", scope: {} },
  { key: "b", workspaceId: "w2", scope: { host: "workshop" } },
];
const lookup = { depth: 2, nested: true };
const CHANGED: ChangesResponse = {
  available: true,
  root: "/r",
  truncated: false,
  repos: [{ relPath: ".", name: "r", files: [{ path: "a.ts", status: "M", added: 2, removed: 1, binary: false }] }],
};

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  fetchChanges.mockReset();
  resetChangeCountCache();
  fetchChanges.mockResolvedValue(CLEAN);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Let every pending promise settle without moving the clock. */
const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

describe("useWorkspaceChangeCounts", () => {
  it("asks every workspace on open, on its own machine, with the Changes prefs", async () => {
    const { result } = renderHook(() => useWorkspaceChangeCounts(targets, lookup, true));
    await flush();
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    expect(fetchChanges.mock.calls[1]!.slice(0, 3)).toEqual([{ kind: "space", spaceId: "w2" }, lookup, { host: "workshop" }]);
    expect(result.current.get("a")).toEqual({ kind: "clean" });
  });

  it("reads again 5 s after a round ends, and never overlaps two rounds", async () => {
    let release: () => void = () => {};
    fetchChanges.mockImplementation(() => new Promise((r) => (release = () => r(CLEAN))));
    renderHook(() => useWorkspaceChangeCounts(targets.slice(0, 1), lookup, true));
    await flush();
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    // The answer is slow: no second request while the first is still out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANGES_POLL_MS * 3);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(CHANGES_POLL_MS - 1);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(2);
  });

  it("skips its rounds while the page is hidden, and reads at once when it is visible again", async () => {
    renderHook(() => useWorkspaceChangeCounts(targets.slice(0, 1), lookup, true));
    await flush();
    visibility = "hidden";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANGES_POLL_MS * 4);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(2);
  });

  it("reads at once when the tab is entered, not on the first beat", async () => {
    const { rerender } = renderHook(({ on }) => useWorkspaceChangeCounts(targets, lookup, on), {
      initialProps: { on: false },
    });
    await flush();
    expect(fetchChanges).not.toHaveBeenCalled();
    rerender({ on: true });
    await flush();
    expect(fetchChanges).toHaveBeenCalledTimes(2);
  });

  it("on coming back, replaces a round still out from before the page was hidden", async () => {
    const signals: AbortSignal[] = [];
    fetchChanges.mockImplementation((...args: unknown[]) => {
      const signal = args[3];
      if (signal instanceof AbortSignal) signals.push(signal);
      return new Promise(() => {});
    });
    renderHook(() => useWorkspaceChangeCounts(targets.slice(0, 1), lookup, true));
    await flush();
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(CHANGES_POLL_MS * 2);
    });
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The hung read is dropped and a new one is out at once.
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it("stops when the tab is left", async () => {
    const { rerender } = renderHook(({ on }) => useWorkspaceChangeCounts(targets, lookup, on), {
      initialProps: { on: true },
    });
    await flush();
    rerender({ on: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANGES_POLL_MS * 4);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(2);
  });

  it("keeps the same map through beats that answer the same, so the dashboard does not render", async () => {
    // A fresh object every read, the way a fetch answers.
    fetchChanges.mockImplementation(async () => structuredClone(CHANGED));
    const { result } = renderHook(() => useWorkspaceChangeCounts(targets, lookup, true));
    await flush();
    const first = result.current;
    expect(first.get("a")).toEqual({ kind: "changed", files: 1, added: 2, removed: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANGES_POLL_MS * 3);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(8);
    expect(result.current).toBe(first);
  });

  it("keeps a row's last answer when a later read fails", async () => {
    const { result } = renderHook(() => useWorkspaceChangeCounts(targets.slice(0, 1), lookup, true));
    await flush();
    fetchChanges.mockRejectedValue(new Error("down"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHANGES_POLL_MS);
    });
    expect(fetchChanges).toHaveBeenCalledTimes(2);
    expect(result.current.get("a")).toEqual({ kind: "clean" });
  });

  it("shows the last answer at once when the tab is entered again, then refreshes it", async () => {
    const first = renderHook(() => useWorkspaceChangeCounts(targets, lookup, true));
    await flush();
    expect(first.result.current.get("a")).toEqual({ kind: "clean" });
    first.unmount();

    const releases: (() => void)[] = [];
    fetchChanges.mockImplementation(() => new Promise((r) => releases.push(() => r(structuredClone(CHANGED)))));
    const again = renderHook(() => useWorkspaceChangeCounts(targets, lookup, true));
    // Before any answer: the kept numbers, not loading.
    expect(again.result.current.get("a")).toEqual({ kind: "clean" });
    expect(again.result.current.get("b")).toEqual({ kind: "clean" });
    await flush();
    expect(again.result.current.get("a")).toEqual({ kind: "clean" });
    // The refresh then updates the kept numbers in place.
    await act(async () => {
      for (const r of releases) r();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(again.result.current.get("a")).toEqual({ kind: "changed", files: 1, added: 2, removed: 1 });
  });

  it("keys the kept answer by machine, workspace and Changes settings", async () => {
    const first = renderHook(() => useWorkspaceChangeCounts(targets, lookup, true));
    await flush();
    first.unmount();
    fetchChanges.mockImplementation(() => new Promise(() => {}));
    // Other settings: nothing kept for them.
    const deeper = renderHook(() => useWorkspaceChangeCounts(targets, { depth: 3, nested: true }, true));
    expect(deeper.result.current.size).toBe(0);
    deeper.unmount();
    const flat = renderHook(() => useWorkspaceChangeCounts(targets, { depth: 2, nested: false }, true));
    expect(flat.result.current.size).toBe(0);
    flat.unmount();
    // The same workspace on another machine: nothing kept either.
    const elsewhere = renderHook(() =>
      useWorkspaceChangeCounts([{ key: "a", workspaceId: "w1", scope: { host: "attic" } }], lookup, true),
    );
    expect(elsewhere.result.current.size).toBe(0);
    elsewhere.unmount();
    // The same settings and machine: kept.
    const same = renderHook(() => useWorkspaceChangeCounts(targets, lookup, true));
    expect(same.result.current.get("b")).toEqual({ kind: "clean" });
  });
});
