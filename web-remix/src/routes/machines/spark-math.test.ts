import { describe, expect, test } from "bun:test";

import { areaPath, linePath, sparkRuns } from "./spark-math";

describe("sparkRuns", () => {
  test("values sit against the right edge and the reading now takes the last slot", () => {
    const runs = sparkRuns([0.5, 0.5], 4, 0.5);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.map(([x]) => x)).toEqual([50, 75, 100]);
  });
  test("a null minute splits the line", () => {
    expect(sparkRuns([0.2, null, 0.4], 3)).toHaveLength(2);
  });
  test("a longer array keeps its newest minutes", () => {
    expect(sparkRuns([0.1, 0.2, 0.3, 0.4], 2)[0]).toHaveLength(2);
  });
  test("no values and no reading draw nothing", () => {
    expect(sparkRuns([], 30, null)).toEqual([]);
  });
});

describe("paths", () => {
  test("one point is a zero-length segment, with no area", () => {
    const run: [number, number][] = [[10, 5]];
    expect(linePath(run)).toBe("M10 5L10 5");
    expect(areaPath(run)).toBe("");
  });
  test("two points close their area at the floor", () => {
    const run: [number, number][] = [[0, 10], [100, 20]];
    expect(areaPath(run)).toBe("M0 10L100 20L100 32L0 32Z");
  });
});
