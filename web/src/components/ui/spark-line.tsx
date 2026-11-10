import { cn } from "@/lib/utils";

// A TREND AS A SMALL LINE (2026-11-10). A few numbers, oldest first, drawn as one line from the lowest to
// the highest across the box, with the last point marked: no axes, no grid, no area. It answers "which
// way is it going, and where is it now", and nothing more; the words around it carry the figures. The
// machine card's spark (`machine-spark.tsx`) is the other one in the app, on a fixed 0 to 100% scale with
// gaps; this one scales to its own numbers, so a line of five timings fills its box.
//
// The ink is the caller's, through `currentColor`. A screen reader hears `label`, which the caller writes
// with the lowest, the highest and the last figure in it. The svg stretches to its box; the stroke and
// the last point keep their width (`non-scaling-stroke`).

/** viewBox units. */
const W = 100;
const H = 24;
/** Keeps the highest and the lowest point inside the box, so a round cap is not cut by the edge. */
const PAD = 3;

/** The points of a line, in viewBox units: evenly across, the lowest value at the bottom and the highest at the top; flat in the middle when all are equal. */
export function sparkPoints(values: readonly number[]): [number, number][] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [];
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  const step = finite.length === 1 ? 0 : W / (finite.length - 1);
  return finite.map((v, i) => [round(i * step), round(span === 0 ? H / 2 : PAD + (1 - (v - min) / span) * (H - 2 * PAD))]);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function SparkLine({ values, label, className }: { values: readonly number[]; label: string; className?: string }) {
  const points = sparkPoints(values);
  const last = points.at(-1);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${String(W)} ${String(H)}`} preserveAspectRatio="none" className={cn("block h-6 w-full overflow-visible", className)}>
      {points.length > 1 && (
        <polyline
          points={points.map(([x, y]) => `${String(x)},${String(y)}`).join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* The last point: a zero-length line, which the round cap draws as a dot the stretch cannot squash. */}
      {last !== undefined && (
        <path data-slot="spark-line-last" d={`M${String(last[0])} ${String(last[1])}L${String(last[0])} ${String(last[1])}`} stroke="currentColor" strokeWidth={5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
