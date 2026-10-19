import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useOrderedKeySender } from "./use-ordered-key-sender";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useOrderedKeySender", () => {
  it("keeps one call in flight and batches everything typed behind it", async () => {
    const first = deferred<boolean>();
    const send = vi
      .fn<(keys: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

    act(() => {
      void result.current.enqueue(["a"]);
    });
    await waitFor(() => expect(send).toHaveBeenCalledWith(["a"]));

    act(() => {
      void result.current.enqueue(["b"]);
      void result.current.enqueue(["c", "d"]);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(true);

    first.resolve(true);
    await waitFor(() => expect(send).toHaveBeenNthCalledWith(2, ["b", "c", "d"]));
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("splits a large committed string into bounded ordered requests", async () => {
    const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));
    const keys = Array.from({ length: 70 }, (_, i) => String(i % 10));

    act(() => {
      void result.current.enqueue(keys);
    });

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0][0]).toEqual(keys.slice(0, 64));
    expect(send.mock.calls[1][0]).toEqual(keys.slice(64));
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("stops and discards queued keys after a failed batch", async () => {
    const first = deferred<boolean>();
    const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockReturnValue(first.promise);
    const onFailure = vi.fn();
    const { result } = renderHook(() => useOrderedKeySender(send, onFailure));

    act(() => {
      void result.current.enqueue(["a"]);
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => {
      void result.current.enqueue(["b"]);
    });

    first.resolve(false);
    await waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("reset drops queued keys without cancelling the batch already on the wire", async () => {
    const first = deferred<boolean>();
    const send = vi
      .fn<(keys: string[]) => Promise<boolean>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(true);
    const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

    act(() => {
      void result.current.enqueue(["old"]);
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    act(() => {
      void result.current.enqueue(["discard"]);
      result.current.reset();
    });

    first.resolve(true);
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(send).toHaveBeenCalledTimes(1);
  });

  describe("the verdict enqueue answers", () => {
    it("is true once the batch that carried the keys went through", async () => {
      const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockResolvedValue(true);
      const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

      let verdict: Promise<boolean> = Promise.resolve(false);
      act(() => {
        verdict = result.current.enqueue(["a", "b"]);
      });

      await expect(verdict).resolves.toBe(true);
    });

    it("is the last batch's verdict when a large set is split", async () => {
      const send = vi
        .fn<(keys: string[]) => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));
      const keys = Array.from({ length: 70 }, (_, i) => String(i % 10));

      let verdict: Promise<boolean> = Promise.resolve(true);
      act(() => {
        verdict = result.current.enqueue(keys);
      });

      await expect(verdict).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("is false for a failed batch and for the keys that failure discarded", async () => {
      const first = deferred<boolean>();
      const send = vi.fn<(keys: string[]) => Promise<boolean>>().mockReturnValue(first.promise);
      const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

      let failed: Promise<boolean> = Promise.resolve(true);
      let discarded: Promise<boolean> = Promise.resolve(true);
      act(() => {
        failed = result.current.enqueue(["a"]);
      });
      act(() => {
        discarded = result.current.enqueue(["b"]);
      });

      first.resolve(false);
      await expect(failed).resolves.toBe(false);
      await expect(discarded).resolves.toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("is false after reset for keys still pending, and true for the batch already on the wire", async () => {
      const first = deferred<boolean>();
      const send = vi
        .fn<(keys: string[]) => Promise<boolean>>()
        .mockImplementationOnce(() => first.promise)
        .mockResolvedValue(true);
      const { result } = renderHook(() => useOrderedKeySender(send, vi.fn()));

      let onWire: Promise<boolean> = Promise.resolve(false);
      let pending: Promise<boolean> = Promise.resolve(true);
      act(() => {
        onWire = result.current.enqueue(["old"]);
      });
      act(() => {
        pending = result.current.enqueue(["discard"]);
        result.current.reset();
      });

      await expect(pending).resolves.toBe(false);
      first.resolve(true);
      await expect(onWire).resolves.toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
