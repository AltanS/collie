import { act, renderHook } from "@testing-library/react";

import { CONNECTION_LOST_MS, useConnectionLost } from "./use-connection-lost";

// Wall-clock derived, so fake timers (which also advance Date.now in Vitest) drive both the countdown
// and the elapsed-time comparison the hook reads.
describe("useConnectionLost", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays false while the connection is healthy", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: false },
    });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS * 2));
    expect(result.current).toBe(false);
  });

  it("flips true only after the threshold of continuous disconnection", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: true },
    });
    expect(result.current).toBe(false); // a slow moment isn't yet an outage
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("does not trip on a brief blip that recovers before the threshold", () => {
    const { result, rerender } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: true },
    });
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS - 3_000));
    rerender({ c: false }); // recovered in time
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(result.current).toBe(false);
  });

  it("resets to false the moment the connection recovers", () => {
    const { result, rerender } = renderHook(({ c }) => useConnectionLost(c), {
      initialProps: { c: true },
    });
    act(() => vi.advanceTimersByTime(CONNECTION_LOST_MS));
    expect(result.current).toBe(true);
    rerender({ c: false });
    expect(result.current).toBe(false);
  });

  it("honours a custom threshold", () => {
    const { result } = renderHook(({ c }) => useConnectionLost(c, 5_000), {
      initialProps: { c: true },
    });
    act(() => vi.advanceTimersByTime(4_999));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });
});
