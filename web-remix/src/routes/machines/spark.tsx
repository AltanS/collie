// A machine's last half hour of one metric as a tiny hand-made SVG (web/src/components/machine-spark.tsx).
// The geometry is `spark-math.ts`; this draws it. It re-renders only when its parent does, and a card's parent
// re-renders on a poll only when the row's identity moved (`data.ts` keeps identities), so a tick between
// two minutes draws no spark.
import type { Handle } from "remix/component";

import { cn } from "@web/lib/utils";

import { SPARK_H, SPARK_W, areaPath, linePath, round, sparkRuns, yOf, type SparkTone } from "./spark-math";

export interface MachineSparkProps {
  /** Oldest first, one per minute, `null` for a minute with no reading. Fractions 0..1. */
  values: readonly (number | null)[];
  minutes: number;
  /** The reading now, a dot at the right edge. `null` draws no dot. */
  now?: number | null;
  /** The alert rule's line as a fraction, drawn faint and dashed. */
  threshold?: number | null;
  tone: SparkTone;
  /** The whole sentence a screen reader gets in place of the drawing. */
  label: string;
  class?: string;
}

const TONE = {
  normal: "text-status-info",
  firing: "text-status-blocked",
  quiet: "text-muted-foreground",
} as const satisfies Record<SparkTone, string>;

export function MachineSpark(handle: Handle<MachineSparkProps>) {
  return () => {
    const { values, minutes, now = null, threshold = null, tone, label } = handle.props;
    const runs = sparkRuns(values, minutes, now);
    const dot = now === null || !Number.isFinite(now) ? null : yOf(now);
    return (
      <svg
        role="img"
        aria-label={label}
        data-testid="machine-spark"
        viewBox={`0 0 ${String(SPARK_W)} ${String(SPARK_H)}`}
        preserveAspectRatio="none"
        class={cn("block h-8 w-full overflow-visible", TONE[tone], handle.props.class)}
      >
        {/* The floor: a hairline the eye reads the height against, drawn in every state, empty too. */}
        <line x1="0" x2={SPARK_W} y1={SPARK_H - 0.5} y2={SPARK_H - 0.5} class="stroke-border" stroke-width="1" vector-effect="non-scaling-stroke" />
        {threshold === null ? null : (
          <line
            x1="0"
            x2={SPARK_W}
            y1={yOf(threshold)}
            y2={yOf(threshold)}
            data-series="threshold"
            class="stroke-status-working opacity-60"
            stroke-width="1"
            stroke-dasharray="3 3"
            vector-effect="non-scaling-stroke"
          />
        )}
        {runs.map((run) => {
          const area = areaPath(run);
          return area === "" ? null : <path key={`a${String(run[0]?.[0])}`} d={area} class="fill-current opacity-15" />;
        })}
        {runs.map((run) => (
          <path
            key={`l${String(run[0]?.[0])}`}
            d={linePath(run)}
            data-series="line"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        ))}
        {dot === null ? null : (
          // The reading now: a zero-length segment with a round cap, so a stretched viewBox keeps it round.
          <path
            d={`M${String(SPARK_W)} ${String(round(dot))}L${String(SPARK_W)} ${String(round(dot))}`}
            data-series="now"
            stroke="currentColor"
            stroke-width="4"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        )}
      </svg>
    );
  };
}
