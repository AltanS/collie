import { describe, expect, it } from "vitest";

import { decideBeltWheel, type BeltWheelInput } from "./belt-wheel";

// THE BELT UNDER A MOUSE WHEEL: how far, and whether the Belt takes the event. A Belt 300px wide in a
// 500px scroller has 200px of range.
const BASE: BeltWheelInput = { scrollLeft: 0, scrollWidth: 500, clientWidth: 300, rtl: false, deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false };
const wheel = (over: Partial<BeltWheelInput>) => decideBeltWheel({ ...BASE, ...over });

describe("a plain vertical wheel turn", () => {
  it("scrolls the Belt toward its end and takes the event", () => {
    expect(wheel({ deltaY: 100 })).toEqual({ take: true, scrollLeft: 100 });
    expect(wheel({ scrollLeft: 150, deltaY: -100 })).toEqual({ take: true, scrollLeft: 50 });
  });

  it("stops at the ends, and takes the last move that reaches one", () => {
    expect(wheel({ scrollLeft: 150, deltaY: 300 })).toEqual({ take: true, scrollLeft: 200 });
    expect(wheel({ scrollLeft: 50, deltaY: -300 })).toEqual({ take: true, scrollLeft: 0 });
  });

  it("passes on at an end, so the page or the strip moves as before", () => {
    expect(wheel({ scrollLeft: 200, deltaY: 100 })).toEqual({ take: false, scrollLeft: null });
    expect(wheel({ scrollLeft: 0, deltaY: -100 })).toEqual({ take: false, scrollLeft: null });
  });

  it("takes nothing on a Belt that does not overflow, or by a fraction", () => {
    expect(wheel({ scrollWidth: 300, deltaY: 100 }).take).toBe(false);
    expect(wheel({ scrollWidth: 300.4, deltaY: 100 }).take).toBe(false);
  });
});

describe("a sideways wheel turn", () => {
  it("moves the Belt by its own delta, Shift or not", () => {
    expect(wheel({ deltaX: 80 })).toEqual({ take: true, scrollLeft: 80 });
    expect(wheel({ scrollLeft: 100, deltaX: -40 })).toEqual({ take: true, scrollLeft: 60 });
    expect(wheel({ shiftKey: true, deltaY: 120 })).toEqual({ take: true, scrollLeft: 120 });
  });

  it("passes on at the end it runs toward", () => {
    expect(wheel({ scrollLeft: 200, deltaX: 50 }).take).toBe(false);
    expect(wheel({ scrollLeft: 0, deltaX: -50 }).take).toBe(false);
  });

  it("leaves a mostly vertical trackpad swipe to the page", () => {
    expect(wheel({ deltaX: 3, deltaY: 40 }).take).toBe(false);
  });
});

describe("the units", () => {
  it("reads lines as 16px and pages as the scroller's width", () => {
    expect(wheel({ deltaMode: 1, deltaY: 3 })).toEqual({ take: true, scrollLeft: 48 });
    expect(wheel({ deltaMode: 2, deltaY: 1 })).toEqual({ take: true, scrollLeft: 200 });
  });
});

describe("a right-to-left Belt (the left hand)", () => {
  it("rests at 0, pans into negative scrollLeft, and a vertical turn runs it toward its end", () => {
    expect(wheel({ rtl: true, deltaY: 100 })).toEqual({ take: true, scrollLeft: -100 });
    expect(wheel({ rtl: true, scrollLeft: -150, deltaY: 300 })).toEqual({ take: true, scrollLeft: -200 });
    expect(wheel({ rtl: true, scrollLeft: -200, deltaY: 100 }).take).toBe(false);
    expect(wheel({ rtl: true, scrollLeft: 0, deltaY: -100 }).take).toBe(false);
  });

  it("moves a sideways delta in screen terms", () => {
    expect(wheel({ rtl: true, scrollLeft: -100, deltaX: 40 })).toEqual({ take: true, scrollLeft: -60 });
  });
});
