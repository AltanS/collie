import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Spied at the api seam, not over the network: the invariant under test is how MANY times the
// store asks, and a mock records that synchronously — no waiting on a request that may never come.
vi.mock("@/lib/api", () => ({ fetchConfig: vi.fn() }));

import { fetchConfig } from "@/lib/api";
import type { BridgeConfig } from "@/lib/types";
import {
  __resetOperatorCommands,
  getOperatorCommands,
  loadOperatorCommands,
  useOperatorCommands,
} from "./operator-commands";

const asked = vi.mocked(fetchConfig);

const forkIn = {
  agent: "omp",
  command: "/fork-in-herdr",
  description: "Fork into a new herdr tab",
  takesArg: false,
  argHint: "",
};

const config = (operatorCommands?: BridgeConfig["operatorCommands"]): BridgeConfig => ({
  push: false,
  vapidPublicKey: "",
  // Optional on BridgeConfig: an absent key and an explicit `undefined` read the same downstream.
  operatorCommands,
});

beforeEach(() => asked.mockReset());
afterEach(() => __resetOperatorCommands());

describe("the operator's palette rows are read once, not polled", () => {
  it("fetches on the first mount and serves later mounts from module state", async () => {
    asked.mockResolvedValue(config([forkIn]));
    const first = renderHook(() => useOperatorCommands());
    await waitFor(() => expect(first.result.current).toEqual([forkIn]));
    first.unmount();
    const second = renderHook(() => useOperatorCommands());
    expect(second.result.current).toEqual([forkIn]); // no second round trip, no flash of empty
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("does not re-request when the composer re-renders around it", async () => {
    asked.mockResolvedValue(config([forkIn]));
    const { result, rerender } = renderHook(() => useOperatorCommands());
    await waitFor(() => expect(result.current).toEqual([forkIn]));
    for (let i = 0; i < 20; i++) rerender();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("survives a refusal as an empty list, retried on a later mount, not on every render", async () => {
    // Extras are additive: with none, the palette is exactly what a user without the var sees. So a
    // read-only device or an auth lapse costs an empty list and nothing else — and, critically, the
    // composer re-renders on every 1.5s snapshot, so a kick in the render body would turn one
    // refusal into a request per tick, forever.
    asked.mockRejectedValue(new Error("403"));
    const { result, rerender } = renderHook(() => useOperatorCommands());
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 20; i++) rerender();
    expect(result.current).toEqual([]);
    expect(asked).toHaveBeenCalledTimes(1); // the failure did not arm a request loop
    expect(getOperatorCommands()).toEqual([]);

    asked.mockResolvedValue(config([forkIn]));
    const retry = renderHook(() => useOperatorCommands()); // a later mount is the retry
    await waitFor(() => expect(retry.result.current).toEqual([forkIn]));
  });

  it("shares one in-flight request between concurrent callers", async () => {
    // All three land before the first response resolves, so the second and third must join the
    // promise already in flight rather than opening their own.
    asked.mockResolvedValue(config([forkIn]));
    const all = Promise.all([loadOperatorCommands(), loadOperatorCommands(), loadOperatorCommands()]);
    expect(asked).toHaveBeenCalledTimes(1);
    await all;
    expect(getOperatorCommands()).toEqual([forkIn]);
  });

  it("treats a bridge that sends no operatorCommands as no extras", async () => {
    asked.mockResolvedValue(config());
    await loadOperatorCommands();
    expect(getOperatorCommands()).toEqual([]);
  });
});
