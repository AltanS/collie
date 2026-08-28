import { describe, expect, it } from "vitest";

import { AUTH, DEGRADED, OUTAGE, UPDATE } from "./strip-priority";

// Pin the ORDER, not the literal numbers. A test asserting AUTH === 40 breaks the moment someone
// inserts a level in a gap — which is the whole point of leaving gaps — and teaches the reader
// nothing about why. What must hold is the ranking StripHost relies on, and that every level is
// distinct so two facts never tie.
describe("strip priority table", () => {
  it("ranks AUTH above OUTAGE above DEGRADED above UPDATE", () => {
    expect(AUTH).toBeGreaterThan(OUTAGE);
    expect(OUTAGE).toBeGreaterThan(DEGRADED);
    expect(DEGRADED).toBeGreaterThan(UPDATE);
  });

  it("gives every level a distinct value", () => {
    const levels = [AUTH, OUTAGE, DEGRADED, UPDATE];
    expect(new Set(levels).size).toBe(levels.length);
  });
});
