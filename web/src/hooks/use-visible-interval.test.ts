import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACTIVITY_IDLE_MS, CHANGES_POLL_MS, useVisibleInterval } from "./use-visible-interval";

/** A touch event carrying `fingers` touches, the one field the hook reads. */
function touch(type: "touchstart" | "touchend", fingers: number) {
  const e = new Event(type);
  Object.defineProperty(e, "touches", { value: { length: fingers } });
  document.dispatchEvent(e);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  // Let any hold from the case before run out, so the next case starts idle.
  vi.advanceTimersByTime(ACTIVITY_IDLE_MS);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useVisibleInterval", () => {
  it("beats every interval while nobody touches the screen", () => {
    const tick = vi.fn();
    renderHook(() => useVisibleInterval(tick, CHANGES_POLL_MS));
    vi.advanceTimersByTime(CHANGES_POLL_MS * 3);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("holds a beat while the list scrolls, and fires it a second after the last scroll", () => {
    const tick = vi.fn();
    renderHook(() => useVisibleInterval(tick, CHANGES_POLL_MS));
    vi.advanceTimersByTime(CHANGES_POLL_MS - 500);
    // Scroll events do not bubble; the hook listens in the capture phase, so one on any box counts.
    const list = document.body.appendChild(document.createElement("div"));
    for (let t = 0; t < 2000; t += 200) {
      list.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(200);
    }
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ACTIVITY_IDLE_MS);
    expect(tick).toHaveBeenCalledTimes(1);
    list.remove();
  });

  it("holds a beat for as long as a finger rests on the screen", () => {
    const tick = vi.fn();
    renderHook(() => useVisibleInterval(tick, CHANGES_POLL_MS));
    touch("touchstart", 1);
    vi.advanceTimersByTime(CHANGES_POLL_MS * 3);
    expect(tick).not.toHaveBeenCalled();
    touch("touchend", 0);
    vi.advanceTimersByTime(ACTIVITY_IDLE_MS);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stops outright on unmount, a held beat included", () => {
    const tick = vi.fn();
    const { unmount } = renderHook(() => useVisibleInterval(tick, CHANGES_POLL_MS));
    touch("touchstart", 1);
    vi.advanceTimersByTime(CHANGES_POLL_MS);
    unmount();
    touch("touchend", 0);
    vi.advanceTimersByTime(CHANGES_POLL_MS * 2);
    expect(tick).not.toHaveBeenCalled();
  });
});
