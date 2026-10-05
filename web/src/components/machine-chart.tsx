import { memo } from "react";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import {
  bandPath,
  linePath,
  maxOf,
  pointsInRange,
  runsOf,
  summarize,
  xOf,
  xTicks,
  yOf,
  type MachineRange,
  type PlotBox,
  type RunPoint,
  type XTick,
} from "@/lib/machine-chart";
import { formatBytesPerSecond, formatPercent, niceCeiling } from "@/lib/machine-units";
import type { MachineHistoryPoint } from "@/lib/types";

// One hand-made SVG chart. No chart library: the app ships none, and three lines, a band and a dashed
// rule do not need one. The geometry is `lib/machine-chart.ts` (pure, tested); this file draws it.
//
// ── ONE ACCESSIBLE SUMMARY PER CHART ─────────────────────────────────────────
// An SVG of paths says nothing to a screen reader. The `<svg>` is `role="img"` and its name is a
// sentence: the metric, the range, now, average and peak, and the alert line when a rule is set. The
// drawing is the same facts for the eye, and the legend under it names every mark in words, so the
// chart never relies on colour alone.
//
// ── THE SHAPE IS FIXED, SO NOTHING MOVES ─────────────────────────────────────
// The viewBox is 360 by 150 and the svg is `w-full h-auto`: at the 390px phone width the page gutter
// leaves 358px, so one viewBox unit is almost exactly one CSS pixel and the 10px axis text stays
// 10px. A state with no data renders a box of the same height (`ChartPlaceholder`), so a chart
// arriving never pushes the one under it down.

const VIEW_W = 360;
const VIEW_H = 150;

/** Percent charts: the y labels are short ("100%"), so the plot starts early and keeps the width. */
const BOX_PERCENT: PlotBox = { width: VIEW_W, height: VIEW_H, left: 34, right: 8, top: 8, bottom: 22 };
/** Network: "200 KB/s" is wider, so the left margin grows and the plot gives the width back. */
const BOX_RATE: PlotBox = { width: VIEW_W, height: VIEW_H, left: 56, right: 8, top: 8, bottom: 22 };

export type MachineChartKind = "cpu" | "mem" | "net";

export interface MachineChartProps {
  kind: MachineChartKind;
  points: readonly MachineHistoryPoint[];
  /** The history answer's own `ts`: the right edge of the chart. Never `Date.now()`. */
  ts: number;
  stepMs: number;
  range: MachineRange;
  /** The alert rule's `above` as a 0..1 fraction, or none when no rule is set. CPU and memory only. */
  threshold?: number | null;
}

const METRIC_KEY = { cpu: "machines.metric.cpu", mem: "machines.metric.mem", net: "machines.metric.net" } as const;

/** The same-height box a chart's place holds while there is nothing to draw. */
export function ChartPlaceholder({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center px-4 text-center text-sm text-muted-foreground" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}>
      {children}
    </div>
  );
}

function tickLabel(tick: XTick): string {
  if (tick.kind === "now") return t("machines.axis.now");
  return tick.kind === "minutes"
    ? t("machines.axis.minutesAgo", { count: tick.count })
    : t("machines.axis.hoursAgo", { count: tick.count });
}

// ── IT DRAWS WHEN ITS DATA MOVES, NOT ON THE POLL ────────────────────────────
// Memoised on its props, which are plain values or the history answer's own array. The page renders
// again on every poll tick (the census rides the loop), but the history moves once a minute, so the
// three charts of up to 1440 points draw once a minute, not every 4 to 6 seconds.

