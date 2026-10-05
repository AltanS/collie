// The geometry of the Machines charts, as pure functions. The SVG component draws what these return
// and decides nothing: where a line breaks, what the axis tops out at and what the summary sentence
// says are all testable without a DOM.
//
// ── A GAP IS A GAP ───────────────────────────────────────────────────────────
// History arrives as one point per minute with the missing minutes simply absent (a lead that
// restarted, a machine that went quiet). A line drawn straight through them would invent load that
// nobody measured, so a run ends at a missing minute and the next point starts a new one. A `null`
// network value (a platform with no counters) breaks a run the same way.
//
// ── EVERY AGE IS AGAINST THE ANSWER'S `ts` ───────────────────────────────────
// The x axis ends at the history answer's own `ts`, never at `Date.now()`: the points are stamped on
// the answering bridge's clock, and a phone a few minutes off would otherwise draw the whole chart
// shifted (the argument lib/host-health.ts makes for every other age in the app).

import type { MachineHistoryPoint, MachineHistoryResponse } from "./types";

/** The two ranges the detail page switches between. */
export type MachineRange = "hour" | "day";

export const RANGE_MS = {
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
} satisfies Record<MachineRange, number>;

/** One drawable value: an epoch-ms time and a number. */
export interface RunPoint {
  t: number;
  v: number;
}

/** The plot area inside the SVG's viewBox, in viewBox units. */
export interface PlotBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The width the charts are laid out at before they are measured, and in a test with no layout. */
export const CHART_BASE_WIDTH = 360;
/** The shape a chart keeps while it has room: 360 wide by 150 high. */
const CHART_BASE_HEIGHT = 150;
/** The tallest a chart gets, however wide its column. A tablet column is twice a phone's, and a plot
 *  twice as tall says nothing more about a line that moves a few percent. */
export const CHART_MAX_HEIGHT = 200;
/** The shortest, for a column narrower than a phone. */
const CHART_MIN_HEIGHT = 120;

/**
 * The height, in CSS pixels, of a chart drawn `width` pixels wide. The phone shape (150 high at 360
 * wide) while the column is about that wide, growing with it up to {@link CHART_MAX_HEIGHT}. The
 * drawing is made at its real pixel size, so its type and strokes do not scale with the width.
 */
export function chartHeight(width: number): number {
  const proportional = Math.round((width * CHART_BASE_HEIGHT) / CHART_BASE_WIDTH);
  return Math.min(CHART_MAX_HEIGHT, Math.max(CHART_MIN_HEIGHT, proportional));
}

/** The share of the plot, from its top, within which the alert label flips under its line. */
const LABEL_FLIP_FRACTION = 0.12;

/**
 * Which side of the dashed alert line its label plate sits on. Above, where the data under a high
 * line is usually absent; below when the line is within the top 12% of the plot, where there is no
 * room above it inside the drawing. `lineY` is the line's y in the box's own units.
 */
export function thresholdLabelSide(lineY: number, box: PlotBox): "above" | "below" {
  const plot = box.height - box.top - box.bottom;
  if (plot <= 0) return "above";
  return (lineY - box.top) / plot < LABEL_FLIP_FRACTION ? "below" : "above";
}

/** A missing minute breaks a run; 1.5 steps tolerates a sample that landed a few seconds late. */
const GAP_STEPS = 1.5;

/** The points inside the window that ends at `ts`. */
export function pointsInRange(points: readonly MachineHistoryPoint[], ts: number, range: MachineRange): MachineHistoryPoint[] {
  const from = ts - RANGE_MS[range];
  return points.filter((p) => p[0] >= from && p[0] <= ts);
}

/**
 * Contiguous runs of one series. `pick` reads the value out of a point; `null` (or a non-finite
 * number) ends the current run, and so does a jump of more than 1.5 steps between two points.
 */
