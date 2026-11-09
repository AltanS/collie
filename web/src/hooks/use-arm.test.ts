import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";

import { useArm, type ArmTap } from "./use-arm";

// Arm, then act: the first tap arms, a tap inside the dwell is the same touch, the second tap after
// it fires, and the arm lapses by itself after ARM_MS. One key is armed at a time.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function tapOf(result: { current: ReturnType<typeof useArm<string>> }, key: string): ArmTap {
  let got: ArmTap = "armed";
  act(() => {
    got = result.current.tap(key);
  });
  return got;
}

describe("useArm", () => {
  it("arms on the first tap and fires on a second one after the dwell", () => {
    const { result } = renderHook(() => useArm<string>());
    expect(tapOf(result, "stop")).toBe("armed");
    expect(result.current.armed).toBe("stop");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    expect(tapOf(result, "stop")).toBe("fire");
    expect(result.current.armed).toBeNull();
  });

  it("treats a tap inside the dwell as the same touch", () => {
    const { result } = renderHook(() => useArm<string>());
    tapOf(result, "stop");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS - 50));
    expect(tapOf(result, "stop")).toBe("dwell");
    expect(result.current.armed).toBe("stop");
  });

  it("lapses after ARM_MS, so the next tap arms again", () => {
    const { result } = renderHook(() => useArm<string>());
    tapOf(result, "stop");
    act(() => vi.advanceTimersByTime(ARM_MS));
    expect(result.current.armed).toBeNull();
    expect(tapOf(result, "stop")).toBe("armed");
  });

  it("moves the arm to another key instead of firing", () => {
    const { result } = renderHook(() => useArm<string>());
    tapOf(result, "a");
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    expect(tapOf(result, "b")).toBe("armed");
    expect(result.current.armed).toBe("b");
  });

  it("drops the arm on disarm", () => {
    const { result } = renderHook(() => useArm<string>());
    tapOf(result, "a");
    act(() => result.current.disarm());
    expect(result.current.armed).toBeNull();
  });
});
