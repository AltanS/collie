import { renderHook, act } from "@testing-library/react";

import { clearStatus, setStatus, useStatus } from "./status";

// The global status channel: latest-wins, errors persist, everything else auto-clears on a TTL.
// We observe it through useStatus (the public read) and drive the TTL with fake timers.
describe("status channel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the latest message to subscribers", () => {
    const { result } = renderHook(() => useStatus());
    act(() => setStatus("hello", "info"));
    expect(result.current?.text).toBe("hello");
    expect(result.current?.tone).toBe("info");
  });

  it("auto-clears a non-error after 2500ms", () => {
    const { result } = renderHook(() => useStatus());
    act(() => setStatus("done", "success"));
    expect(result.current?.text).toBe("done");
    act(() => vi.advanceTimersByTime(2500));
    expect(result.current).toBeNull();
  });

  it("keeps an error until it is explicitly dismissed", () => {
    const { result } = renderHook(() => useStatus());
    act(() => setStatus("boom", "error"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current?.text).toBe("boom");
    act(() => clearStatus());
    expect(result.current).toBeNull();
  });

  it("latest message wins and resets the auto-clear timer", () => {
    const { result } = renderHook(() => useStatus());
    act(() => setStatus("first", "info"));
    act(() => vi.advanceTimersByTime(2000));
    act(() => setStatus("second", "info"));
    act(() => vi.advanceTimersByTime(2000)); // 4s since "first" but only 2s since "second"
    expect(result.current?.text).toBe("second");
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBeNull();
  });

  it("honours an explicit ttl of null (persist)", () => {
    const { result } = renderHook(() => useStatus());
    act(() => setStatus("sticky", "info", null));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current?.text).toBe("sticky");
  });
});