export function runsOf(
  points: readonly MachineHistoryPoint[],
  pick: (p: MachineHistoryPoint) => number | null,
  stepMs: number,
): RunPoint[][] {
  const runs: RunPoint[][] = [];
  let current: RunPoint[] = [];
  let lastT: number | null = null;
  for (const p of points) {
    const v = pick(p);
    const usable = v !== null && Number.isFinite(v);
    const broken = lastT !== null && p[0] - lastT > stepMs * GAP_STEPS;
    if (!usable || broken) {
      if (current.length > 0) runs.push(current);
      current = [];
    }
    if (usable) current.push({ t: p[0], v });
    lastT = usable ? p[0] : null;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** The viewBox x of a time, with the window's left edge at `ts - rangeMs` and its right edge at `ts`. */
export function xOf(t: number, ts: number, range: MachineRange, box: PlotBox): number {
  const span = RANGE_MS[range];
  const frac = (t - (ts - span)) / span;
  return box.left + Math.min(1, Math.max(0, frac)) * (box.width - box.left - box.right);
}

/** The viewBox y of a value on a 0..`max` axis, 0 at the bottom of the plot. */
export function yOf(v: number, max: number, box: PlotBox): number {
  const frac = max <= 0 ? 0 : Math.min(1, Math.max(0, v / max));
  return box.top + (1 - frac) * (box.height - box.top - box.bottom);
}

/** One decimal at most: a path with twelve digits per coordinate is a heavier DOM for no sharper line. */
function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * The path of one run. A run of ONE point is a zero-length segment, which a round line cap draws as a
 * dot: an isolated minute between two gaps must still be visible.
 */
export function linePath(run: readonly RunPoint[], x: (t: number) => number, y: (v: number) => number): string {
  const first = run[0];
  if (first === undefined) return "";
  if (run.length === 1) return `M${n(x(first.t))} ${n(y(first.v))}L${n(x(first.t))} ${n(y(first.v))}`;
  return run.map((p, i) => `${i === 0 ? "M" : "L"}${n(x(p.t))} ${n(y(p.v))}`).join("");
}

/**
 * The band between the CPU average and its maximum, for the runs where both exist. Closed polygon:
 * the maximum left to right, then the average back. Runs of one point have no width and give nothing.
 */
export function bandPath(
  upper: readonly RunPoint[],
  lower: readonly RunPoint[],
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  if (upper.length < 2 || lower.length < 2) return "";
  const forward = upper.map((p, i) => `${i === 0 ? "M" : "L"}${n(x(p.t))} ${n(y(p.v))}`).join("");
  const back = lower.toReversed().map((p) => `L${n(x(p.t))} ${n(y(p.v))}`).join("");
  return `${forward}${back}Z`;
}

/** Latest, mean and peak of every point across a series' runs, or `null` when there is nothing to say. */
export interface SeriesSummary {
  latest: number;
  mean: number;
  peak: number;
}

export function summarize(runs: readonly (readonly RunPoint[])[]): SeriesSummary | null {
  let count = 0;
  let sum = 0;
  let peak = 0;
  let latest: RunPoint | null = null;
  for (const run of runs) {
    for (const p of run) {
      count += 1;
      sum += p.v;
      if (p.v > peak) peak = p.v;
      if (latest === null || p.t >= latest.t) latest = p;
    }
  }
  if (latest === null) return null;
  return { latest: latest.v, mean: sum / count, peak };
}

/** The largest value in any run, or 0. */
export function maxOf(runs: readonly (readonly RunPoint[])[]): number {
  let max = 0;
  for (const run of runs) for (const p of run) if (p.v > max) max = p.v;
  return max;
}

/** What one x tick says: how far back, in the range's own unit, or "now" for the right edge. */
export type XTick = { frac: number; kind: "now" } | { frac: number; kind: "minutes" | "hours"; count: number };

/** Three ticks per range: both ends and the middle. */
export function xTicks(range: MachineRange): XTick[] {
  if (range === "hour") {
    return [
      { frac: 0, kind: "minutes", count: 60 },
      { frac: 0.5, kind: "minutes", count: 30 },
      { frac: 1, kind: "now" },
    ];
  }
  return [
    { frac: 0, kind: "hours", count: 24 },
    { frac: 0.5, kind: "hours", count: 12 },
    { frac: 1, kind: "now" },
  ];
}

/** A day: the most the history answer holds, and what a merged answer is cut to. */
const DAY_MS = RANGE_MS.day;

/**
 * Fold a later history answer into the one the page holds. The page reads the whole day once, then
 * asks only for the minutes from its newest point on (`?since=`), and that answer replaces every
 * point it covers: the newest minute was still filling when it was read last time. Points a day or
 * more older than the new answer's `ts` go. An answer that ignored `since` (it holds the whole day)
 * simply replaces everything, so the merge is right either way.
 */
export function mergeHistory(prev: MachineHistoryResponse | null, next: MachineHistoryResponse): MachineHistoryResponse {
  if (prev === null) return next;
  const first = next.points[0]?.[0] ?? Number.POSITIVE_INFINITY;
  const floor = next.ts - DAY_MS;
  // A held point later than the answer's own `ts` (plus the minute still filling) is from a clock or a
  // history the server no longer has, and an empty answer would otherwise keep it for a whole day.
  const ceiling = next.ts + DAY_MS / 1440;
  const kept = prev.points.filter((p) => p[0] < first && p[0] > floor && p[0] <= ceiling);
  return { ts: next.ts, stepMs: next.stepMs, points: kept.length === 0 ? next.points : [...kept, ...next.points] };
}

/** Where the next incremental read starts: the newest point the page holds, or the whole day. */
export function sinceOf(history: MachineHistoryResponse | null): number | undefined {
  return history?.points.at(-1)?.[0];
}
