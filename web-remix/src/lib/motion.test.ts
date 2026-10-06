import { describe, expect, test } from "bun:test";

import { MOTION, peekContinueTransition, snapBackTransition, springSettling, toastEntrance } from "./motion";

describe("motion timings match web/", () => {
  test("the sheet snap-back is web's transform 0.2s ease-out, not the snappy spring", () => {
    expect(snapBackTransition()).toBe("transform 200ms ease-out");
    expect(MOTION.snapBack).toEqual({ ms: 200, easing: "ease-out" });
  });

  test("the peek continuation is 180 ms ease-out", () => {
    expect(peekContinueTransition()).toBe("transform 180ms ease-out");
  });

  test("the toast fades in over 200 ms on `ease` (reduced motion is off under bun)", () => {
    expect(toastEntrance()).toEqual({ opacity: 0, duration: 200, easing: "ease" });
  });

  test("springSettling settles in the asked time, where the preset names run longer", () => {
    for (const ms of [120, 200, 240, 350]) {
      const settled = springSettling(ms).duration;
      expect(Math.abs(settled - ms)).toBeLessThanOrEqual(25);
    }
    expect(springSettling(200)).toBe(springSettling(200));
  });
});
