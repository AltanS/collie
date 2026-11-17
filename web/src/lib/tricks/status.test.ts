import { describe, expect, it } from "vitest";

import { fitStatusRow, LABEL_FLOOR, visibleStatusCount } from "./status";

// THE OVERFLOW RULE OF THE STATUS LINE: a trick's chip keeps its place. The model name gives way first
// (its shorter forms, then an ellipsis); the chips hide only when they alone are more than the row holds,
// the last of them first.

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

describe("fitStatusRow", () => {
  const gap = 4;
  // The name in two forms (85 with the effort, 40 without), figures of 112.
  const forms = [85, 40];
  const fixed = 112;

  it("draws everything whole when it all fits", () => {
    // 85 + 4 + 112 + 4 + 70 = 275
    expect(fitStatusRow({ room: 275, fixed, gap, forms, widths: [70] })).toEqual({ count: 1, form: 0 });
  });

  it("shortens the name before it hides a chip", () => {
    expect(fitStatusRow({ room: 274, fixed, gap, forms, widths: [70] })).toEqual({ count: 1, form: 1 });
    // 40 + 4 + 112 + 4 + 70 = 230: the short form still fits exactly.
    expect(fitStatusRow({ room: 230, fixed, gap, forms, widths: [70] })).toEqual({ count: 1, form: 1 });
  });

  it("cuts the name with an ellipsis, down to its floor, before it hides a chip", () => {
    // Floor 24 (less than the short form's 40): 24 + 4 + 112 + 4 + 70 = 214.
    expect(LABEL_FLOOR).toBe(24);
    expect(fitStatusRow({ room: 214, fixed, gap, forms, widths: [70] })).toEqual({ count: 1, form: 1 });
    expect(fitStatusRow({ room: 213, fixed, gap, forms, widths: [70] })).toEqual({ count: 0, form: 0 });
    // The chip gave way, so the name has the room again and keeps its effort.
  });

  it("hides the chips from the last one when they are more than fit, with the name at its floor", () => {
    const widths = [60, 60, 60];
    // 24 + 4 + 112 + 4 + 60 + 4 + 60 = 268
    expect(fitStatusRow({ room: 268, fixed, gap, forms, widths }).count).toBe(2);
    expect(fitStatusRow({ room: 267, fixed, gap, forms, widths }).count).toBe(1);
  });

  it("keeps a least gap between the two ends, `between`, which is the gap before the first chip", () => {
    // 24 + 4 + 112 + 12 + 70 = 222 with a gap of 12 between the ends, 214 with the item gap of 4.
    expect(fitStatusRow({ room: 222, fixed, gap, forms, widths: [70], between: 12 }).count).toBe(1);
    expect(fitStatusRow({ room: 221, fixed, gap, forms, widths: [70], between: 12 }).count).toBe(0);
    expect(fitStatusRow({ room: 214, fixed, gap, forms, widths: [70] }).count).toBe(1);
    // The gaps between two chips stay the item gap: 24 + 4 + 112 + 12 + 60 + 4 + 60 = 276.
    expect(fitStatusRow({ room: 276, fixed, gap, forms, widths: [60, 60], between: 12 }).count).toBe(2);
    expect(fitStatusRow({ room: 275, fixed, gap, forms, widths: [60, 60], between: 12 }).count).toBe(1);
    // The name takes what is left beside the chips and the gap: 340 - 116 - 12 - 60 = 152 holds the full form (85).
    expect(fitStatusRow({ room: 340, fixed, gap, forms, widths: [60], between: 12 })).toEqual({ count: 1, form: 0 });
    expect(fitStatusRow({ room: 270, fixed, gap, forms, widths: [60], between: 12 })).toEqual({ count: 1, form: 1 });
  });

  it("takes a name narrower than the floor at its own width, and works with no name or no figures", () => {
    // Name of 10: 10 + 4 + 70 = 84.
    expect(fitStatusRow({ room: 84, fixed: 0, gap, forms: [10], widths: [70] })).toEqual({ count: 1, form: 0 });
    expect(fitStatusRow({ room: 83, fixed: 0, gap, forms: [10], widths: [70] }).count).toBe(0);
    // No name: the rule of visibleStatusCount, figures first.
    expect(fitStatusRow({ room: 186, fixed, gap, forms: [], widths: [70] })).toEqual({ count: 1, form: 0 });
    expect(fitStatusRow({ room: 185, fixed, gap, forms: [], widths: [70] })).toEqual({ count: 0, form: 0 });
    expect(fitStatusRow({ room: 100, fixed: 0, gap, forms: [], widths: [70] })).toEqual({ count: 1, form: 0 });
  });
});
