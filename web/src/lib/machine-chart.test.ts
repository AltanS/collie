import { bandPath, CHART_MAX_HEIGHT, chartHeight, linePath, maxOf, pointsInRange, runsOf, summarize, thresholdLabelSide, xOf, xTicks, yOf, mergeHistory, sinceOf, type PlotBox } from "./machine-chart";
import type { MachineHistoryPoint } from "./types";

const STEP = 60_000;
const TS = 10_000_000;

/** A point `ago` minutes before TS, with a cpu average of `cpu`. */
function at(ago: number, cpu: number, rx: number | null = null): MachineHistoryPoint {
  return [TS - ago * STEP, cpu, Math.min(1, cpu + 0.1), 0.4, rx, rx === null ? null : rx / 2];
}

const BOX: PlotBox = { width: 360, height: 140, left: 30, right: 6, top: 6, bottom: 20 };

describe("runsOf", () => {
  it("keeps consecutive minutes in one run", () => {
    const runs = runsOf([at(3, 0.1), at(2, 0.2), at(1, 0.3)], (p) => p[1], STEP);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  it("ends a run at a missing minute and starts another after it", () => {
    // Minutes 5, 4, then nothing for 3 and 2, then 1: two runs, no line across the hole.
    const runs = runsOf([at(5, 0.1), at(4, 0.2), at(1, 0.3)], (p) => p[1], STEP);
    expect(runs.map((r) => r.length)).toEqual([2, 1]);
  });

  it("tolerates a sample that landed a few seconds late", () => {
    const late: MachineHistoryPoint = [TS - 2 * STEP + 20_000, 0.2, 0.3, 0.4, null, null];
    expect(runsOf([at(3, 0.1), late], (p) => p[1], STEP)).toHaveLength(1);
  });

  it("breaks on a null network value and resumes after it", () => {
    const runs = runsOf([at(4, 0.1, 100), at(3, 0.1, 200), at(2, 0.1), at(1, 0.1, 300)], (p) => p[4], STEP);
    expect(runs.map((r) => r.length)).toEqual([2, 1]);
  });

  it("returns no run for a series that is never reported", () => {
    expect(runsOf([at(2, 0.1), at(1, 0.1)], (p) => p[4], STEP)).toEqual([]);
  });

  it("ignores a value that is not a finite number", () => {
    expect(runsOf([at(2, Number.NaN), at(1, 0.2)], (p) => p[1], STEP).map((r) => r.length)).toEqual([1]);
  });
});

describe("pointsInRange", () => {
  it("keeps the last hour of a day of points", () => {
    const day = Array.from({ length: 200 }, (_, i) => at(199 - i, 0.1));
    expect(pointsInRange(day, TS, "hour")).toHaveLength(61);
    expect(pointsInRange(day, TS, "day")).toHaveLength(200);
  });
});

describe("the scales", () => {
  it("puts the window's right edge at ts and its left edge a range before", () => {
    expect(xOf(TS, TS, "hour", BOX)).toBe(BOX.width - BOX.right);
    expect(xOf(TS - 3_600_000, TS, "hour", BOX)).toBe(BOX.left);
    expect(xOf(TS - 3_600_000, TS, "day", BOX)).toBeGreaterThan(xOf(TS - 7_200_000, TS, "day", BOX));
  });

  it("clamps a time outside the window", () => {
    expect(xOf(TS + 99_999_999, TS, "hour", BOX)).toBe(BOX.width - BOX.right);
  });

  it("maps 0 to the bottom of the plot and the maximum to its top", () => {
    expect(yOf(0, 1, BOX)).toBe(BOX.height - BOX.bottom);
    expect(yOf(1, 1, BOX)).toBe(BOX.top);
    expect(yOf(0.5, 1, BOX)).toBe((BOX.top + BOX.height - BOX.bottom) / 2);
    expect(yOf(5, 1, BOX)).toBe(BOX.top);
  });
});

describe("linePath", () => {
  const x = (t: number) => (t - (TS - 10 * STEP)) / STEP;
  const y = (v: number) => 100 - v * 100;

  it("draws one subpath per run", () => {
    const runs = runsOf([at(5, 0.1), at(4, 0.2), at(1, 0.3)], (p) => p[1], STEP);
    const d = runs.map((r) => linePath(r, x, y)).join("");
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it("draws a lone minute as a zero-length segment, which a round cap shows as a dot", () => {
    const d = linePath([{ t: TS, v: 0.5 }], x, y);
    expect(d).toMatch(/^M[\d.]+ [\d.]+L[\d.]+ [\d.]+$/);
    const [from, to] = d.slice(1).split("L");
    expect(from).toBe(to);
  });

  it("is empty for an empty run", () => {
    expect(linePath([], x, y)).toBe("");
  });
});

describe("bandPath", () => {
  const x = (t: number) => t / STEP;
  const y = (v: number) => v;

  it("closes a polygon over the two lines", () => {
    const upper = [{ t: 0, v: 8 }, { t: STEP, v: 9 }];
    const lower = [{ t: 0, v: 2 }, { t: STEP, v: 3 }];
    expect(bandPath(upper, lower, x, y)).toBe("M0 8L1 9L1 3L0 2Z");
  });

  it("draws nothing for a lone point", () => {
    expect(bandPath([{ t: 0, v: 8 }], [{ t: 0, v: 2 }], x, y)).toBe("");
  });
});

describe("summarize and maxOf", () => {
  it("reads latest, mean and peak across runs", () => {
    const runs = runsOf([at(5, 0.2), at(4, 0.4), at(1, 0.6)], (p) => p[1], STEP);
    const s = summarize(runs);
    expect(s?.latest).toBeCloseTo(0.6);
    expect(s?.mean).toBeCloseTo(0.4);
    expect(s?.peak).toBeCloseTo(0.6);
    expect(maxOf(runs)).toBeCloseTo(0.6);
  });

  it("says nothing for no data", () => {
    expect(summarize([])).toBeNull();
    expect(maxOf([])).toBe(0);
  });
});

describe("xTicks", () => {
  it("labels both ends and the middle of each range", () => {
    expect(xTicks("hour").map((t) => t.frac)).toEqual([0, 0.5, 1]);
    expect(xTicks("hour")[0]).toEqual({ frac: 0, kind: "minutes", count: 60 });
    expect(xTicks("day")[1]).toEqual({ frac: 0.5, kind: "hours", count: 12 });
    expect(xTicks("day")[2]).toEqual({ frac: 1, kind: "now" });
  });
});

describe("mergeHistory", () => {
  const M = 60_000;
  const answer = (ts: number, ...times: number[]) => ({
    ts,
    stepMs: M,
    points: times.map((t): MachineHistoryPoint => [t, 0.1, 0.2, 0.3, null, null]),
  });

  it("takes the first answer whole", () => {
    const first = answer(10 * M, 8 * M, 9 * M);
    expect(mergeHistory(null, first)).toBe(first);
  });

  it("replaces the minutes the later answer covers and appends the new ones", () => {
    const held = answer(10 * M, 7 * M, 8 * M, 9 * M);
    const later = answer(11 * M, 9 * M, 10 * M);
    later.points[0]![1] = 0.9;
    const merged = mergeHistory(held, later);
    expect(merged.ts).toBe(11 * M);
    expect(merged.points.map((p) => p[0])).toEqual([7 * M, 8 * M, 9 * M, 10 * M]);
    expect(merged.points[2]![1]).toBe(0.9);
  });

  it("drops what fell out of the day", () => {
    const DAY = 24 * 60 * M;
    const held = answer(DAY, 0, M, 2 * M);
    // A point exactly a day older than the new `ts` has left the window too.
    const merged = mergeHistory(held, answer(DAY + 1.5 * M, DAY + M));
    expect(merged.points.map((p) => p[0])).toEqual([2 * M, DAY + M]);
  });

  it("keeps the held day when the later answer has no new minute", () => {
    const held = answer(10 * M, 8 * M, 9 * M);
    const merged = mergeHistory(held, answer(10 * M + 5_000));
    expect(merged.points.map((p) => p[0])).toEqual([8 * M, 9 * M]);
    expect(merged.ts).toBe(10 * M + 5_000);
  });

  it("an empty later answer still drops held points from after its own clock", () => {
    const held = answer(20 * M, 8 * M, 9 * M, 19 * M, 20 * M);
    // The server's clock stepped back to minute 10: the points at 19 and 20 are from a future it lost.
    const merged = mergeHistory(held, answer(10 * M + 5_000));
    expect(merged.points.map((p) => p[0])).toEqual([8 * M, 9 * M]);
    // The minute still filling (up to a minute past `ts`) stays.
    expect(mergeHistory(answer(10 * M, 9 * M, 11 * M), answer(10 * M + 5_000)).points.map((p) => p[0])).toEqual([9 * M, 11 * M]);
    expect(mergeHistory(answer(10 * M, 9 * M, 11 * M + 6_000), answer(10 * M + 5_000)).points.map((p) => p[0])).toEqual([9 * M]);
  });

  it("asks from the newest point it holds, or for the whole day", () => {
    expect(sinceOf(null)).toBeUndefined();
    expect(sinceOf(answer(10 * M))).toBeUndefined();
    expect(sinceOf(answer(10 * M, 8 * M, 9 * M))).toBe(9 * M);
  });
});

describe("thresholdLabelSide", () => {
  const box: PlotBox = { width: 360, height: 150, left: 34, right: 8, top: 8, bottom: 22 };
  // The plot runs from y 8 to y 128, 120 tall: the top 12% is the first 14.4 of it, down to y 22.4.
  const lineAt = (fraction: number) => yOf(fraction, 1, box);

  it("puts the label above the line, where there is room", () => {
    expect(thresholdLabelSide(lineAt(0.8), box)).toBe("above");
    expect(thresholdLabelSide(lineAt(0.5), box)).toBe("above");
    expect(thresholdLabelSide(lineAt(0.2), box)).toBe("above");
  });

  it("flips the label under the line when the line is within the top 12% of the plot", () => {
    expect(thresholdLabelSide(lineAt(1), box)).toBe("below");
    expect(thresholdLabelSide(lineAt(0.95), box)).toBe("below");
    // 90% is 10% of the plot from the top, so it flips too; 85% is 15% and does not.
    expect(thresholdLabelSide(lineAt(0.9), box)).toBe("below");
    expect(thresholdLabelSide(lineAt(0.85), box)).toBe("above");
  });

  it("switches at 12% of the plot from its top", () => {
    const edge = box.top + 0.12 * (box.height - box.top - box.bottom);
    expect(thresholdLabelSide(edge - 0.1, box)).toBe("below");
    expect(thresholdLabelSide(edge + 0.1, box)).toBe("above");
  });

  it("a plot with no height never flips", () => {
    expect(thresholdLabelSide(8, { ...box, height: 30 })).toBe("above");
  });
});

describe("chartHeight", () => {
  it("keeps the phone shape at the phone's width", () => {
    expect(chartHeight(360)).toBe(150);
    expect(chartHeight(358)).toBe(149);
  });

  it("grows with the column and stops at the cap on a tablet", () => {
    expect(chartHeight(480)).toBe(200);
    expect(chartHeight(788)).toBe(CHART_MAX_HEIGHT);
    expect(chartHeight(1400)).toBe(CHART_MAX_HEIGHT);
  });

  it("does not go flat in a narrow column", () => {
    expect(chartHeight(200)).toBe(120);
  });
});
