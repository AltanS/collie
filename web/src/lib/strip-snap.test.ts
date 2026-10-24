import { describe, expect, it } from "vitest";

import { COLUMN_SNAP_CLASSES, leftmostWholeColumn, nearestColumnStart, shouldFollowFocus, STRIP_SNAP_CLASSES } from "./strip-snap";

describe("nearestColumnStart", () => {
  const starts = [0, 400, 900];

  it("picks the nearest start", () => {
    expect(nearestColumnStart(100, starts)).toBe(0);
    expect(nearestColumnStart(250, starts)).toBe(400);
    expect(nearestColumnStart(800, starts)).toBe(900);
  });

  it("picks the left start on an exact tie", () => {
    expect(nearestColumnStart(200, starts)).toBe(0);
    expect(nearestColumnStart(650, starts)).toBe(400);
    expect(nearestColumnStart(200, [400, 0])).toBe(0);
  });

  it("clamps to the first start before it and the last start past it", () => {
    expect(nearestColumnStart(-50, starts)).toBe(0);
    expect(nearestColumnStart(5000, starts)).toBe(900);
  });

  it("returns the position itself when there is no column", () => {
    expect(nearestColumnStart(123, [])).toBe(123);
  });
});

describe("shouldFollowFocus", () => {
  const viewport = { left: 400, width: 800 };

  it("is false while the focused column is fully inside", () => {
    expect(shouldFollowFocus(viewport, { start: 500, width: 300 })).toBe(false);
  });

  it("counts a column exactly at either edge as visible", () => {
    expect(shouldFollowFocus(viewport, { start: 400, width: 400 })).toBe(false);
    expect(shouldFollowFocus(viewport, { start: 800, width: 400 })).toBe(false);
    expect(shouldFollowFocus(viewport, { start: 400, width: 800 })).toBe(false);
  });

  it("forgives a fraction of a pixel but not two", () => {
    expect(shouldFollowFocus(viewport, { start: 399.5, width: 400 })).toBe(false);
    expect(shouldFollowFocus(viewport, { start: 398, width: 400 })).toBe(true);
  });

  it("is true once a part of the column is out", () => {
    expect(shouldFollowFocus(viewport, { start: 300, width: 400 })).toBe(true);
    expect(shouldFollowFocus(viewport, { start: 900, width: 400 })).toBe(true);
  });

  it("is true for a column fully outside, on either side", () => {
    expect(shouldFollowFocus(viewport, { start: 0, width: 300 })).toBe(true);
    expect(shouldFollowFocus(viewport, { start: 1300, width: 300 })).toBe(true);
  });

  it("is false for a column wider than the viewport that covers it", () => {
    expect(shouldFollowFocus(viewport, { start: 300, width: 1000 })).toBe(false);
    expect(shouldFollowFocus(viewport, { start: 700, width: 1000 })).toBe(true);
  });
});

describe("leftmostWholeColumn", () => {
  const columns = [
    { key: "a", start: 0, width: 400 },
    { key: "b", start: 400, width: 400 },
    { key: "c", start: 800, width: 400 },
    { key: "d", start: 1200, width: 400 },
  ];

  it("skips a column cut at the left edge", () => {
    expect(leftmostWholeColumn({ left: 300, width: 800 }, columns)).toBe("b");
  });

  it("takes the column that starts exactly at the left edge", () => {
    expect(leftmostWholeColumn({ left: 400, width: 800 }, columns)).toBe("b");
  });

  it("does not need the list sorted", () => {
    expect(leftmostWholeColumn({ left: 400, width: 800 }, columns.toReversed())).toBe("b");
  });

  it("is undefined when no column is whole", () => {
    expect(leftmostWholeColumn({ left: 100, width: 500 }, columns)).toBeUndefined();
    expect(leftmostWholeColumn({ left: 0, width: 800 }, [])).toBeUndefined();
  });
});

describe("class constants", () => {
  it("name the snap utilities", () => {
    expect(STRIP_SNAP_CLASSES).toBe("snap-x snap-mandatory overscroll-x-contain");
    expect(COLUMN_SNAP_CLASSES).toBe("snap-start [scroll-snap-stop:normal]");
  });
});
