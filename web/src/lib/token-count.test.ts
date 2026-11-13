import { describe, expect, it } from "vitest";

import { formatTokens } from "./token-count";

describe("formatTokens", () => {
  it("writes the plain number under a thousand, whole thousands under a million, and millions with one decimal", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    // The live Fable session of the 2026-11-13 report: 2 + 1,913 + 220,285.
    expect(formatTokens(222_200)).toBe("222k");
    expect(formatTokens(999_499)).toBe("999k");
    expect(formatTokens(999_500)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(10_050_000)).toBe("10.1M");
  });

  it("writes nothing for a value that is no count", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatTokens(bad)).toBeNull();
  });
});