/** A chart, memoised: see the header. */
export const MachineChart = memo(function MachineChart({ kind, points, ts, stepMs, range, threshold = null }: MachineChartProps) {
  useLocale();
  const inRange = pointsInRange(points, ts, range);
  const metric = t(METRIC_KEY[kind]);
  const rangeWord = t(range === "hour" ? "machines.range.hour.long" : "machines.range.day.long");

  const avgRuns = runsOf(inRange, (p) => (kind === "mem" ? p[3] : p[1]), stepMs);
  const peakRuns = kind === "cpu" ? runsOf(inRange, (p) => p[2], stepMs) : [];
  const rxRuns = kind === "net" ? runsOf(inRange, (p) => p[4], stepMs) : [];
  const txRuns = kind === "net" ? runsOf(inRange, (p) => p[5], stepMs) : [];

  if (kind === "net") {
    if (rxRuns.length === 0 && txRuns.length === 0) {
      return <ChartPlaceholder>{inRange.length === 0 ? t("machines.history.empty") : t("machines.net.none")}</ChartPlaceholder>;
    }
  } else if (avgRuns.length === 0) {
    return <ChartPlaceholder>{t("machines.history.empty")}</ChartPlaceholder>;
  }

  const box = kind === "net" ? BOX_RATE : BOX_PERCENT;
  const yMax = kind === "net" ? niceCeiling(Math.max(maxOf(rxRuns), maxOf(txRuns))) : 1;
  const x = (time: number) => xOf(time, ts, range, box);
  const y = (value: number) => yOf(value, yMax, box);
  const yLabel = (value: number) => (kind === "net" ? formatBytesPerSecond(value) : formatPercent(value));
  const plotRight = box.width - box.right;
  const plotBottom = box.height - box.bottom;
  const ticksY = [0, yMax / 2, yMax];

  const summary = chartSummary(kind, metric, rangeWord, { avgRuns, rxRuns, txRuns }, threshold);

  return (
    <div>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="block h-auto w-full text-status-info"
        data-kind={kind}
        data-range={range}
      >
        {/* Grid: `--border` is a component's own hairline, which is what a chart's gridline is. */}
        {ticksY.map((value) => (
          <g key={value}>
            <line x1={box.left} x2={plotRight} y1={y(value)} y2={y(value)} className="stroke-border" strokeWidth={1} />
            <text x={box.left - 4} y={y(value)} textAnchor="end" dominantBaseline="central" className="fill-muted-foreground" fontSize={10}>
              {yLabel(value)}
            </text>
          </g>
        ))}
        {xTicks(range).map((tick) => {
          const tx = box.left + tick.frac * (plotRight - box.left);
          const anchor = tick.frac === 0 ? "start" : tick.frac === 1 ? "end" : "middle";
          return (
            <text key={tick.frac} x={tx} y={plotBottom + 14} textAnchor={anchor} className="fill-muted-foreground" fontSize={10}>
              {tickLabel(tick)}
            </text>
          );
        })}

        {kind === "cpu" &&
          peakRuns.map((peak, i) => {
            const avg = avgRuns[i];
            const d = avg === undefined ? "" : bandPath(peak, avg, x, y);
            return d === "" ? null : <path key={`band-${peak[0]?.t ?? i}`} d={d} data-series="band" className="fill-current opacity-15" />;
          })}
        {kind === "cpu" &&
          peakRuns.map((run) => (
            <Line key={`peak-${run[0]?.t}`} series="peak" run={run} x={x} y={y} className="stroke-current opacity-45" width={1} />
          ))}

        {kind !== "net" &&
          avgRuns.map((run) => <Line key={`avg-${run[0]?.t}`} series="avg" run={run} x={x} y={y} className="stroke-current" width={1.75} />)}

        {kind === "net" &&
          rxRuns.map((run) => <Line key={`rx-${run[0]?.t}`} series="rx" run={run} x={x} y={y} className="stroke-current" width={1.75} />)}
        {kind === "net" &&
          txRuns.map((run) => (
            <Line key={`tx-${run[0]?.t}`} series="tx" run={run} x={x} y={y} className="stroke-foreground" width={1.5} dash="5 3" />
          ))}

        {threshold !== null && kind !== "net" && (
          <g className="text-status-working">
            <line
              x1={box.left}
              x2={plotRight}
              y1={y(threshold)}
              y2={y(threshold)}
              data-series="threshold"
              stroke="currentColor"
              strokeWidth={1.25}
              strokeDasharray="4 3"
            />
            <text x={plotRight} y={y(threshold) - 3} textAnchor="end" fill="currentColor" fontSize={10}>
              {formatPercent(threshold)}
            </text>
          </g>
        )}
      </svg>
      <Legend kind={kind} threshold={kind === "net" ? null : threshold} />
    </div>
  );
});

