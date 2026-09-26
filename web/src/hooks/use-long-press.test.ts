import { act, renderHook } from "@testing-library/react";
import { stubPart } from "@/test/stub";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { __resetHaptics } from "@/lib/haptics";
import { HOLD_FEEDBACK_DELAY_MS, useLongPress } from "./use-long-press";

// The pointer-based long-press behind the pane-pill actions sheet. Fake timers pin the 450ms hold;
// the handlers are called directly with minimal synthetic events (only the fields the hook reads).
const DELAY = 450;

function down(x = 0, y = 0, button = 0): ReactPointerEvent {
  return stubPart<ReactPointerEvent>({ button, clientX: x, clientY: y });
}
function pointerEndEvent(): ReactPointerEvent {
  return stubPart<ReactPointerEvent>({ preventDefault: vi.fn() });
}
function clickEvent(): ReactMouseEvent {
  return stubPart<ReactMouseEvent>({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
}
// A `contextmenu` event — what Android Chrome raises at the end of a long-press, and desktop on
// right-click. The hook preventDefaults it and (idempotently) uses it as an alternative trigger.
function contextMenuEvent(): ReactMouseEvent {
  return stubPart<ReactMouseEvent>({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
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

  it("runs the completion callback from pointerup's trusted gesture after a fired hold", () => {
    const onLongPress = vi.fn();
    const onReleaseAfterLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { onReleaseAfterLongPress }),
    );
    act(() => result.current.onPointerDown(down()));
    act(() => vi.advanceTimersByTime(DELAY));
    expect(onReleaseAfterLongPress).not.toHaveBeenCalled();

    const up = pointerEndEvent();
    act(() => result.current.onPointerUp(up));
    expect(up.preventDefault).toHaveBeenCalled();
    expect(onReleaseAfterLongPress).toHaveBeenCalledTimes(1);

    act(() => result.current.onClickCapture(clickEvent()));
    expect(onReleaseAfterLongPress).toHaveBeenCalledTimes(1);
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
  it("opens and completes via contextmenu (Android long-press / right-click)", () => {
    const onLongPress = vi.fn();
    const onReleaseAfterLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { onReleaseAfterLongPress }),
    );
    const e = contextMenuEvent();
    act(() => result.current.onContextMenu(e));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onReleaseAfterLongPress).toHaveBeenCalledTimes(1);
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

  // THE HOLD, SHOWN (M38/02): the returned props carry `data-holding` (and the fill's duration) from a
  // short delay after the press until the hold fires or is cancelled, so every surface that spreads
  // them gets the look. A plain tap lifts before the delay and changes no style at all.
  describe("the holding state", () => {
    const holding = (props: ReturnType<typeof useLongPress>) => props["data-holding"];

    it("starts at rest: no attribute and no style", () => {
      const { result } = renderHook(() => useLongPress(vi.fn()));
      expect(holding(result.current)).toBeUndefined();
      expect(result.current.style).toBeUndefined();
    });

    it("changes no style on a tap shorter than the feedback delay", () => {
      const { result } = renderHook(() => useLongPress(vi.fn()));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(HOLD_FEEDBACK_DELAY_MS - 1));
      expect(holding(result.current)).toBeUndefined();
      expect(result.current.style).toBeUndefined();
      act(() => result.current.onPointerUp(pointerEndEvent()));
      act(() => vi.advanceTimersByTime(DELAY));
      expect(holding(result.current)).toBeUndefined();
      expect(result.current.style).toBeUndefined();
    });

    it("holds from the feedback delay, filling over exactly the time left to the hold's mark", () => {
      const { result } = renderHook(() => useLongPress(vi.fn()));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(HOLD_FEEDBACK_DELAY_MS));
      expect(holding(result.current)).toBe("");
      expect(result.current.style).toEqual({ animationDuration: `${DELAY - HOLD_FEEDBACK_DELAY_MS}ms` });
      // Still holding up to the last millisecond before the fire.
      act(() => vi.advanceTimersByTime(DELAY - HOLD_FEEDBACK_DELAY_MS - 1));
      expect(holding(result.current)).toBe("");
    });

    it("stretches the fill over a longer hold", () => {
      const { result } = renderHook(() => useLongPress(vi.fn(), { delayMs: 600 }));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(HOLD_FEEDBACK_DELAY_MS));
      expect(result.current.style).toEqual({ animationDuration: `${600 - HOLD_FEEDBACK_DELAY_MS}ms` });
    });

    it("ends the look the moment the hold fires, with the finger still down", () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress(onLongPress));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(DELAY));
      expect(onLongPress).toHaveBeenCalledTimes(1);
      expect(holding(result.current)).toBeUndefined();
      expect(result.current.style).toBeUndefined();
    });

    it("drops the look at once when the pointer moves past the tolerance", () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress(onLongPress));
      act(() => result.current.onPointerDown(down(0, 0)));
      act(() => vi.advanceTimersByTime(HOLD_FEEDBACK_DELAY_MS + 50));
      act(() => result.current.onPointerMove(down(0, 10))); // thumb jitter keeps it
      expect(holding(result.current)).toBe("");
      act(() => result.current.onPointerMove(down(0, 24))); // a scroll drops it
      expect(holding(result.current)).toBeUndefined();
      act(() => vi.advanceTimersByTime(DELAY));
      expect(onLongPress).not.toHaveBeenCalled();
    });

    it.each([
      ["pointerup", "onPointerUp"],
      ["pointerleave", "onPointerLeave"],
      ["pointercancel (a touch scroll the browser claimed)", "onPointerCancel"],
    ] as const)("drops the look at once on %s", (_label, handler) => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress(onLongPress));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(HOLD_FEEDBACK_DELAY_MS + 50));
      expect(holding(result.current)).toBe("");
      act(() => result.current[handler](pointerEndEvent()));
      expect(holding(result.current)).toBeUndefined();
      expect(result.current.style).toBeUndefined();
      act(() => vi.advanceTimersByTime(DELAY));
      expect(holding(result.current)).toBeUndefined();
      expect(onLongPress).not.toHaveBeenCalled();
    });

    it("never holds on a secondary button or when the hold is disabled", () => {
      const enabled = renderHook(() => useLongPress(vi.fn()));
      act(() => enabled.result.current.onPointerDown(down(0, 0, 2)));
      act(() => vi.advanceTimersByTime(DELAY));
      expect(holding(enabled.result.current)).toBeUndefined();

      const disabled = renderHook(() => useLongPress(undefined));
      act(() => disabled.result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(DELAY));
      expect(holding(disabled.result.current)).toBeUndefined();
    });

    it("starts over on a fresh press after a cancel", () => {
      const { result } = renderHook(() => useLongPress(vi.fn()));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(HOLD_FEEDBACK_DELAY_MS + 10));
      act(() => result.current.onPointerCancel(pointerEndEvent()));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(HOLD_FEEDBACK_DELAY_MS - 1));
      expect(holding(result.current)).toBeUndefined();
      act(() => vi.advanceTimersByTime(1));
      expect(holding(result.current)).toBe("");
    });
  });

  // One short tick when the hold counts, where the platform can buzz (lib/haptics.ts). Never on a tap.
  describe("the haptic tick", () => {
    let vibrate: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      __resetHaptics();
      vibrate = vi.fn();
      Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true, writable: true });
    });
    afterEach(() => {
      Reflect.deleteProperty(navigator, "vibrate");
    });

    it("buzzes once when the hold fires", () => {
      const { result } = renderHook(() => useLongPress(vi.fn()));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(DELAY));
      expect(vibrate).toHaveBeenCalledOnce();
      // The contextmenu that follows on Android is the same hold: no second tick.
      act(() => result.current.onContextMenu(contextMenuEvent()));
      expect(vibrate).toHaveBeenCalledOnce();
    });

    it("stays still on a tap", () => {
      const { result } = renderHook(() => useLongPress(vi.fn()));
      act(() => result.current.onPointerDown(down()));
      act(() => vi.advanceTimersByTime(DELAY - 100));
      act(() => result.current.onPointerUp(pointerEndEvent()));
      act(() => vi.advanceTimersByTime(DELAY));
      expect(vibrate).not.toHaveBeenCalled();
    });
  });
});
