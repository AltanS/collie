import { act, render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { Collapse, COLLAPSE_MS } from "./collapse";

/** jsdom reports `prefers-reduced-motion` as "no preference"; this makes it say the opposite. */
function preferReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Collapse — animated presence for anything in flow", () => {
  it("keeps its child mounted through the exit, and unmounts AFTER it", () => {
    // The delayed unmount is the whole reason this is a component and not a class string. Remove
    // the child when `open` goes false and there is nothing left to animate out — the notice
    // vanishes and the content below teleports, which is the fault the collapse exists to fix.
    vi.useFakeTimers();
    const { rerender } = render(
      <Collapse open>
        <p>You are read-only.</p>
      </Collapse>,
    );
    expect(screen.getByText("You are read-only.")).toBeInTheDocument();

    rerender(
      <Collapse open={false}>
        <p>You are read-only.</p>
      </Collapse>,
    );
    act(() => {
      vi.advanceTimersByTime(COLLAPSE_MS - 1);
    });
    // Still there, one millisecond before the end: the row is mid-slide.
    expect(screen.getByText("You are read-only.")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByText("You are read-only.")).toBeNull();
  });

  it("heads for the closed end as soon as it is asked to, long before it unmounts", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Collapse open>
        <p>copy</p>
      </Collapse>,
    );
    expect(container.firstElementChild).toHaveAttribute("data-state", "open");
    rerender(
      <Collapse open={false}>
        <p>copy</p>
      </Collapse>,
    );
    expect(container.firstElementChild).toHaveAttribute("data-state", "closed");
    expect(container.firstElementChild).toHaveClass("grid-rows-[0fr]", "opacity-0");
  });

  it("does not animate a notice that was already true at first paint", () => {
    // ReadOnly and HostStale are usually known at loader time, so the notice is part of the FIRST
    // frame. There is no shift to smooth over there, and animating it would manufacture one.
    const { container } = render(
      <Collapse open>
        <p>copy</p>
      </Collapse>,
    );
    expect(container.firstElementChild).toHaveClass("grid-rows-[1fr]", "opacity-100");
  });

  it("snaps under prefers-reduced-motion instead of waiting out the duration", () => {
    // Two halves, and both matter. The CSS half (`motion-reduce:transition-none`) stops the paint
    // from moving; the JS half stops the child from loitering in the tree for 240ms after it has
    // already gone invisible, where a screen reader can still walk it.
    preferReducedMotion(true);
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Collapse open>
        <p>copy</p>
      </Collapse>,
    );
    expect(container.firstElementChild).toHaveClass("motion-reduce:transition-none");

    rerender(
      <Collapse open={false}>
        <p>copy</p>
      </Collapse>,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.queryByText("copy")).toBeNull();
  });

  it("spends the same number in CSS and in JavaScript", () => {
    // THE COUPLING. The transition's duration and the unmount timer are one number in two places
    // and nothing links them but this test: set the timer short and the child vanishes mid-slide,
    // set it long and the row sits at zero height doing nothing for the difference. Change the
    // utility or the constant alone and this fails.
    const { container } = render(
      <Collapse open>
        <p>copy</p>
      </Collapse>,
    );
    const duration = /duration-\[(\d+)ms\]/.exec(container.firstElementChild?.className ?? "");
    expect(duration).not.toBeNull();
    expect(Number(duration?.[1])).toBe(COLLAPSE_MS);
  });

  it("clips while it is short and stops clipping once it is open", () => {
    // The clip is required for `grid-rows-[0fr]` to hide anything, and it is actively harmful once
    // there is nothing left to hide: an `overflow: hidden` ancestor eats a child's ::before tap
    // extension, taps and all, with nothing to see. A strip is 33px and its action button's 44px
    // target reaches 11px past the band on both sides, so every pixel of that target lives outside
    // this box. Dropping the clip when it has no work to do is what keeps the tap floor.
    vi.useFakeTimers();
    const { container, rerender } = render(
      <Collapse open={false}>
        <p>copy</p>
      </Collapse>,
    );
    rerender(
      <Collapse open>
        <p>copy</p>
      </Collapse>,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(container.firstElementChild).toHaveClass("overflow-hidden");

    act(() => {
      vi.advanceTimersByTime(COLLAPSE_MS + 16);
    });
    expect(container.firstElementChild).toHaveClass("overflow-visible");
    expect(container.querySelector(".min-h-0")).toHaveClass("overflow-visible");
  });

  it("styles nothing about its child", () => {
    // It owns presence and geometry. Tone, padding, borders and text belong to the Notice inside,
    // so the same wrapper can carry a full-bleed strip and an inset box without knowing which.
    const { container } = render(
      <Collapse open>
        <p data-testid="child">copy</p>
      </Collapse>,
    );
    expect(screen.getByTestId("child")).not.toHaveAttribute("class");
    expect(container.firstElementChild?.className).not.toMatch(/bg-|text-|border-|px-|py-/);
  });
});
