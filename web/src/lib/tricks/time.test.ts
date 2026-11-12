import { describe, expect, it } from "vitest";

import { clockText, dayText, momentText, trickTimeText } from "./time";

// THE WORDS OF A TIME, PAST THE RANGE `Date` HOLDS (M94 review): an instant beyond 8.64e15 ms makes
// `Intl.DateTimeFormat` throw a RangeError, so the words stand down to nothing instead.

const NOW = Date.parse("2026-11-08T09:41:00Z");

describe("a time past the range of Date", () => {
  it("reads as no words, and never throws", () => {
    for (const clock of ["ago", "elapsed", "left", "time"] as const) {
      expect(() => clockText("9999999999999999", clock, NOW)).not.toThrow();
      expect(clockText("9999999999999999", clock, NOW)).toBeNull();
    }
    expect(momentText(8.64e15 + 1)).toBe("");
    expect(dayText(Number.NaN)).toBe("");
    expect(trickTimeText("+275760-09-13T00:00:00.001Z", "ago", NOW)).toBeNull();
  });

  it("still reads an instant at the bound", () => {
    expect(clockText("8640000000000000", "left", NOW)).not.toBeNull();
    expect(momentText(NOW)).not.toBe("");
  });
});
