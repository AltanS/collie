import { act, render, screen } from "@testing-library/react";

import { OverflowEdges } from "./overflow-edges";

// jsdom has no layout: every element reports 0 for `scrollWidth`, `clientWidth` and `scrollLeft`,
// so the real numbers can only come from a stub. What this pins is not the pixels — those were
// measured in Chrome at 390px — but the RULE the pixels feed: a side fades, and grows a chevron,
// exactly when it still hides something. The state is read off `data-overflow`, which is the
// attribute the primitive publishes for this purpose, and the chevrons are counted as `svg`
// elements. Neither a class name nor an internal structure is addressed here on purpose.

/** Plants readable scroll metrics on a real element and hands back a scroll driver. */
function pinMetrics(el: HTMLElement, { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  let position = 0;
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => position });
  return (to: number) => {
    position = to;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
  };
}

function mount() {
  const { container } = render(
    <OverflowEdges>
      {(ref) => (
        <div ref={ref}>
          <button type="button">Keys</button>
        </div>
      )}
    </OverflowEdges>,
  );
  const wrapper = container.querySelector("[data-overflow]");
  if (!(wrapper instanceof HTMLElement)) throw new Error("the wrapper must publish data-overflow");
  // The scroller is addressed through its own content rather than through the wrapper's shape, so
  // the primitive may re-arrange its layers without this test noticing.
  const scroller = screen.getByRole("button", { name: "Keys" }).parentElement;
  if (!(scroller instanceof HTMLElement)) throw new Error("the pills must live inside the scroller");
  return { wrapper, scroller };
}

describe("OverflowEdges", () => {
  it("moves right → both → left as the scroller is dragged across", () => {
    const { wrapper, scroller } = mount();
    const scrollTo = pinMetrics(scroller, { scrollWidth: 1000, clientWidth: 400 });

    // At rest: 600px of pills still off the right edge, nothing off the left.
    scrollTo(0);
    expect(wrapper.dataset.overflow).toBe("right");
    expect(wrapper.querySelectorAll("svg")).toHaveLength(1);

    // Half way: both ends hide something, so both ends say so.
    scrollTo(300);
    expect(wrapper.dataset.overflow).toBe("both");
    expect(wrapper.querySelectorAll("svg")).toHaveLength(2);

    // At the far right: the only thing still hidden is behind you.
    scrollTo(600);
    expect(wrapper.dataset.overflow).toBe("left");
    expect(wrapper.querySelectorAll("svg")).toHaveLength(1);
  });

  it("says nothing at all when the row fits", () => {
    // The fault this whole primitive exists to fix ran the other way too: the old mask faded BOTH
    // ends unconditionally, including a row with nothing hidden on either side.
    const { wrapper, scroller } = mount();
    const scrollTo = pinMetrics(scroller, { scrollWidth: 400, clientWidth: 400 });
    scrollTo(0);
    expect(wrapper.dataset.overflow).toBe("none");
    expect(wrapper.querySelectorAll("svg")).toHaveLength(0);
  });
});
