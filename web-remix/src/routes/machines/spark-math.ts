// The geometry of a machine card's spark, ported from web/src/components/machine-spark.tsx (whose
// file also holds React, so its pure half cannot be imported). A tiny area under a line, no axes, on
// a FIXED 0 to 100 % scale: the height of the right end is how full the machine is, and two machines'
// sparks compare at a glance. The x axis is always the minutes asked for plus the reading now at the
// right edge. `null` is a minute with no reading: the line stops there and starts again after it.

/** viewBox units. The svg stretches to its box (`preserveAspectRatio="none"`); strokes do not. */
export const SPARK_W = 100;
export const SPARK_H = 32;
/** Keeps a 100 % line inside the box, so its round cap is not cut by the top edge. */
const PAD_Y = 1.5;

export type SparkTone = "normal" | "firing" | "quiet";

export function yOf(v: number): number {
  const f = Math.min(1, Math.max(0, v));
  return PAD_Y + (1 - f) * (SPARK_H - 2 * PAD_Y);
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The runs of consecutive values, each as `[x, y]` pairs in viewBox units. The minutes take slots
 * `0..minutes-1`, newest last, and the reading now takes slot `minutes`, the right edge. A value
 * array longer than `minutes` keeps its newest `minutes`.
 */
export function sparkRuns(values: readonly (number | null)[], minutes: number, now: number | null = null): [number, number][][] {
  const slots = Math.max(1, minutes);
  const shown = values.length > slots ? values.slice(values.length - slots) : values;
  const series: (number | null)[] = [...shown, now];
  const offset = slots - shown.length;
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (const [i, v] of series.entries()) {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push([round(((offset + i) / slots) * SPARK_W), round(yOf(v))]);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export function linePath(run: readonly [number, number][]): string {
  const first = run[0];
  if (first === undefined) return "";
  // One minute between two gaps is a zero-length segment, which the round cap draws as a dot.
  if (run.length === 1) return `M${String(first[0])} ${String(first[1])}L${String(first[0])} ${String(first[1])}`;
  return run.map(([x, y], i) => `${i === 0 ? "M" : "L"}${String(x)} ${String(y)}`).join("");
}

export function areaPath(run: readonly [number, number][]): string {
  const first = run[0];
  const last = run.at(-1);
  if (first === undefined || last === undefined || run.length < 2) return "";
  return `${linePath(run)}L${String(last[0])} ${String(SPARK_H)}L${String(first[0])} ${String(SPARK_H)}Z`;
}
