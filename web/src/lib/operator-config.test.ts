import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Spied at the api seam, not over the network: the invariant under test is how MANY times the
// store asks, and a mock records that synchronously — no waiting on a request that may never come.
vi.mock("@/lib/api", () => ({ fetchConfig: vi.fn() }));

import { fetchConfig } from "@/lib/api";
import type { BridgeConfig } from "@/lib/types";
import {
  __resetOperatorCommands,
  getLaunchers,
  getOperatorCommands,
  loadOperatorCommands,
  useLaunchers,
  useOperatorCommands,
  useOperatorKeys,
  useOperatorQuickReplies,
} from "./operator-config";

const asked = vi.mocked(fetchConfig);

const forkIn = {
  agent: "omp",
  command: "/fork-in-herdr",
  description: "Fork into a new herdr tab",
  takesArg: false,
  argHint: "",
};

const config = (
  operatorCommands?: BridgeConfig["operatorCommands"],
  extra?: Partial<BridgeConfig>,
): BridgeConfig => ({
  push: false,
  vapidPublicKey: "",
  // Optional on BridgeConfig: an absent key and an explicit `undefined` read the same downstream.
  operatorCommands,
  ...extra,
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

describe("the Keys-tray presets ride the same one read", () => {
  it("one fetch answers both hooks", async () => {
    const interrupt = { label: "Interrupt", keys: ["ctrl+c"], danger: false };
    asked.mockResolvedValue({ ...config([forkIn]), operatorKeys: [interrupt] });

    const keys = renderHook(() => useOperatorKeys());
    const commands = renderHook(() => useOperatorCommands());
    await waitFor(() => expect(keys.result.current).toEqual([interrupt]));
    expect(commands.result.current).toEqual([forkIn]);
    // The two hooks are two views of ONE /api/config call — never a second channel.
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("a bridge that sends no keys.toml rows leaves the list empty", async () => {
    asked.mockResolvedValue(config());
    const keys = renderHook(() => useOperatorKeys());
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(keys.result.current).toEqual([]);
  });
});

describe("the Quick-dock groups ride the same one read", () => {
  it("one fetch answers the dock too", async () => {
    const shipIt = { title: "Ship it", items: ["approve", "go ahead"] };
    asked.mockResolvedValue({ ...config([forkIn]), operatorQuickReplies: [shipIt] });

    const dock = renderHook(() => useOperatorQuickReplies());
    await waitFor(() => expect(dock.result.current).toEqual([shipIt]));
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("a bridge that sends no quick-replies.toml rows leaves the list empty", async () => {
    asked.mockResolvedValue(config());
    const dock = renderHook(() => useOperatorQuickReplies());
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(dock.result.current).toEqual([]);
  });
});

describe("the launcher rows ride the same single fetch", () => {
  it("one fetch answers commands, keys and launchers", async () => {
    const interrupt = { label: "Interrupt", keys: ["ctrl+c"], danger: false };
    const peek = { command: "rumen-peek", label: "Runs & quota", cwd: "/home" };
    asked.mockResolvedValue({
      ...config([forkIn], { operatorKeys: [interrupt], launchers: [peek] }),
    });

    const keys = renderHook(() => useOperatorKeys());
    const commands = renderHook(() => useOperatorCommands());
    const launchers = renderHook(() => useLaunchers());
    await waitFor(() => expect(launchers.result.current).toEqual([peek]));
    expect(commands.result.current).toEqual([forkIn]);
    expect(keys.result.current).toEqual([interrupt]);
    // Three hooks, still one /api/config call — a second store would mean a second GET
    // racing over which response wins.
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("a bridge without launchers yields an empty list", async () => {
    asked.mockResolvedValue(config());
    const launchers = renderHook(() => useLaunchers());
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(launchers.result.current).toEqual([]);
    expect(getLaunchers()).toEqual([]);
  });
});
