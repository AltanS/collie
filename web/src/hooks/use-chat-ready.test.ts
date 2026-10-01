import { act, renderHook } from "@testing-library/react";

import { CHAT_HOLD_MS, useChatReady } from "./use-chat-ready";

// The swap from the terminal to Chat waits for Chat's first answer, so the turns are there when the
// body changes instead of popping in after it.

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

  it("gives up waiting after the hold, so a failed read does not strand the terminal", () => {
    const { result, rerender } = renderHook((p: Props) => useChatReady(p.wanted, p.answered), {
      initialProps: { wanted: false, answered: false },
    });
    rerender({ wanted: true, answered: false });
    act(() => {
      vi.advanceTimersByTime(CHAT_HOLD_MS - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
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
