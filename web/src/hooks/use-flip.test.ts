import { heightSpan, invertOffset, relativeTo } from "./use-flip";

describe("use-flip, the pure part", () => {
  it("measures a rectangle from the origin's top left corner", () => {
    expect(relativeTo({ left: 30, top: 500, width: 36, height: 36 }, { left: 10, top: 480, width: 300, height: 44 })).toEqual({
      left: 20,
      top: 20,
      width: 36,
      height: 36,
    });
  });

  it("inverts a button that moved from the first row to the last", () => {
    // Before: first row of a 44px box. After: the third row of a 132px box.
    const before = { left: 4, top: 4, width: 36, height: 36 };
    const after = { left: 4, top: 92, width: 36, height: 36 };
    expect(invertOffset(before, after)).toEqual({ x: 0, y: -88 });
  });

  it("inverts a button that moved to the right", () => {
    expect(invertOffset({ left: 100, top: 4, width: 36, height: 36 }, { left: 250, top: 4, width: 36, height: 36 })).toEqual({ x: -150, y: 0 });
  });

  it("says nothing for a button that did not move", () => {
    expect(invertOffset({ left: 4, top: 4, width: 36, height: 36 }, { left: 4.2, top: 4.3, width: 36, height: 36 })).toBeNull();
  });

  it("gives height keyframes in pixels, and none when the shapes are as tall as each other", () => {
    expect(heightSpan(46, 134)).toEqual(["46px", "134px"]);
    expect(heightSpan(134, 46)).toEqual(["134px", "46px"]);
    expect(heightSpan(46, 46.4)).toBeNull();
  });
});
