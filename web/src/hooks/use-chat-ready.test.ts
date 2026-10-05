import { act, renderHook } from "@testing-library/react";

import { useChatReady } from "./use-chat-ready";

// The swap from the terminal to Chat waits for Chat's first read to come back, so the turns are there
// when the body changes instead of popping in after it. An EVENT moves it, never a clock: a read that
// failed comes back too (the caller folds it into `answered`), and the fetch has its own deadline.

interface Props {
  wanted: boolean;
  answered: boolean;
}

describe("useChatReady", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the terminal until the first answer lands", () => {
    const { result, rerender } = renderHook((p: Props) => useChatReady(p.wanted, p.answered), {
      initialProps: { wanted: false, answered: false },
    });
    rerender({ wanted: true, answered: false });
    expect(result.current).toBe(false);
    rerender({ wanted: true, answered: true });
    expect(result.current).toBe(true);
  });

  it("swaps in the same render as the choice when the answer is already in hand", () => {
    const { result, rerender } = renderHook((p: Props) => useChatReady(p.wanted, p.answered), {
      initialProps: { wanted: false, answered: true },
    });
    rerender({ wanted: true, answered: true });
    expect(result.current).toBe(true);
  });

  it("waits for the read however long it takes: no clock moves the swap", () => {
    const { result, rerender } = renderHook((p: Props) => useChatReady(p.wanted, p.answered), {
      initialProps: { wanted: false, answered: false },
    });
    rerender({ wanted: true, answered: false });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(false);
    // The read came back, with an answer or with a failure: either releases it.
    rerender({ wanted: true, answered: true });
    expect(result.current).toBe(true);
  });

  it("does not hold a pane that opens already on Chat", () => {
    const { result } = renderHook(() => useChatReady(true, false));
    expect(result.current).toBe(true);
  });

  it("stays on Chat through a pane switch that empties the window", () => {
    const { result, rerender } = renderHook((p: Props) => useChatReady(p.wanted, p.answered), {
      initialProps: { wanted: false, answered: false },
    });
    rerender({ wanted: true, answered: true });
    rerender({ wanted: true, answered: false });
    expect(result.current).toBe(true);
  });

  it("holds again on the next swap after leaving Chat", () => {
    const { result, rerender } = renderHook((p: Props) => useChatReady(p.wanted, p.answered), {
      initialProps: { wanted: true, answered: true },
    });
    rerender({ wanted: false, answered: true });
    expect(result.current).toBe(false);
    rerender({ wanted: true, answered: false });
    expect(result.current).toBe(false);
  });
});
