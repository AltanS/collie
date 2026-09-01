import { act, render, screen } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { Collapse, CollapseSwap, COLLAPSE_MS } from "./collapse";

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

  it("holds its last children through the exit, even when the caller stops rendering them", () => {
    // THE PILOT'S FINDING, now the primitive's job. Keeping the child MOUNTED is a weaker promise
    // than keeping it VISIBLE: the child is whatever the caller's render returns, so the instant the
    // condition goes false the copy that described it is gone and a mounted-but-empty box slides
    // shut on nothing — the same pop, one step quieter. The converted call site is
    // `{gate ? <Notice/> : null}`, which is exactly this: children that vanish on the closing
    // render. Before the hold, the read-only banner needed its own ref for this, and so would each
    // of the six conversions after it.
    vi.useFakeTimers();
    const { rerender } = render(
      <Collapse open>
        <p>Not paired — this device can only look.</p>
      </Collapse>,
    );
    rerender(<Collapse open={false}>{null}</Collapse>);

    act(() => {
      vi.advanceTimersByTime(COLLAPSE_MS - 1);
    });
    expect(screen.getByText("Not paired — this device can only look.")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByText("Not paired — this device can only look.")).toBeNull();
  });

  it("shows NEW children at once while it is open — the hold is for the exit only", () => {
    // The failure mode on the other side of the hold: a snapshot taken too eagerly would pin an open
    // notice to the first words it ever showed, so a host-stale box could not update its age and a
    // strip could not be re-worded. While `open` is true the caller's current children are rendered,
    // always; only a closed Collapse reads the hold.
    const { rerender } = render(
      <Collapse open>
        <p>Reconnecting…</p>
      </Collapse>,
    );
    rerender(
      <Collapse open>
        <p>No connection.</p>
      </Collapse>,
    );
    expect(screen.getByText("No connection.")).toBeInTheDocument();
    expect(screen.queryByText("Reconnecting…")).toBeNull();
  });

  it("never holds an empty child: a false condition cannot poison the next exit", () => {
    // "Empty" is what React renders as nothing — null, undefined, true, false, an empty array — i.e.
    // precisely what a conditional child produces. Holding one would pin the box empty for every
    // LATER exit, which is the fault the hold exists to fix, arriving by the back door.
    vi.useFakeTimers();
    const { rerender } = render(
      <Collapse open>
        <p>You are read-only.</p>
      </Collapse>,
    );
    // Still open, but the caller has nothing to say for a render: this must not be captured.
    rerender(<Collapse open>{false}</Collapse>);
    rerender(<Collapse open={false}>{null}</Collapse>);
    act(() => {
      vi.advanceTimersByTime(COLLAPSE_MS - 1);
    });
    expect(screen.getByText("You are read-only.")).toBeInTheDocument();
  });

  it("lets its grid item be narrower than its content, on the width axis too", () => {
    // A COUPLING TEST, and the class is the whole point: jsdom computes no layout, so what is
    // pinned here is a fact about a REAL browser that only a class can carry into this file.
    //
    // The fact: a grid item's automatic minimum size is `auto` on BOTH axes. `min-h-0` is already
    // pinned above because without it the 0fr row never collapses. `min-w-0` is the same rule
    // sideways — without it this item refuses to be narrower than its min-content width, and since
    // the clip comes off the moment the row settles open (the test above), the overflow paints out
    // past the grid's right edge instead of being hidden. The measured victim was the agent-chat
    // bottom region: a host path appended by an image upload widened the composer row and carried
    // its Send button off the screen. Every Collapse wraps arbitrary caller content, so the rule
    // lives in the primitive; `ui/chat/chat-input.tsx` holds the other half of that fix.
    const { container } = render(
      <Collapse open>
        <p>copy</p>
      </Collapse>,
    );
    expect(container.querySelector(".min-h-0")).toHaveClass("min-w-0");
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

// ── CollapseSwap ─────────────────────────────────────────────────────────────
// Two surfaces taking turns in one band. The fault it exists to close is not arithmetic — two
// sibling Collapses on opposite gates keep the total height monotonic the whole way — it is that the
// LEAVING surface is pushed the height of the band by the arriving one, so the eye reads a movement
// in the opposite direction to the reveal. These pin the three properties that stop that happening.
describe("CollapseSwap — two surfaces, one band, one motion", () => {
  it("overlaps the two in ONE grid cell, so neither can push the other", () => {
    // THE WHOLE FIX. Placed in the same row and column they occupy the same space, so the band's
    // height is the taller of the two and the stand-in never travels. Stacked in flow instead — the
    // spelling this replaced — the stand-in leaves by sliding the full height of the arriving
    // surface downward, which is what "the animation goes in the wrong direction" was.
    // Asserted MID-SWAP, which is the only moment both surfaces are in the tree — and the only
    // moment the placement can go wrong.
    const { container, rerender } = render(
      <CollapseSwap open={false} standIn={<p>beads</p>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    rerender(
      <CollapseSwap open standIn={<p>beads</p>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    const band = container.querySelector('[data-slot="collapse-swap"]')!;
    expect(band).toHaveClass("grid");
    // …and it is the flex child now, so the floor that kept the strips from being squashed moved
    // here with them.
    expect(band).toHaveClass("shrink-0");

    const collapse = band.querySelector('[data-slot="collapse"]')!;
    const standIn = band.querySelector('[data-slot="collapse-swap-stand-in"]')!;
    for (const cell of [collapse, standIn]) {
      expect(cell).toHaveClass("col-start-1");
      expect(cell).toHaveClass("row-start-1");
    }
    // The stand-in is painted LAST, so it fades over the surface it trades places with, not under.
    expect(standIn.previousElementSibling).toBe(collapse);
  });

  it("animates ONE height — the stand-in only ever fades", () => {
    // The second height animation is the thing being removed. The stand-in holds the band's floor by
    // simply being in it, which is also why it needs no measured number anywhere.
    const { container } = render(
      <CollapseSwap open={false} standIn={<p>beads</p>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    const standIn = container.querySelector('[data-slot="collapse-swap-stand-in"]')!;
    expect(standIn.className).toMatch(/(?:^|\s)transition-opacity(?=\s|$)/);
    expect(standIn.className).not.toMatch(/grid-rows-/);
  });

  it("holds the stand-in through its exit and unmounts it after, like every other presence here", () => {
    // Same contract as Collapse's own delayed unmount, and for the same two reasons: there must be
    // something left to fade, and a surface that is not on screen may not still be in the tab order.
    vi.useFakeTimers();
    const { container, rerender } = render(
      <CollapseSwap open={false} standIn={<button type="button">beads</button>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    expect(screen.getByRole("button", { name: "beads" })).toBeInTheDocument();

    rerender(
      <CollapseSwap open standIn={<button type="button">beads</button>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    // Mid-fade: still drawn, and already unreachable by hand or by keyboard — 240ms of an invisible
    // control that can still be pressed is the bug the pair of attributes closes.
    const standIn = container.querySelector('[data-slot="collapse-swap-stand-in"]')!;
    expect(standIn).toHaveAttribute("inert");
    expect(standIn).toHaveAttribute("aria-hidden", "true");
    expect(standIn.className).toMatch(/(?:^|\s)pointer-events-none(?=\s|$)/);

    act(() => {
      vi.advanceTimersByTime(COLLAPSE_MS + 1);
    });
    expect(container.querySelector('[data-slot="collapse-swap-stand-in"]')).toBeNull();
  });

  it("does not animate the state it was born in", () => {
    // A band that arrived folded did not fold in front of anybody. Animating it would manufacture a
    // movement the operator did not cause — Collapse's own first-paint guard, kept here.
    const { container } = render(
      <CollapseSwap open={false} standIn={<p>beads</p>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    const standIn = container.querySelector('[data-slot="collapse-swap-stand-in"]')!;
    expect(standIn.className).toMatch(/(?:^|\s)opacity-100(?=\s|$)/);
  });

  it("snaps under prefers-reduced-motion, with no intermediate state either way", () => {
    preferReducedMotion(true);
    vi.useFakeTimers();
    const { container, rerender } = render(
      <CollapseSwap open={false} standIn={<p>beads</p>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    expect(container.querySelector('[data-slot="collapse-swap-stand-in"]')).toHaveClass(
      "motion-reduce:transition-none",
    );

    rerender(
      <CollapseSwap open standIn={<p>beads</p>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    // Gone at once, not 240ms later: the CSS half stops the paint moving, the JS half stops the
    // stand-in loitering invisibly in the tree.
    expect(container.querySelector('[data-slot="collapse-swap-stand-in"]')).toBeNull();

    // …and back the other way in the same breath.
    rerender(
      <CollapseSwap open={false} standIn={<p>beads</p>}>
        <p>rows</p>
      </CollapseSwap>,
    );
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(container.querySelector('[data-slot="collapse-swap-stand-in"]')).not.toBeNull();
  });
});
