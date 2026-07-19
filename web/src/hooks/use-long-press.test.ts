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
// A `contextmenu` event — what Android Chrome raises at the end of a long-press, and desktop on
// right-click. The hook preventDefaults it and (idempotently) uses it as an alternative trigger.
function contextMenuEvent(): ReactMouseEvent {
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
    act(() => result.current.onPointerMove(down(0, 24))); // 24px > 16px tolerance
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("keeps the timer through thumb jitter within the tolerance", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down(0, 0)));
    act(() => result.current.onPointerMove(down(10, 12))); // within 16px — a held thumb wobbles
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("still cancels on pointercancel (a scroll intent the browser claimed)", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY - 100));
    act(() => result.current.onPointerCancel());
    act(() => vi.advanceTimersByTime(200));
    expect(onLongPress).not.toHaveBeenCalled();
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

  // Android long-press / desktop right-click reach us as a `contextmenu` event, not (or not only) the
  // hold timer. These cover that trigger and its idempotency against the timer.
  it("opens via contextmenu and prevents the native menu (Android long-press / right-click)", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    const e = contextMenuEvent();
    act(() => result.current.onContextMenu(e));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("opens via contextmenu even when a pointercancel already killed the hold timer", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => result.current.onPointerCancel()); // native gesture cancels our timer first…
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onLongPress).not.toHaveBeenCalled();
    const e = contextMenuEvent();
    act(() => result.current.onContextMenu(e)); // …contextmenu is the fallback that still opens it
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("does not double-open when the hold timer already fired before contextmenu", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY)); // timer opens it once
    const e = contextMenuEvent();
    act(() => result.current.onContextMenu(e));
    expect(e.preventDefault).toHaveBeenCalled(); // still suppress the native menu
    expect(onLongPress).toHaveBeenCalledTimes(1); // but never a second open
  });

  it("disarms the pending hold timer when contextmenu opens the sheet first", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY - 100));
    const e = contextMenuEvent();
    act(() => result.current.onContextMenu(e)); // opens early
    expect(onLongPress).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(200)); // the still-pending timer must not re-open
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("re-opens on a second contextmenu after a fresh pointerdown resets the gesture", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));
    // First open via contextmenu (no click follows, so the one-shot flag stays set)…
    act(() => result.current.onContextMenu(contextMenuEvent()));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // …a new gesture's pointerdown (even a non-primary button, as a right-click sends) clears it, so
    // the next contextmenu opens again instead of being swallowed.
    act(() => result.current.onPointerDown(down(0, 0, 2)));
    act(() => result.current.onContextMenu(contextMenuEvent()));
    expect(onLongPress).toHaveBeenCalledTimes(2);
  });

  it("leaves the native contextmenu alone when disabled (onLongPress undefined)", () => {
    const { result } = renderHook(() => useLongPress(undefined));
    const e = contextMenuEvent();
    act(() => result.current.onContextMenu(e));
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
