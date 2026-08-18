import { act, renderHook } from "@testing-library/react";

import { useLoadingStalled } from "./use-loading-stalled";

// Drive useRevalidator/useNavigation directly (hoisted so the vi.mock factory can close over the
// holder), so we can pin each into "loading"/"idle" without a real router.
interface RouterStates {
  rev: "idle" | "loading";
  nav: "idle" | "loading" | "submitting";
}
const h = vi.hoisted((): RouterStates => ({ rev: "idle", nav: "idle" }));
vi.mock("react-router", () => ({
  useRevalidator: () => ({ state: h.rev }),
  useNavigation: () => ({ state: h.nav }),
}));

const THRESHOLD = 2_500;

describe("useLoadingStalled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.rev = "idle";
    h.nav = "idle";
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays false while idle", () => {
    const { result } = renderHook(() => useLoadingStalled(THRESHOLD));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(THRESHOLD * 2));
    expect(result.current).toBe(false);
  });

  it("flips true only after the threshold while a revalidation stays loading", () => {
    h.rev = "loading";
    const { result } = renderHook(() => useLoadingStalled(THRESHOLD));
    expect(result.current).toBe(false); // not yet — a slow poll shouldn't trip it
    act(() => vi.advanceTimersByTime(THRESHOLD - 1));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it("also trips on a navigation-only stall (revalidator idle)", () => {
    // A pane-open tap is a router navigation that waits on the loader — this is the case that used
    // to look completely dead when black-holed.
    h.nav = "loading";
    const { result } = renderHook(() => useLoadingStalled(THRESHOLD));
    act(() => vi.advanceTimersByTime(THRESHOLD));
    expect(result.current).toBe(true);
  });

  it("resets to false once everything goes idle again", () => {
    h.rev = "loading";
    const { result, rerender } = renderHook(() => useLoadingStalled(THRESHOLD));
    act(() => vi.advanceTimersByTime(THRESHOLD));
    expect(result.current).toBe(true);

    h.rev = "idle";
    act(() => rerender());
    expect(result.current).toBe(false);
  });

  it("does not trip if the load settles before the threshold", () => {
    h.rev = "loading";
    const { result, rerender } = renderHook(() => useLoadingStalled(THRESHOLD));
    act(() => vi.advanceTimersByTime(THRESHOLD - 500));
    h.rev = "idle"; // settled in time
    act(() => rerender());
    act(() => vi.advanceTimersByTime(1_000)); // past where the original timer would have fired
    expect(result.current).toBe(false);
  });
});
