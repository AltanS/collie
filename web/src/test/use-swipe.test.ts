import { describe, expect, it } from "vitest";

import { isSwipeUp } from "@/hooks/use-swipe";

describe("isSwipeUp", () => {
  it("fires on a clear upward fling past the threshold", () => {
    expect(isSwipeUp(0, -60)).toBe(true);
    expect(isSwipeUp(5, -50)).toBe(true);
  });

  it("ignores short movements (taps / jitter)", () => {
    expect(isSwipeUp(0, -10)).toBe(false);
    expect(isSwipeUp(0, 0)).toBe(false);
  });

  it("ignores downward swipes", () => {
    expect(isSwipeUp(0, 60)).toBe(false);
  });

  it("ignores mostly-horizontal swipes", () => {
    expect(isSwipeUp(80, -50)).toBe(false);
  });

  it("respects a custom threshold", () => {
    expect(isSwipeUp(0, -40, 80)).toBe(false);
    expect(isSwipeUp(0, -90, 80)).toBe(true);
  });
});
