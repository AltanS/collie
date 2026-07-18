import { act, renderHook } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { useLongPress } from "./use-long-press";

// The pointer-based long-press behind the pane-pill actions sheet. Fake timers pin the 450ms hold;
// the handlers are called directly with minimal synthetic events (only the fields the hook reads).
const DELAY = 450;

function down(x = 0, y = 0, button = 0): ReactPointerEvent {
  return { button, clientX: x, clientY: y } as unknown as ReactPointerEvent;
}
function clickEvent(): ReactMouseEvent {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as ReactMouseEvent;
}

describe("useLongPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires onLongPress once after the delay while held", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not fire before the delay elapses", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY - 1));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels on pointerup before the delay (a normal tap)", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY - 100));
    act(() => result.current.onPointerUp());
    act(() => vi.advanceTimersByTime(200));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels when the pointer moves past the tolerance (a scroll/drag)", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down(0, 0)));
    act(() => result.current.onPointerMove(down(0, 20))); // 20px > 10px tolerance
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("keeps the timer through small jitter within the tolerance", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down(0, 0)));
    act(() => result.current.onPointerMove(down(3, 4))); // within 10px
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("ignores a non-primary pointer button", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down(0, 0, 2))); // right-click
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("suppresses the click that follows a fired long-press, but only once", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY));

    const first = clickEvent();
    act(() => result.current.onClickCapture(first));
    expect(first.preventDefault).toHaveBeenCalled();
    expect(first.stopPropagation).toHaveBeenCalled();

    // The flag is one-shot — a later click (no new long-press) navigates normally.
    const second = clickEvent();
    act(() => result.current.onClickCapture(second));
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it("does not suppress the click after a normal tap (no long-press fired)", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY - 1));
    act(() => result.current.onPointerUp());
    const click = clickEvent();
    act(() => result.current.onClickCapture(click));
    expect(click.preventDefault).not.toHaveBeenCalled();
  });

  it("is inert when onLongPress is undefined (disabled)", () => {
    const { result } = renderHook(() => useLongPress(undefined));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY));
    const click = clickEvent();
    act(() => result.current.onClickCapture(click));
    expect(click.preventDefault).not.toHaveBeenCalled();
  });
});
