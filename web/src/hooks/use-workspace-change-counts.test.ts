import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChangesResponse } from "@/lib/types";

const fetchChanges = vi.fn<(...args: unknown[]) => Promise<ChangesResponse>>();
vi.mock("@/lib/api", () => ({ fetchChanges: (...args: unknown[]) => fetchChanges(...args) }));

const { useWorkspaceChangeCounts } = await import("./use-workspace-change-counts");
const { CHANGES_POLL_MS } = await import("./use-visible-interval");

const CLEAN: ChangesResponse = { available: true, root: "/r", truncated: false, repos: [] };
const targets = [
  { key: "a", workspaceId: "w1", scope: {} },
  { key: "b", workspaceId: "w2", scope: { host: "workshop" } },
];
const lookup = { depth: 2, nested: true };

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  fetchChanges.mockReset();
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
    const CHANGED: ChangesResponse = {
      available: true,
      root: "/r",
      truncated: false,
      repos: [{ relPath: ".", name: "r", files: [{ path: "a.ts", status: "M", added: 2, removed: 1, binary: false }] }],
    };
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
});
