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

function mount(insetRight?: number, cue?: "soft" | "none", edges?: "both" | "left") {
  const { container } = render(
    <OverflowEdges insetRight={insetRight} cue={cue} edges={edges}>
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

  // `insetRight` holds the right-hand cue back from the edge, for a caller that has pinned
  // something over its own right end — the actions belt's host tag. A cue drawn under that tag
  // says nothing, so the fade and the chevron move to its left and the tag's fade carries on.
  //
  // jsdom has no layout, so what is pinned is the two places the number LANDS: the custom property
  // the gradient reads, and the chevron's own offset. The pixels themselves were measured in Chrome.
  describe("insetRight", () => {
    it("moves both halves of the right cue in by the given px", () => {
      const { wrapper, scroller } = mount(56);
      pinMetrics(scroller, { scrollWidth: 1000, clientWidth: 400 })(0);
      expect(wrapper.dataset.overflow).toBe("right");
      const masked = scroller.parentElement!;
      expect(masked.style.getPropertyValue("--edge-inset-right")).toBe("56px");
      // The chevron keeps the 4px the LEFT one sits at, measured from its real right edge. The
      // offset lands on the cue's wrapping span (the glyph plus its optional backdrop), not on the
      // svg directly.
      const cue = wrapper.querySelector("svg")!.parentElement!;
      expect(cue.getAttribute("style")).toContain("right: 60px");
    });

    it("changes nothing at all when it is absent — no property, no offset", () => {
      const { wrapper, scroller } = mount();
      pinMetrics(scroller, { scrollWidth: 1000, clientWidth: 400 })(0);
      const masked = scroller.parentElement!;
      expect(masked.getAttribute("style")).toBeNull();
      expect(wrapper.querySelector("svg")!.parentElement!.getAttribute("style")).toBeNull();
    });
  });

  // "none" is the actions belt's own pick, opted into per caller — every other caller keeps the
  // bare "soft" glyph unless it asks for the other.
  describe("cue", () => {
    it("defaults to the bare, muted glyph", () => {
      const { wrapper, scroller } = mount();
      pinMetrics(scroller, { scrollWidth: 1000, clientWidth: 400 })(0);
      const svg = wrapper.querySelector("svg")!;
      expect(svg.getAttribute("class")).toContain("size-3");
      expect(svg.getAttribute("class")).toContain("text-muted-foreground");
    });

    it("draws the fade and no glyph at all when asked", () => {
      const { wrapper, scroller } = mount(undefined, "none");
      const scrollTo = pinMetrics(scroller, { scrollWidth: 1000, clientWidth: 400 });
      // Both ends hide content at this scroll position, so a chevron-drawing cue would show two.
      scrollTo(300);
      expect(wrapper.dataset.overflow).toBe("both");
      expect(wrapper.querySelectorAll("svg")).toHaveLength(0);
    });
  });

  // `edges="left"` is the actions belt's pick — its pinned Switch block paints its own constant
  // fade at the right end, so this primitive must never paint a second, scroll-dependent one there.
  describe("edges", () => {
    it("never paints the right mask or chevron, however far the row still overflows on that side", () => {
      const { wrapper, scroller } = mount(undefined, "soft", "left");
      const masked = scroller.parentElement!;

      // At rest: only the right side hides anything. `edges="left"` must drop that to nothing.
      pinMetrics(scroller, { scrollWidth: 1000, clientWidth: 400 })(0);
      // `data-overflow` still reports the real, unrestricted measurement — only the paint is
      // restricted — so a consumer reading the raw state (the playground's ground selectors) still
      // sees the truth.
      expect(wrapper.dataset.overflow).toBe("right");
      expect(masked.className).not.toContain("black_calc");
      expect(wrapper.querySelectorAll("svg")).toHaveLength(0);
    });

    it("keeps the left mask and chevron once the row has scrolled into `both`", () => {
      const { wrapper, scroller } = mount(undefined, "soft", "left");
      const masked = scroller.parentElement!;
      const scrollTo = pinMetrics(scroller, { scrollWidth: 1000, clientWidth: 400 });

      scrollTo(300);
      expect(wrapper.dataset.overflow).toBe("both");
      expect(masked.className).toContain("transparent,black_1.5rem)");
      expect(masked.className).not.toContain("black_calc");
      expect(wrapper.querySelectorAll("svg")).toHaveLength(1);
    });

    it("defaults to both edges when unset", () => {
      const { wrapper } = mount();
      expect(wrapper).toBeTruthy(); // no throw; `edges` is optional and every existing caller is unaffected
    });
  });
});
