import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { arrowsOf, OverflowEdges } from "./overflow-edges";

// The mouse halves of OverflowEdges: `drag` (a press that moves past the slop pulls the scroller, fires no
// pill, cancels the pill's own press) and `arrows` (a button over each edge that still hides content, only
// under a hovering fine pointer). jsdom has no layout and no pointer capture, so both are set by hand.

const ARROWS = { left: "0px", right: "calc(40px - 4rem)", leftLabel: "Scroll left", rightLabel: "Scroll right" } as const;

function fineMouse(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({ matches: matches && query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  );
}

afterEach(() => vi.unstubAllGlobals());

function mount(props: { drag?: boolean; arrows?: typeof ARROWS }, onPill = vi.fn(), onCancel = vi.fn()) {
  render(
    <OverflowEdges {...props}>
      {(ref) => (
        <div ref={ref} data-testid="scroller">
          <button type="button" data-testid="pill" onClick={onPill} onPointerCancel={onCancel}>
            Compact
          </button>
        </div>
      )}
    </OverflowEdges>,
  );
  const scroller = screen.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: 500 });
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: 300 });
  scroller.setPointerCapture = vi.fn();
  scroller.releasePointerCapture = vi.fn();
  scroller.hasPointerCapture = () => true;
  return { scroller, pill: screen.getByTestId("pill"), onPill, onCancel };
}

const mouse = (clientX: number, over: PointerEventInit = {}): PointerEventInit => ({ pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX, ...over });

describe("OverflowEdges drag", () => {
  it("pulls the scroller one to one past the slop, cancels the pill's press and swallows the click", () => {
    const { scroller, pill, onPill, onCancel } = mount({ drag: true });
    fireEvent.pointerDown(pill, mouse(500));
    fireEvent.pointerMove(pill, mouse(497));
    expect(scroller.scrollLeft).toBe(0);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.pointerMove(pill, mouse(300));
    expect(scroller.scrollLeft).toBe(200);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(scroller).toHaveAttribute("data-belt-dragging");
    expect(scroller.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerUp(scroller, mouse(300));
    expect(scroller).not.toHaveAttribute("data-belt-dragging");
    fireEvent.click(pill);
    expect(onPill).not.toHaveBeenCalled();
    // Only one click is swallowed: the next press is an ordinary click.
    fireEvent.click(pill);
    expect(onPill).toHaveBeenCalledTimes(1);
  });

  it("leaves a press inside the slop an ordinary click", () => {
    const { scroller, pill, onPill, onCancel } = mount({ drag: true });
    fireEvent.pointerDown(pill, mouse(500));
    fireEvent.pointerMove(pill, mouse(503));
    fireEvent.pointerUp(pill, mouse(503));
    fireEvent.click(pill);
    expect(onPill).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBe(0);
  });

  it("starts no drag for a touch or a pen, a secondary button, or without the prop", () => {
    for (const over of [{ pointerType: "touch" }, { pointerType: "pen" }, { button: 2 }]) {
      const { scroller, pill } = mount({ drag: true });
      fireEvent.pointerDown(pill, mouse(500, over));
      fireEvent.pointerMove(pill, mouse(300, over));
      expect(scroller.scrollLeft).toBe(0);
      document.body.innerHTML = "";
    }
    const { scroller, pill } = mount({});
    fireEvent.pointerDown(pill, mouse(500));
    fireEvent.pointerMove(pill, mouse(300));
    expect(scroller.scrollLeft).toBe(0);
  });
});

describe("the arrows", () => {
  it("shows an arrow only on the edge that still hides content, from the scroll position", () => {
    expect(arrowsOf("none")).toEqual({ left: false, right: false });
    expect(arrowsOf("right")).toEqual({ left: false, right: true });
    expect(arrowsOf("left")).toEqual({ left: true, right: false });
    expect(arrowsOf("both")).toEqual({ left: true, right: true });
  });

  it("draws the right arrow at rest, both mid-way and the left one at the end, under a fine pointer", () => {
    fineMouse(true);
    const { scroller } = mount({ arrows: ARROWS });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("button", { name: "Scroll left" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scroll right" })).toHaveStyle({ right: "calc(40px - 4rem)" });
    scroller.scrollLeft = 100;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByRole("button", { name: "Scroll left" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scroll right" })).toBeInTheDocument();
    scroller.scrollLeft = 200;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("button", { name: "Scroll right" })).toBeNull();
  });

  it("scrolls by 80% of the width on a click, and draws none without a fine pointer", () => {
    fineMouse(true);
    const { scroller } = mount({ arrows: ARROWS });
    const by = vi.fn();
    scroller.scrollBy = by;
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Scroll right" }));
    expect(by).toHaveBeenCalledWith({ left: 240, behavior: "smooth" });
  });

  it("draws no arrow on a touch screen", () => {
    fineMouse(false);
    const { scroller } = mount({ arrows: ARROWS });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("button", { name: /Scroll/ })).toBeNull();
  });
});
