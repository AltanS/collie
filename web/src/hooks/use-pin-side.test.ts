import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { coercePinSide, usePinSide } from "./use-pin-side";

const KEY = "collie:pin-side:v1";

// jsdom here ships no localStorage (the committed dash-prefs suite fails the same way), so the
// hook's guarded touches get a memory store. Hermetic either way: no case can leak into another
// file's store, real or stubbed.
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = { ...initial };
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    getItem: (key: string) => store[key] ?? null,
    key: (index: number) => Object.keys(store)[index] ?? null,
    removeItem: (key: string) => {
      delete store[key];
    },
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coercePinSide", () => {
  it("defaults everything but an explicit right", () => {
    expect(coercePinSide(undefined)).toBe("left");
    expect(coercePinSide({})).toBe("left");
    expect(coercePinSide({ side: "up" })).toBe("left");
    expect(coercePinSide({ side: "right" })).toBe("right");
  });
});

describe("usePinSide", () => {
  it("starts left with an empty store", () => {
    const { result } = renderHook(() => usePinSide());
    expect(result.current.side).toBe("left");
  });

  it("reads a stored right and persists a flip back", () => {
    // SAFETY: stubbed to the memory store in the beforeEach above; the cast only recovers the
    // static type the stub erases.
    const store = globalThis.localStorage as Storage;
    store.setItem(KEY, JSON.stringify({ side: "right" }));
    const { result } = renderHook(() => usePinSide());
    expect(result.current.side).toBe("right");

    act(() => result.current.setSide("left"));
    expect(result.current.side).toBe("left");
    expect(store.getItem(KEY)).toBe(JSON.stringify({ side: "left" }));
  });
});
