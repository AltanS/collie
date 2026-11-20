import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OverflowEdges } from "./overflow-edges";

// The wheel half of OverflowEdges (`wheel`): the Belt's scroller takes a vertical turn as sideways while it
// has room, calls preventDefault only then, and is left alone when the prop is off. jsdom has no layout, so
// the scroller's measurements are set by hand.

function mount(wheel: boolean, widths = { scrollWidth: 500, clientWidth: 300 }) {
  render(
    <OverflowEdges wheel={wheel}>
      {(ref) => <div ref={ref} data-testid="scroller" />}
    </OverflowEdges>,
  );
  const scroller = screen.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: widths.scrollWidth });
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: widths.clientWidth });
  return scroller;
}

describe("OverflowEdges wheel", () => {
  it("scrolls the scroller sideways on a vertical turn and takes the event", () => {
    const scroller = mount(true);
    expect(fireEvent.wheel(scroller, { deltaY: 120 })).toBe(false);
    expect(scroller.scrollLeft).toBe(120);
    expect(fireEvent.wheel(scroller, { deltaX: 500 })).toBe(false);
    expect(scroller.scrollLeft).toBe(200);
  });

  it("does not take the event at the end, on a scroller that fits, with Ctrl held, or with the prop off", () => {
    const scroller = mount(true);
    scroller.scrollLeft = 200;
    expect(fireEvent.wheel(scroller, { deltaY: 120 })).toBe(true);
    expect(fireEvent.wheel(scroller, { deltaY: -120, ctrlKey: true })).toBe(true);
    expect(scroller.scrollLeft).toBe(200);
  });

  it("leaves a Belt that fits, and a scroller without the prop, alone", () => {
    const fits = mount(true, { scrollWidth: 300, clientWidth: 300 });
    expect(fireEvent.wheel(fits, { deltaY: 120 })).toBe(true);
    expect(fits.scrollLeft).toBe(0);
  });

  it("is not attached without the prop", () => {
    const scroller = mount(false);
    expect(fireEvent.wheel(scroller, { deltaY: 120 })).toBe(true);
    expect(scroller.scrollLeft).toBe(0);
  });
});
