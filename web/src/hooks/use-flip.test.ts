import { ENTER_PX, anchorEdge, entranceOffset, heightSpan, invertOffset, relativeTo } from "./use-flip";

describe("use-flip, the pure part", () => {
  it("measures a rectangle from the origin's top left corner", () => {
    expect(relativeTo({ left: 30, top: 500, width: 36, height: 36 }, { left: 10, top: 480, width: 300, height: 44 })).toEqual({
      left: 20,
      top: 20,
      width: 36,
      height: 36,
    });
  });

  it("plays no vertical move for a button that changed rows (Altan, 2026-11-07: nothing drops from the top)", () => {
    // Before: first row of a 44px box. After: the third row of a 132px box, same column.
    const before = { left: 4, top: 4, width: 36, height: 36 };
    const after = { left: 4, top: 92, width: 36, height: 36 };
    expect(invertOffset(before, after)).toBeNull();
  });

  it("inverts a button that moved sideways, and only sideways", () => {
    expect(invertOffset({ left: 100, top: 4, width: 36, height: 36 }, { left: 250, top: 92, width: 36, height: 36 })).toBe(-150);
  });

  it("says nothing for a button that did not move", () => {
    expect(invertOffset({ left: 4, top: 4, width: 36, height: 36 }, { left: 4.2, top: 4.3, width: 36, height: 36 })).toBeNull();
  });

  it("slides a new button in from the edge it lives on", () => {
    const box = { left: 0, top: 0, width: 360, height: 84 };
    // Send at the right edge comes in from the right; under the left hand it stands at the left.
    expect(entranceOffset({ left: 318, top: 42, width: 36, height: 36 }, box)).toBe(ENTER_PX);
    expect(entranceOffset({ left: 6, top: 42, width: 36, height: 36 }, box)).toBe(-ENTER_PX);
  });

  it("holds the rows against the edge that stays put", () => {
    // The pane screen: the composer stands on the screen's foot, so the box grows upward.
    expect(anchorEdge({ top: 399, height: 50 }, { top: 368, height: 81 })).toBe("end");
    expect(anchorEdge({ top: 368, height: 81 }, { top: 399, height: 50 })).toBe("end");
    // A box with free room under it grows downward.
    expect(anchorEdge({ top: 646, height: 50 }, { top: 646, height: 81 })).toBe("start");
  });

  it("gives height keyframes in pixels, and none when the shapes are as tall as each other", () => {
    expect(heightSpan(46, 134)).toEqual(["46px", "134px"]);
    expect(heightSpan(134, 46)).toEqual(["134px", "46px"]);
    expect(heightSpan(46, 46.4)).toBeNull();
  });
});
