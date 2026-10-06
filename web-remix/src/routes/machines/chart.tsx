// One hand-made SVG chart (web/src/components/machine-chart.tsx). No chart library. The geometry is
// web's `lib/machine-chart.ts` (pure, read-only); this file draws it.
//
// ONE ACCESSIBLE SUMMARY PER CHART. The `<svg>` is `role="img"` and its name is a sentence: the
// metric, the range, now, average and peak, and the alert line when a rule is set. The legend under it
// names every mark in words, so the chart never relies on colour alone.
//
// ONE VIEWBOX UNIT IS ONE CSS PIXEL, AT ANY WIDTH. The chart measures its column (a ResizeObserver in
// `ref`, ended on the signal) and draws an svg of exactly that many pixels, so the 10 px axis text and
// the strokes are the same at every width and only the plot grows. A state with no data renders a box of
// the same height (`ChartPlaceholder`), so a chart arriving never pushes the one under it down.
import { ref, type Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import {
  bandPath,
  CHART_BASE_WIDTH,
  CHART_MAX_HEIGHT,
  chartHeight,
  linePath,
  maxOf,
  pointsInRange,
  runsOf,
  summarize,
  thresholdLabelSide,
  xOf,
  xTicks,
  yOf,
  type MachineRange,
  type PlotBox,
  type RunPoint,
  type XTick,
} from "@web/lib/machine-chart";
import { formatBytesPerSecond, formatPercent, niceCeiling } from "@web/lib/machine-units";
import type { MachineHistoryPoint } from "@web/lib/types";

import { useLocale } from "../../lib/i18n-store";
import { scheduleUpdate } from "../../lib/store";

/** Percent charts: the y labels are short ("100%"), so the plot starts early and keeps the width. */
function boxPercent(width: number, height: number): PlotBox {
  return { width, height, left: 34, right: 8, top: 8, bottom: 22 };
}
/** Network: "200 KB/s" is wider, so the left margin grows and the plot gives the width back. */
function boxRate(width: number, height: number): PlotBox {
  return { width, height, left: 56, right: 8, top: 8, bottom: 22 };
}

/** The plate behind the alert label: the label's own text height with a little air, never taller. */
const LABEL_PLATE_H = 14;
/** One character of 10px axis text, near enough for a short percent. */
const LABEL_CHAR_W = 6;

export type MachineChartKind = "cpu" | "mem" | "disk" | "net";

export interface MachineChartProps {
  kind: MachineChartKind;
  points: readonly MachineHistoryPoint[];
  /** The history answer's own `ts`: the right edge of the chart. Never `Date.now()`. */
  ts: number;
  stepMs: number;
  range: MachineRange;
  /** The alert rule's `above` as a 0..1 fraction. Not on network. */
  threshold?: number | null;
}

const METRIC_KEY = {
  cpu: "machines.metric.cpu",
  mem: "machines.metric.mem",
  disk: "machines.metric.disk",
  net: "machines.metric.net",
} as const;

/** The value a percent chart draws off a point: CPU average, memory, or the fullest disk. */
function percentOf(kind: MachineChartKind, p: MachineHistoryPoint): number | null {
  if (kind === "mem") return p[3];
  // A bridge older than the disk value sends six elements; the seventh reads `undefined`, no reading.
  if (kind === "disk") return p[6] ?? null;
  return p[1];
}

/** The same-height box a chart's place holds while there is nothing to draw. */
export function ChartPlaceholder(handle: Handle<{ children?: string; skeleton?: boolean }>) {
  return () => (
    <div
      data-testid="chart-placeholder"
      class="flex items-center justify-center px-4 text-center text-sm text-muted-foreground"
      style={{ aspectRatio: `${String(CHART_BASE_WIDTH)} / 150`, maxHeight: `${String(CHART_MAX_HEIGHT)}px` }}
    >
      {handle.props.skeleton === true ? (
        <span class="h-3 w-24 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" aria-hidden="true" />
      ) : null}
      {handle.props.skeleton === true ? <span class="sr-only">{handle.props.children}</span> : handle.props.children}
    </div>
  );
}

function tickLabel(tick: XTick): string {
  if (tick.kind === "now") return t("machines.axis.now");
  return tick.kind === "minutes"
    ? t("machines.axis.minutesAgo", { count: tick.count })
    : t("machines.axis.hoursAgo", { count: tick.count });
}

export function MachineChart(handle: Handle<MachineChartProps>) {
  useLocale(handle);
  let width = CHART_BASE_WIDTH;
  const measure = ref<HTMLDivElement>((node, signal) => {
    const observer = new ResizeObserver(() => {
      const next = Math.round(node.clientWidth);
      if (next > 0 && next !== width) {
        width = next;
        scheduleUpdate(handle);
      }
    });
    observer.observe(node);
    signal.addEventListener("abort", () => observer.disconnect(), { once: true });
  });

  return () => {
    const { kind, points, ts, stepMs, range, threshold = null } = handle.props;
    const inRange = pointsInRange(points, ts, range);
    const metric = t(METRIC_KEY[kind]);
    const rangeWord = t(range === "hour" ? "machines.range.hour.long" : "machines.range.day.long");

    const avgRuns = kind === "net" ? [] : runsOf(inRange, (p) => percentOf(kind, p), stepMs);
    const peakRuns = kind === "cpu" ? runsOf(inRange, (p) => p[2], stepMs) : [];
    const rxRuns = kind === "net" ? runsOf(inRange, (p) => p[4], stepMs) : [];
    const txRuns = kind === "net" ? runsOf(inRange, (p) => p[5], stepMs) : [];

    if (kind === "net") {
      if (rxRuns.length === 0 && txRuns.length === 0) {
        return <ChartPlaceholder>{inRange.length === 0 ? t("machines.history.empty") : t("machines.net.none")}</ChartPlaceholder>;
      }
    } else if (avgRuns.length === 0) {
      const none = kind === "disk" && inRange.length > 0;
      return <ChartPlaceholder>{none ? t("machines.disk.none") : t("machines.history.empty")}</ChartPlaceholder>;
    }

    const height = chartHeight(width);
    const box = kind === "net" ? boxRate(width, height) : boxPercent(width, height);
    const yMax = kind === "net" ? niceCeiling(Math.max(maxOf(rxRuns), maxOf(txRuns))) : 1;
    const x = (time: number): number => xOf(time, ts, range, box);
    const y = (value: number): number => yOf(value, yMax, box);
    const yLabel = (value: number): string => (kind === "net" ? formatBytesPerSecond(value) : formatPercent(value));
    const plotRight = box.width - box.right;
    const plotBottom = box.height - box.bottom;
    const ticksY = [0, yMax / 2, yMax];
    const summary = chartSummary(kind, metric, rangeWord, { avgRuns, rxRuns, txRuns }, threshold);

    return (
      <div mix={measure} data-testid="machine-chart" data-kind={kind}>
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          width={width}
          height={height}
          class="block text-status-info"
          data-kind={kind}
          data-range={range}
        >
          {ticksY.map((value) => (
            <g key={String(value)}>
              <line x1={box.left} x2={plotRight} y1={y(value)} y2={y(value)} class="stroke-border" stroke-width="1" />
              <text x={box.left - 4} y={y(value)} text-anchor="end" dominant-baseline="central" class="fill-muted-foreground" font-size="10">
                {yLabel(value)}
              </text>
            </g>
          ))}
          {xTicks(range).map((tick) => {
            const tx = box.left + tick.frac * (plotRight - box.left);
            const anchor = tick.frac === 0 ? "start" : tick.frac === 1 ? "end" : "middle";
            return (
              <text key={String(tick.frac)} x={tx} y={plotBottom + 14} text-anchor={anchor} class="fill-muted-foreground" font-size="10">
                {tickLabel(tick)}
              </text>
            );
          })}

          {kind === "cpu"
            ? peakRuns.map((peak, i) => {
                const avg = avgRuns[i];
                const d = avg === undefined ? "" : bandPath(peak, avg, x, y);
                return d === "" ? null : <path key={`band-${String(peak[0]?.t ?? i)}`} d={d} data-series="band" class="fill-current opacity-15" />;
              })
            : null}
          {kind === "cpu"
            ? peakRuns.map((run) => (
                <Line key={`peak-${String(run[0]?.t)}`} series="peak" run={run} x={x} y={y} class="stroke-current opacity-45" width={1} />
              ))
            : null}
          {kind !== "net"
            ? avgRuns.map((run) => <Line key={`avg-${String(run[0]?.t)}`} series="avg" run={run} x={x} y={y} class="stroke-current" width={1.75} />)
            : null}
          {kind === "net"
            ? rxRuns.map((run) => <Line key={`rx-${String(run[0]?.t)}`} series="rx" run={run} x={x} y={y} class="stroke-current" width={1.75} />)
            : null}
          {kind === "net"
            ? txRuns.map((run) => (
                <Line key={`tx-${String(run[0]?.t)}`} series="tx" run={run} x={x} y={y} class="stroke-foreground" width={1.5} dash="5 3" />
              ))
            : null}

          {threshold !== null && kind !== "net" ? (
            <g class="text-status-working">
              <line
                x1={box.left}
                x2={plotRight}
                y1={y(threshold)}
                y2={y(threshold)}
                data-series="threshold"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-dasharray="4 3"
              />
              <ThresholdLabel text={formatPercent(threshold)} lineY={y(threshold)} right={plotRight} box={box} />
            </g>
          ) : null}
        </svg>
        <Legend kind={kind} threshold={kind === "net" ? null : threshold} />
      </div>
    );
  };
}

/**
 * The alert line's label, on a plate of the chart card's own colour so a data line under it never
 * crosses the letters, above the line at its right end, or below it when the line is in the top 12 %.
 */
function ThresholdLabel(handle: Handle<{ text: string; lineY: number; right: number; box: PlotBox }>) {
  return () => {
    const { text, lineY, right, box } = handle.props;
    const side = thresholdLabelSide(lineY, box);
    const plateW = text.length * LABEL_CHAR_W + 6;
    const plateY = side === "above" ? lineY - 1.5 - LABEL_PLATE_H : lineY + 1.5;
    return (
      <g data-slot="threshold-label" data-side={side}>
        <rect x={right - plateW} y={plateY} width={plateW} height={LABEL_PLATE_H} rx="2" class="fill-card" />
        <text x={right - 3} y={plateY + LABEL_PLATE_H / 2} text-anchor="end" dominant-baseline="central" fill="currentColor" font-size="10">
          {text}
        </text>
      </g>
    );
  };
}

function Line(
  handle: Handle<{
    series: string;
    run: readonly RunPoint[];
    x: (t: number) => number;
    y: (v: number) => number;
    class: string;
    width: number;
    dash?: string;
  }>,
) {
  return () => {
    const { series, run, x, y, width, dash } = handle.props;
    return (
      <path
        d={linePath(run, x, y)}
        data-series={series}
        fill="none"
        stroke-width={width}
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray={dash}
        class={handle.props.class}
      />
    );
  };
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

type SwatchKind = "avg" | "peak" | "dash" | "rx" | "tx";

/** What each mark is, in words. A 24px swatch beside the word, drawn with the same classes as the mark. */
function Legend(handle: Handle<{ kind: MachineChartKind; threshold: number | null }>) {
  return () => {
    const { kind, threshold } = handle.props;
    const items: { key: string; label: string; swatch: SwatchKind }[] = [];
    if (kind === "cpu") {
      items.push({ key: "avg", label: t("machines.legend.avg"), swatch: "avg" });
      items.push({ key: "peak", label: t("machines.legend.peak"), swatch: "peak" });
    } else if (kind === "mem") {
      items.push({ key: "used", label: t("machines.legend.used"), swatch: "avg" });
    } else if (kind === "disk") {
      items.push({ key: "fullest", label: t("machines.legend.fullest"), swatch: "avg" });
    } else {
      items.push({ key: "down", label: t("machines.legend.down"), swatch: "rx" });
      items.push({ key: "up", label: t("machines.legend.up"), swatch: "tx" });
    }
    if (threshold !== null) {
      items.push({ key: "rule", label: t("machines.legend.threshold", { percent: formatPercent(threshold) }), swatch: "dash" });
    }
    return (
      <ul class="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-1 pb-3 text-xs text-muted-foreground">
        {items.map((item) => (
          <li key={item.key} class="flex items-center gap-1.5">
            <svg viewBox="0 0 24 8" width="24" height="8" aria-hidden="true" class={item.swatch === "dash" ? "text-status-working" : "text-status-info"}>
              <Swatch kind={item.swatch} />
            </svg>
            {item.label}
          </li>
        ))}
      </ul>
    );
  };
}

function Swatch(handle: Handle<{ kind: SwatchKind }>) {
  return () => {
    const { kind } = handle.props;
    if (kind === "peak") return <rect x="0" y="1" width="24" height="6" class="fill-current opacity-25" />;
    if (kind === "dash") return <line x1="0" x2="24" y1="4" y2="4" stroke="currentColor" stroke-width="1.25" stroke-dasharray="4 3" />;
    if (kind === "tx") return <line x1="0" x2="24" y1="4" y2="4" class="stroke-foreground" stroke-width="1.5" stroke-dasharray="5 3" />;
    return <line x1="0" x2="24" y1="4" y2="4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />;
  };
}
