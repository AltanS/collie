import { render, screen } from "@testing-library/react";

import {
  CompactStripLabels,
  LabelledStrip,
  STRIP_TAP_TARGET,
  STRIP_TAP_TARGET_SQUARE,
} from "./labelled-strip";

describe("LabelledStrip", () => {
  it("names the row for a screen reader, by pointing at the visible label", () => {
    render(
      <LabelledStrip label="Spaces">
        <button type="button">All</button>
      </LabelledStrip>,
    );
    const strip = screen.getByRole("navigation", { name: "Spaces" });
    // The name must come from the label the eye sees, not from a duplicate string — otherwise the
    // two can drift and the screen reader ends up announcing a word nobody can point at.
    const id = strip.getAttribute("aria-labelledby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toHaveTextContent("Spaces");
  });

  it("keeps the label OUT of the scrolling element", () => {
    // This is the whole point of the component. Inline, the label was the scroller's first child,
    // so scrolling the pills sideways carried the row's only name off the screen with them.
    render(
      <LabelledStrip label="Panes">
        <button type="button">p1</button>
      </LabelledStrip>,
    );
    const strip = screen.getByRole("navigation", { name: "Panes" });
    const label = document.getElementById(strip.getAttribute("aria-labelledby")!);
    const scroller = strip.querySelector(".overflow-x-auto");
    expect(scroller).not.toBeNull();
    expect(scroller).toContainElement(screen.getByRole("button", { name: "p1" }));
    expect(scroller).not.toContainElement(label);
  });

  it("keeps the pills' tap floor and the scroller's padding in step", () => {
    // jsdom has no layout, so this cannot measure 44px — the real numbers were taken in Chrome at
    // 390px (drawn 34px, hit 46px, rows 17px apart). What it CAN pin is the coupling those numbers
    // rest on, which is the part a later edit breaks by accident: the pills' hit area is a
    // transparent ::before reaching 7px past their padding box, and it is only hittable because the
    // scroller's own py-1.5 gives it 6px of room inside the clip boundary. `overflow-x: auto` makes
    // the scroller clip vertically too, so a pill reaching further than the padding stops taking
    // taps there — silently, with nothing to see. Change one of these two and change the other.
    render(
      <LabelledStrip label="Spaces">
        <button type="button">All</button>
      </LabelledStrip>,
    );
    const scroller = screen.getByRole("navigation", { name: "Spaces" }).querySelector(".overflow-x-auto");
    expect(scroller).toHaveClass("py-1.5");
    expect(STRIP_TAP_TARGET).toContain("before:-inset-y-[7px]");
    // The square "+" buttons are the only things in these rows under 44px WIDE, and the only ones
    // that may reach sideways: they are last in the row, and 7px is less than its `gap-2`.
    expect(STRIP_TAP_TARGET_SQUARE).toContain("before:-inset-x-[7px]");
    expect(scroller).toHaveClass("gap-2");
  });

  it("cancels the scroller's gutter with the same number the strip pads by", () => {
    // The `-mx-N px-N` pair is ONE number — the route's gutter, 16px under R2 — and the two halves
    // only work together: pad without the negative margin and the row stops short of the screen
    // edge; negate without the padding and the first pill starts off the gutter. Changing one and
    // forgetting the other is silent, so it is pinned here rather than left to the eye.
    render(
      <LabelledStrip label="Spaces">
        <button type="button">All</button>
      </LabelledStrip>,
    );
    const strip = screen.getByRole("navigation", { name: "Spaces" });
    const scroller = strip.querySelector(".overflow-x-auto");
    expect(strip).toHaveClass("px-4");
    expect(scroller).toHaveClass("px-4");
    expect(scroller).toHaveClass("-mx-4");
  });

  it("draws the label by default, so no caller can make the row two different heights", () => {
    // There is still no per-strip way to suppress it. A strip that drew its name in one state and
    // not in another would change height across that state, and a page that jumps on a navigation
    // is the same fault as a list row that grows on hover.
    render(
      <LabelledStrip label="Spaces">
        <button type="button">Back</button>
      </LabelledStrip>,
    );
    expect(screen.getByText("Spaces")).toBeInTheDocument();
  });

  it("hides every label in a compact subtree, or none — never one of two", () => {
    // The replacement for the deleted `hideLabel` prop, and the reason it is a context: the choice
    // is read from an ancestor, so two sibling strips CANNOT disagree and end up 47px against 63px.
    // A caller picks where the provider goes, not which strips obey it.
    render(
      <CompactStripLabels>
        <LabelledStrip label="Tabs">
          <button type="button">t1</button>
        </LabelledStrip>
        <LabelledStrip label="Panes">
          <button type="button">p1</button>
        </LabelledStrip>
      </CompactStripLabels>,
    );
    for (const name of ["Tabs", "Panes"]) {
      const label = screen.getByText(name);
      // sr-only, not removed: the element has to stay in the tree to keep answering the nav's
      // aria-labelledby. Measured in Chrome at 390px, this takes each row 63px -> 47px.
      expect(label).toHaveClass("sr-only");
      expect(screen.getByRole("navigation", { name })).toContainElement(label);
    }
  });

  it("keeps the strip's accessible name when the label is unpainted", () => {
    // The whole point of sr-only over a conditional render. Before this round no strip had an
    // accessible name at all; a compact route must not quietly give that back up.
    render(
      <CompactStripLabels>
        <LabelledStrip label="Panes">
          <button type="button">p1</button>
        </LabelledStrip>
      </CompactStripLabels>,
    );
    expect(screen.getByRole("navigation", { name: "Panes" })).toBeInTheDocument();
  });

  it("drops the label's own air with the label, and nothing the tap floor needs", () => {
    // pt-1.5 is the space above the word; with no word painted it is a blank 6px. The scroller's
    // py-1.5 is a different 6px — it is the room the pills' ::before reaches into — and it must
    // survive the compact treatment untouched, or the 44px floor goes with the label.
    render(
      <CompactStripLabels>
        <LabelledStrip label="Tabs">
          <button type="button">t1</button>
        </LabelledStrip>
      </CompactStripLabels>,
    );
    const strip = screen.getByRole("navigation", { name: "Tabs" });
    expect(strip).not.toHaveClass("pt-1.5");
    expect(strip.querySelector(".overflow-x-auto")).toHaveClass("py-1.5");
  });

});
