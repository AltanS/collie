import { memo } from "react";

import { cn } from "@/lib/utils";

// A machine's last half hour of one metric, as a tiny hand-made SVG: an area under a line, no axes.
// It sits under a metric's number on a machine card (the Machines list and the dashboard's Crew tab).
//
// ── THE SCALE IS FIXED, SO A SPARK IS ALSO A BAR ─────────────────────────────
// The y axis is always 0 to 100 %, so the height of the line's right end says how full the machine
// is the way the old bar did, and two machines' sparks compare at a glance. The x axis is always the
// minutes asked for (30) plus the reading now at the right edge: a machine watched for five minutes
// draws five minutes at the right, not a line stretched across the card. The reading now is a dot at
// the right edge, joined to the last complete minute, so a machine with no complete minute yet still
// shows where it stands.
//
// ── A GAP IS A GAP ───────────────────────────────────────────────────────────
// `null` is a minute with no reading. The line stops there and starts again after it, as on the big
// charts (`lib/machine-chart.ts`), so a spark never draws load nobody measured.
//
// ── IT DRAWS ONLY WHEN ITS DATA MOVES ────────────────────────────────────────
// Memoised on its props. The census keeps the identity of every row that did not change
// (`keepCensusIdentity` in lib/loaders.ts), and a spark's values are complete minutes only, so on a
// poll tick between two minutes no spark renders at all.

/** viewBox units. The svg stretches to its box (`preserveAspectRatio="none"`); strokes do not. */
const W = 100;
const H = 32;
/** Keeps a 100 % line inside the box, so its round cap is not cut by the top edge. */
const PAD_Y = 1.5;

export type SparkTone = "normal" | "firing" | "quiet";

export interface MachineSparkProps {
  /** Oldest first, one per minute, `null` for a minute with no reading. Fractions 0..1. */
  values: readonly (number | null)[];
  /** How many minutes the x axis spans. Values are drawn against its right edge. */
  minutes: number;
  /** The reading now, drawn as a dot at the right edge. `null` draws no dot. */
  now?: number | null;
  /** The alert rule's line as a fraction, drawn faint and dashed; none when no rule is set. */
  threshold?: number | null;
  tone: SparkTone;
  /** The whole sentence a screen reader gets in place of the drawing. */
  label: string;
  className?: string;
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
  series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    const x = ((offset + i) / slots) * W;
    run.push([round(x), round(yOf(v))]);
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

function yOf(v: number): number {
  const f = Math.min(1, Math.max(0, v));
  return PAD_Y + (1 - f) * (H - 2 * PAD_Y);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function linePath(run: readonly [number, number][]): string {
  const [x0, y0] = run[0]!;
  // One minute between two gaps is a zero-length segment, which the round cap draws as a dot.
  if (run.length === 1) return `M${x0} ${y0}L${x0} ${y0}`;
  return run.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join("");
}

function areaPath(run: readonly [number, number][]): string {
  if (run.length < 2) return "";
  const first = run[0]!;
  const last = run.at(-1)!;
  return `${linePath(run)}L${last[0]} ${H}L${first[0]} ${H}Z`;
}

const TONE = {
  normal: "text-status-info",
  firing: "text-status-blocked",
  quiet: "text-muted-foreground",
} as const satisfies Record<SparkTone, string>;

function MachineSparkImpl({ values, minutes, now = null, threshold = null, tone, label, className }: MachineSparkProps) {
  const runs = sparkRuns(values, minutes, now);
  const dot = now === null || !Number.isFinite(now) ? null : yOf(now);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("block h-8 w-full overflow-visible", TONE[tone], className)}
    >
      {/* The floor: a hairline the eye reads the height against, drawn in every state, empty too. */}
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {threshold !== null && (
        <line
          x1={0}
          x2={W}
          y1={yOf(threshold)}
          y2={yOf(threshold)}
          data-series="threshold"
          className="stroke-status-working opacity-60"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {runs.map((run) => {
        const area = areaPath(run);
        return area === "" ? null : <path key={`a${run[0]![0]}`} d={area} className="fill-current opacity-15" />;
      })}
      {runs.map((run) => (
        <path
          key={`l${run[0]![0]}`}
          d={linePath(run)}
          data-series="line"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {dot !== null && (
        // The reading now. A zero-length segment with a round cap: a circle in a stretched viewBox
        // would turn into an ellipse, a non-scaling stroke cap stays round.
        <path
          d={`M${W} ${round(dot)}L${W} ${round(dot)}`}
          data-series="now"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

/** Memoised: a poll tick that brings the same minutes draws nothing (the header says why). */
export const MachineSpark = memo(MachineSparkImpl);
