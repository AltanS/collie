import { describe, expect, it } from "vitest";

import { ROW_LOOK_MS, TOUCH_ARM_MS } from "./use-row-drag";

// THE WIDE LAYOUT'S ROW GESTURE (review 1, finding 4). Its look must come before its drag arms: the look moved to
// 250ms for the Dashboard row's long press, and this gesture must not follow it past its own 220ms arm.
describe("use-row-drag timing", () => {
  it("the hold look comes before the touch drag arms", () => {
    expect(ROW_LOOK_MS).toBe(150);
    expect(TOUCH_ARM_MS).toBe(220);
    expect(ROW_LOOK_MS).toBeLessThan(TOUCH_ARM_MS);
  });
});
