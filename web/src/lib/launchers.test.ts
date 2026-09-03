import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Spied at the api seam, not over the network — the invariant under test is WHICH scope was asked
// for and HOW OFTEN, and a mock records both synchronously.
vi.mock("@/lib/api", () => ({ fetchLaunchers: vi.fn() }));

import { fetchLaunchers } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import type { Launcher } from "@/lib/types";
import { useLaunchers } from "./launchers";

const asked = vi.mocked(fetchLaunchers);

const peek: Launcher = { command: "rumen-peek", label: "Runs & quota", cwd: "/home/op/project" };

describe("useLaunchers", () => {
  it("fetches on mount and returns the rows plus home", async () => {
    asked.mockClear();
    asked.mockResolvedValue({ launchers: [peek], home: "/home/op" });
    const { result } = renderHook(() => useLaunchers());
    await waitFor(() => expect(result.current.launchers).toEqual([peek]));
    expect(result.current.home).toBe("/home/op");
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when the scope's host changes", async () => {
    asked.mockClear();
    asked.mockResolvedValue({ launchers: [], home: "" });
    const { rerender } = renderHook(({ scope }: { scope: Scope | undefined }) => useLaunchers(scope), {
      initialProps: { scope: { host: "laptop" } },
    });
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(asked).toHaveBeenLastCalledWith({ host: "laptop", session: undefined });

    rerender({ scope: { host: "desk" } });
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(2));
    expect(asked).toHaveBeenLastCalledWith({ host: "desk", session: undefined });
  });

  it("does not re-fetch when the scope is the same shape on every render", async () => {
    asked.mockClear();
    asked.mockResolvedValue({ launchers: [], home: "" });
    const { rerender } = renderHook(() => useLaunchers({ host: "laptop" }));
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 5; i++) rerender();
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("a failed fetch leaves the rows empty rather than throwing", async () => {
    asked.mockClear();
    asked.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useLaunchers());
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(result.current).toEqual({ launchers: [], home: "" });
  });
});
