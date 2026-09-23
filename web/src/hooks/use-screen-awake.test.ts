import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useScreenAwake } from "./use-screen-awake";

/** A fake `navigator.wakeLock`: every request is a sentinel the test can release like the browser does. */
function fakeWakeLock() {
  const sentinels: { released: boolean; release: () => Promise<void>; fire: () => void }[] = [];
  const request = vi.fn(async () => {
    const listeners: (() => void)[] = [];
    const sentinel = {
      released: false,
      release: async () => {
        sentinel.released = true;
        for (const listener of listeners) listener();
      },
      fire: () => {
        sentinel.released = true;
        for (const listener of listeners) listener();
      },
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    };
    sentinels.push(sentinel);
    return sentinel;
  });
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
  return { request, sentinels };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "wakeLock");
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("useScreenAwake (ADR 0064)", () => {
  it("takes the lock while active and lets go when it is not", async () => {
    const { request, sentinels } = fakeWakeLock();
    const { rerender } = renderHook(({ on }) => useScreenAwake(on), { initialProps: { on: true } });
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    expect(sentinels[0]?.released).toBe(true);
  });

  it("asks nothing while inactive", async () => {
    const { request } = fakeWakeLock();
    renderHook(() => useScreenAwake(false));
    await act(async () => {});
    expect(request).not.toHaveBeenCalled();
  });

  it("takes the lock again when the page comes back, because the browser dropped it on the way out", async () => {
    const { request, sentinels } = fakeWakeLock();
    renderHook(() => useScreenAwake(true));
    await act(async () => {});
    await act(async () => {
      sentinels[0]?.fire();
      setVisibility("hidden");
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility("visible"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does nothing where the browser has no wake lock", () => {
    expect(() => renderHook(() => useScreenAwake(true))).not.toThrow();
  });
});
