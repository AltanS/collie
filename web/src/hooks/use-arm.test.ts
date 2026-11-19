import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { ARM_DWELL_MS, ARM_MS } from "@/lib/arm";

import { useArm, useDisarmOn, useOnChange, type ArmTap } from "./use-arm";

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

describe("useDisarmOn and useOnChange: drop an arm when a value changes, never on mount", () => {
  it("does not run on mount, and does not run for a re-render with the same value", () => {
    const run = vi.fn();
    const { rerender } = renderHook(({ value }) => useOnChange(value, run), { initialProps: { value: 1 } });
    expect(run).not.toHaveBeenCalled();
    rerender({ value: 1 });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once per change of the value", () => {
    const run = vi.fn();
    const { rerender } = renderHook(({ value }) => useOnChange(value, run), { initialProps: { value: 1 } });
    rerender({ value: 2 });
    expect(run).toHaveBeenCalledTimes(1);
    rerender({ value: 2 });
    expect(run).toHaveBeenCalledTimes(1);
    rerender({ value: 3 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a changed value drops the arm, and the next tap only arms again", () => {
    const { result, rerender } = renderHook(
      ({ value }) => {
        const arm = useArm<string>();
        useDisarmOn(value, arm.disarm);
        return arm;
      },
      { initialProps: { value: 1 } },
    );
    expect(tapOf(result, "undo")).toBe("armed");
    rerender({ value: 2 });
    expect(result.current.armed).toBeNull();
    act(() => vi.advanceTimersByTime(ARM_DWELL_MS));
    expect(tapOf(result, "undo")).toBe("armed");
  });

  it("a tap that arms right after mount stays armed: the mount effect has nothing to disarm", () => {
    // The tap runs in the same act as the mount, before the mount effect is flushed, the order a first tap can land in.
    const { result } = renderHook(() => {
      const arm = useArm<string>();
      useDisarmOn(1, arm.disarm);
      return arm;
    });
    expect(tapOf(result, "undo")).toBe("armed");
    expect(result.current.armed).toBe("undo");
  });
});
