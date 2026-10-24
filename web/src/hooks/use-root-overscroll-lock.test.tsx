import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useRootOverscrollLock } from "./use-root-overscroll-lock";

const root = () => document.documentElement.style;

afterEach(() => {
  root().overscrollBehaviorX = "";
});

describe("useRootOverscrollLock", () => {
  it("locks the root while mounted and restores the page's own value after", () => {
    root().overscrollBehaviorX = "auto";
    const { unmount } = renderHook(() => useRootOverscrollLock(true));
    expect(root().overscrollBehaviorX).toBe("none");
    unmount();
    expect(root().overscrollBehaviorX).toBe("auto");
  });

  it("restores an empty value when the page had none", () => {
    const { unmount } = renderHook(() => useRootOverscrollLock(true));
    expect(root().overscrollBehaviorX).toBe("none");
    unmount();
    expect(root().overscrollBehaviorX).toBe("");
  });

  it("does nothing while inactive and follows the flag", () => {
    root().overscrollBehaviorX = "contain";
    const { rerender } = renderHook(({ active }) => useRootOverscrollLock(active), { initialProps: { active: false } });
    expect(root().overscrollBehaviorX).toBe("contain");
    rerender({ active: true });
    expect(root().overscrollBehaviorX).toBe("none");
    rerender({ active: false });
    expect(root().overscrollBehaviorX).toBe("contain");
  });

  it("holds the lock until the last of two users leaves", () => {
    root().overscrollBehaviorX = "auto";
    const first = renderHook(() => useRootOverscrollLock(true));
    const second = renderHook(() => useRootOverscrollLock(true));
    expect(root().overscrollBehaviorX).toBe("none");
    first.unmount();
    expect(root().overscrollBehaviorX).toBe("none");
    second.unmount();
    expect(root().overscrollBehaviorX).toBe("auto");
  });

  it("restores the original value, not none, when the users leave in the other order", () => {
    root().overscrollBehaviorX = "auto";
    const first = renderHook(() => useRootOverscrollLock(true));
    const second = renderHook(() => useRootOverscrollLock(true));
    second.unmount();
    expect(root().overscrollBehaviorX).toBe("none");
    first.unmount();
    expect(root().overscrollBehaviorX).toBe("auto");
  });
});
