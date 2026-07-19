import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import {
  __resetReloadGuard,
  holdReload,
  isReloadHeld,
  releaseReload,
  useHoldReload,
} from "./reload-guard";

afterEach(() => __resetReloadGuard());

describe("hold registry", () => {
  it("is held while any key is held; hold/release are idempotent per key", () => {
    expect(isReloadHeld()).toBe(false);
    holdReload("a");
    holdReload("a"); // idempotent — still one holder
    expect(isReloadHeld()).toBe(true);

    holdReload("b");
    releaseReload("a");
    expect(isReloadHeld()).toBe(true); // b still holds

    releaseReload("b");
    expect(isReloadHeld()).toBe(false);
    releaseReload("b"); // releasing an unheld key is a harmless no-op
    expect(isReloadHeld()).toBe(false);
  });
});

describe("useHoldReload", () => {
  it("holds while active, releases when inactive and on unmount", () => {
    const { rerender, unmount } = renderHook(({ active }) => useHoldReload("x", active), {
      initialProps: { active: false },
    });
    expect(isReloadHeld()).toBe(false);

    act(() => rerender({ active: true }));
    expect(isReloadHeld()).toBe(true);

    act(() => rerender({ active: false }));
    expect(isReloadHeld()).toBe(false);

    act(() => rerender({ active: true }));
    expect(isReloadHeld()).toBe(true);
    act(() => unmount()); // unmount must release even while still active
    expect(isReloadHeld()).toBe(false);
  });
});