function Line({
  series,
  run,
  x,
  y,
  className,
  width,
  dash,
}: {
  series: string;
  run: readonly RunPoint[];
  x: (t: number) => number;
  y: (v: number) => number;
  className: string;
  width: number;
  dash?: string;
}) {
  return (
    <path
      d={linePath(run, x, y)}
      data-series={series}
      fill="none"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray={dash}
      className={className}
    />
  );
}

/** The sentence a screen reader gets in place of the drawing. */
function chartSummary(
  kind: MachineChartKind,
  metric: string,
  range: string,
  runs: { avgRuns: readonly (readonly RunPoint[])[]; rxRuns: readonly (readonly RunPoint[])[]; txRuns: readonly (readonly RunPoint[])[] },
  threshold: number | null,
): string {
  if (kind === "net") {
    const rx = summarize(runs.rxRuns);
    const tx = summarize(runs.txRuns);
    return t("machines.summary.net", {
      metric,
      range,
      down: formatBytesPerSecond(rx?.latest ?? 0),
      downPeak: formatBytesPerSecond(rx?.peak ?? 0),
      up: formatBytesPerSecond(tx?.latest ?? 0),
      upPeak: formatBytesPerSecond(tx?.peak ?? 0),
    });
  }
  const s = summarize(runs.avgRuns);
  const base = t("machines.summary.percent", {
    metric,
    range,
    latest: formatPercent(s?.latest ?? 0),
    mean: formatPercent(s?.mean ?? 0),
    peak: formatPercent(s?.peak ?? 0),
  });
  return threshold === null ? base : `${base} ${t("machines.summary.threshold", { percent: formatPercent(threshold) })}`;
}

/** What each mark is, in words. A 24px swatch beside the word, drawn with the same classes as the mark. */
function Legend({ kind, threshold }: { kind: MachineChartKind; threshold: number | null }) {
  const items: { key: string; label: string; swatch: "avg" | "peak" | "dash" | "rx" | "tx" }[] = [];
  if (kind === "cpu") {
    items.push({ key: "avg", label: t("machines.legend.avg"), swatch: "avg" });
    items.push({ key: "peak", label: t("machines.legend.peak"), swatch: "peak" });
  } else if (kind === "mem") {
    items.push({ key: "used", label: t("machines.legend.used"), swatch: "avg" });
  } else {
    items.push({ key: "down", label: t("machines.legend.down"), swatch: "rx" });
    items.push({ key: "up", label: t("machines.legend.up"), swatch: "tx" });
  }
  if (threshold !== null) {
    items.push({ key: "rule", label: t("machines.legend.threshold", { percent: formatPercent(threshold) }), swatch: "dash" });
  }
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-1 pb-3 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 8" width={24} height={8} aria-hidden className={item.swatch === "dash" ? "text-status-working" : "text-status-info"}>
            <Swatch kind={item.swatch} />
          </svg>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Swatch({ kind }: { kind: "avg" | "peak" | "dash" | "rx" | "tx" }) {
  if (kind === "peak") return <rect x={0} y={1} width={24} height={6} className="fill-current opacity-25" />;
  if (kind === "dash") return <line x1={0} x2={24} y1={4} y2={4} stroke="currentColor" strokeWidth={1.25} strokeDasharray="4 3" />;
  if (kind === "tx") return <line x1={0} x2={24} y1={4} y2={4} className="stroke-foreground" strokeWidth={1.5} strokeDasharray="5 3" />;
  return <line x1={0} x2={24} y1={4} y2={4} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" />;
}
