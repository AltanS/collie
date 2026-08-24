import { describe, expect, it } from "vitest";

import { PULL_MAX_PX, PULL_TRIGGER_PX, pullOffset } from "./use-pull-to-refresh";

// The whole feel of the gesture is `pullOffset` plus two numbers, so that is what is pinned. A
// jsdom "touch" is a synthesised event over an element whose `scrollTop` nothing can move, which
// would prove the mock rather than the gesture — the interaction itself is proved on a phone.

describe("pullOffset — resistance, a clamp, and one direction", () => {
  it("an upward drag opens nothing: a scroll with nowhere to go is not a pull", () => {
    expect(pullOffset(-40)).toBe(0);
    expect(pullOffset(0)).toBe(0);
  });

  it("halves the finger's travel, which is what makes the pull feel deliberate", () => {
    expect(pullOffset(40)).toBe(20);
    expect(pullOffset(PULL_TRIGGER_PX * 2)).toBe(PULL_TRIGGER_PX);
  });

  it("the trigger is reached only after the finger has moved twice as far", () => {
    expect(pullOffset(PULL_TRIGGER_PX * 2 - 2)).toBeLessThan(PULL_TRIGGER_PX);
    expect(pullOffset(PULL_TRIGGER_PX * 2)).toBeGreaterThanOrEqual(PULL_TRIGGER_PX);
  });

  it("clamps, so a hard pull holds the indicator open rather than stretching the page", () => {
    expect(pullOffset(10_000)).toBe(PULL_MAX_PX);
  });

  it("the indicator can open past the trigger — the operator must see they have gone far enough", () => {
    expect(PULL_MAX_PX).toBeGreaterThan(PULL_TRIGGER_PX);
  });
});
