import { describe, expect, it } from "vitest";

import { visibleStatusCount } from "./status";

// THE OVERFLOW RULE OF THE STATUS LINE: the tricks' items hide first, the last of them first, and
// Collie's own items never move.

describe("visibleStatusCount", () => {
  const gap = 6;

  it("shows every item when they all fit", () => {
    expect(visibleStatusCount({ room: 300, own: 120, gap, widths: [40, 40, 40] })).toBe(3);
    expect(visibleStatusCount({ room: 300, own: 120, gap, widths: [] })).toBe(0);
  });

  it("counts the gap before every item, and after Collie's own items only when there are some", () => {
    // 120 + 6 + 40 + 6 + 40 = 212
    expect(visibleStatusCount({ room: 212, own: 120, gap, widths: [40, 40] })).toBe(2);
    expect(visibleStatusCount({ room: 211, own: 120, gap, widths: [40, 40] })).toBe(1);
    // No Collie item: the first trick item stands at the start with no gap before it. 40 + 6 + 40 = 86
    expect(visibleStatusCount({ room: 86, own: 0, gap, widths: [40, 40] })).toBe(2);
    expect(visibleStatusCount({ room: 85, own: 0, gap, widths: [40, 40] })).toBe(1);
  });

  it("hides the newest first: the last in manifest order, then the one before it", () => {
    const widths = [40, 40, 40, 40];
    // 120 own, room for the first two only.
    const room = 120 + 6 + 40 + 6 + 40;
    expect(visibleStatusCount({ room, own: 120, gap, widths })).toBe(2);
    // Less room: one item, then none. The count is from the first, so the shown ones are always the oldest.
    expect(visibleStatusCount({ room: room - 1, own: 120, gap, widths })).toBe(1);
    expect(visibleStatusCount({ room: 120 + 6 + 39, own: 120, gap, widths })).toBe(0);
  });

  it("never lets a small item jump over a larger one that gave way", () => {
    expect(visibleStatusCount({ room: 120 + 6 + 40 + 6 + 20, own: 120, gap, widths: [40, 60, 10] })).toBe(1);
  });

  it("shows none when Collie's own items alone are as wide as the room or wider, and never a negative count", () => {
    expect(visibleStatusCount({ room: 100, own: 120, gap, widths: [10, 10] })).toBe(0);
    expect(visibleStatusCount({ room: 120, own: 120, gap, widths: [10] })).toBe(0);
    expect(visibleStatusCount({ room: 0, own: 0, gap, widths: [10] })).toBe(0);
  });

  it("does not depend on the width of a hidden item for the items before it", () => {
    expect(visibleStatusCount({ room: 200, own: 100, gap, widths: [30, 500] })).toBe(1);
  });
});
