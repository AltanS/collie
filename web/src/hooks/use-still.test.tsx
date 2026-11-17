import { useState } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STILL_MS, STILL_TICK_MS, useStill } from "@/hooks/use-still";

// A card yes waits for the card to stand still for a second: from the draw, and again after a shift.

let top = 100;
beforeEach(() => {
  vi.useFakeTimers();
  top = 100;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, top, 300, 80));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe({ keyed = "a" }: { keyed?: string }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const still = useStill(el, keyed);
  return (
    <div ref={setEl} data-still={String(still)}>
      probe
    </div>
  );
}

const state = (c: HTMLElement) => c.firstElementChild!.getAttribute("data-still");
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("useStill", () => {
  it("is not still at the draw, and is after a second with no move", () => {
    const { container } = render(<Probe />);
    expect(state(container)).toBe("false");
    wait(STILL_MS - STILL_TICK_MS * 2);
    expect(state(container)).toBe("false");
    wait(STILL_TICK_MS * 3);
    expect(state(container)).toBe("true");
  });

  it("a card that shifts is not still again until a whole second after the shift", () => {
    const { container } = render(<Probe />);
    wait(STILL_MS + STILL_TICK_MS);
    expect(state(container)).toBe("true");
    top = 140;
    wait(STILL_TICK_MS);
    expect(state(container)).toBe("false");
    wait(STILL_MS - STILL_TICK_MS * 2);
    expect(state(container)).toBe("false");
    wait(STILL_TICK_MS * 3);
    expect(state(container)).toBe("true");
  });

  it("another key (another card of a group) waits again, and no element is never still", () => {
    const { container, rerender } = render(<Probe keyed="a" />);
    wait(STILL_MS + STILL_TICK_MS);
    expect(state(container)).toBe("true");
    rerender(<Probe keyed="b" />);
    expect(state(container)).toBe("false");
  });
});
