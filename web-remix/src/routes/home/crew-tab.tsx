import { on, type Handle, type RemixNode } from "remix/component";
import { ChevronRight, Clock, Crown, Server, TriangleAlert } from "lucide";

import { timeAgo } from "@web/lib/format";
import { t, tn } from "@web/lib/i18n";
import { fullestDisk, machineReading } from "@web/lib/machine-reading";
import { formatBytesOf, formatBytesPerSecond, formatLoad, formatPercent } from "@web/lib/machine-units";
import { machinePath } from "@web/lib/nav";
import type { MachineMetric, MachineRow, MachineSample } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { navigate } from "../../lib/navigate";
import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { href } from "../../routes";
import { Card } from "../../ui/card";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { Notice } from "../../ui/notice";
import {
  MACHINES_SOURCE,
  MACHINE_SPARK_MINUTES,
  machineCensusState,
  machinesCensus,
  reopenMachines,
} from "./crew-data";
import { healthTone, healthWord } from "./crew-formation";

// Port of web/src/components/crew-tab.tsx (ADR 0085): the dashboard's Crew tab body. One card per
// machine, the lead first, each with its CPU and memory now and their last half hour as sparks.
// It carries the machine card and the spark it is made of (web/ machine-card.tsx, machine-spark.tsx,
// machines-empty-card.tsx), because the tab is the only screen of this shell that draws them yet; the
// Machines pages may import them from here rather than draw a second copy.
//
// ── IT READS ONLY WHILE IT IS ON SCREEN ──────────────────────────────────────
// The tab mounts this only while Crew is selected. `want(MACHINES_SOURCE)` keeps the census on the
// app's beat for exactly that long, spaced to about 15 s and one round at a time (crew-data.ts).
// Any other tab, and a phone in a pocket, fetch nothing for it (ADR 0066 point 4).
//
// ── A TAP GOES DOWN ──────────────────────────────────────────────────────────
// A card opens `/machines/<id>` as a step down, at the scope the screen is on. Its back arrow steps
// back onto the dashboard (ADR 0067); `/` is a legitimate parent of a machine.
//
// ── NO GUTTER OF ITS OWN ─────────────────────────────────────────────────────
// The dashboard's list already sits on the page's 16px gutter, so this draws only its stack.
//
// What changed from React: no memo. A card re-renders when its parent does, which is when the census
// changed (the store wakes nobody for an equal answer) and the work is a few elements. The census
// keeps the identity of every row that did not change (crew-data.ts `shareEqual`).

/** Open one machine's page (or its Alerts view) as a step down, at the scope the screen is on. */
function openMachine(row: MachineRow, tab?: "alerts"): void {
  void navigate(href(machinePath(row.id, address.get().scope, tab)));
}

export function CrewTab(handle: Handle) {
  useLocale(handle);
  const feed = useStore(handle, machinesCensus);
  reopenMachines();
  want(MACHINES_SOURCE, handle.signal);

  return () => {
    const state = machineCensusState(feed());
    if (state.kind === "loading") return <CrewTabSkeleton />;
    if (state.kind === "unavailable") return <MachinesEmptyCard reason="unavailable" />;
    if (state.kind === "error") return <MachinesEmptyCard reason="error" />;

    const { census } = state;
    // The wire puts the lead first; this keeps it so if a bridge ever stops doing that.
    const machines = census.machines.toSorted((a, b) => Number(b.isLead) - Number(a.isLead));
    return (
      <section aria-label={t("machines.tab.aria")} class="flex flex-col gap-3">
        {/* A refresh that failed keeps the cards it had and says so. The ages on the cards keep the
            last answer's clock, so they do not claim the numbers are fresh. */}
        <Collapse open={state.failed}>
          <Notice tone="caution" variant="box" announce="status">
            {t("machines.tab.failed")}
          </Notice>
        </Collapse>
        {machines.map((row) => (
          <MachineCard
            key={row.id}
            row={row}
            ts={census.ts}
            showRole={machines.length > 1}
            sparkMinutes={MACHINE_SPARK_MINUTES}
            onOpen={openMachine}
            onOpenAlerts={(r) => openMachine(r, "alerts")}
          />
        ))}
      </section>
    );
  };
}

/**
 * Two cards in the real card's own box before the first answer: the name line, the two metric
 * columns with their spark's height, and the facts line. The bars breathe like the Changes tab's
 * (`.count-skeleton`, still under reduced motion). Announced once as loading.
 */
export function CrewTabSkeleton(handle: Handle) {
  useLocale(handle);
  return () => (
    <div role="status" class="flex flex-col gap-3" data-slot="crew-tab-skeleton">
      <span class="sr-only">{t("machines.tab.loading")}</span>
      {[0, 1].map((i) => (
        <Card key={i} aria-hidden="true" class="gap-0 py-0">
          <div class="flex min-h-11 items-center justify-between gap-3 pt-2 pr-3 pl-4">
            <span class="count-skeleton h-3 w-28 rounded-full bg-muted" />
            <span class="count-skeleton h-2.5 w-16 rounded-full bg-muted" />
          </div>
          <div class="grid grid-cols-2 gap-4 px-4 pt-1 pb-4">
            {[0, 1].map((j) => (
              <div key={j} class="space-y-2">
                <div class="flex h-6 items-center justify-between">
                  <span class="count-skeleton h-2.5 w-10 rounded-full bg-muted" />
                  <span class="count-skeleton h-3.5 w-12 rounded-full bg-muted" />
                </div>
                <span class="count-skeleton block h-8 w-full rounded-sm bg-muted" />
                <span class="count-skeleton block h-2.5 w-16 rounded-full bg-muted" />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * The one card shown when there is no census to show: this collie serves none (a peer opened
 * directly answers 404), or the first read failed. Never a spinner, never blank. A 404 and a failure
 * are different sentences: the first says there is nothing to report here, the second that we could
 * not ask.
 */
export function MachinesEmptyCard(handle: Handle<{ reason: "unavailable" | "error" | "unknown" }>) {
  useLocale(handle);
  return () => {
    const { reason } = handle.props;
    return (
      <Card class="gap-0 py-0">
        <div class="flex items-start gap-3 p-4">
          <Icon icon={Server} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="font-medium">{t(`machines.${reason}.title`)}</div>
            <p class="text-sm text-muted-foreground">{t(`machines.${reason}.description`)}</p>
          </div>
        </div>
      </Card>
    );
  };
}

// ── The machine card ─────────────────────────────────────────────────────────

/** The "Last reading" line for a machine that sends no numbers right now (web/ machine-load.tsx). */
export function readingLine(row: MachineRow, ts: number): string {
  if (row.sampledAt === undefined || row.sampledAt <= 0) return t("machines.lastReading.never");
  return t("machines.lastReading", { time: timeAgo(row.sampledAt, ts) });
}

const METRIC_KEY = { cpu: "machines.metric.cpu", mem: "machines.metric.mem", disk: "machines.metric.disk" } as const;

/** The sentence that names the firing metrics, or `null` when none fires. */
export function firingWords(firing: readonly MachineMetric[]): string | null {
  if (firing.length === 0) return null;
  return t("machines.firing", { metrics: firing.map((m) => t(METRIC_KEY[m])).join(", ") });
}

/** The "Lead" mark. `rounded-md` is 2px: an icon plus an uppercase word is a stadium, not a circle. */
function leadBadge(): RemixNode {
  return (
    <span class="flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      <Icon icon={Crown} class="size-2.5" />
      {t("connection.host.lead")}
    </span>
  );
}

export interface MachineCardProps {
  row: MachineRow;
  /** The answer's `ts`. Only the reading's age is read off it. */
  ts: number;
  /** A crew: the lead's card wears the Lead mark. A solo collie's one card does not. */
  showRole: boolean;
  /** The minutes the sparks span: the same number the census was asked for. */
  sparkMinutes: number;
  onOpen: (row: MachineRow) => void;
  /** Opens the machine on its Alerts view: the firing line's link. Without it, the line is words. */
  onOpenAlerts?: (row: MachineRow) => void;
}

/**
 * ONE machine card, for the two places that list machines: the Machines list and the dashboard's Crew
 * tab, so the two never drift. The name, the health in words, then CPU and memory side by side (the
 * number now, and under it the last half hour as a spark on a fixed 0 to 100 % scale), then one quiet
 * row of facts where the machine reports them. A firing metric turns its number the blocked colour AND
 * says so in words. A machine that is not answering shows its health and the age of its last reading,
 * and nothing else (lib/machine-reading.ts names the four cases).
 *
 * THE WHOLE CARD IS THE TAP: the name is the card's one button and its hit area is stretched over the
 * card (`after:absolute after:inset-0`); the firing line sits above it and opens Alerts instead.
 */
export function MachineCard(handle: Handle<MachineCardProps>) {
  useLocale(handle);
  return () => {
    const { row, ts, showRole, sparkMinutes } = handle.props;
    const reading = machineReading(row, ts);
    // The age is words, so a card changes when "2m ago" becomes "3m ago", not on every poll.
    const age = reading === "live" || reading === "older" ? null : readingLine(row, ts);
    const name = row.name || row.id;
    return (
      <Card class="relative gap-0 py-0 has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-ring">
        <div class="flex min-h-11 items-center justify-between gap-3 pt-2 pr-3 pl-4">
          <button
            type="button"
            mix={on("click", () => handle.props.onOpen(handle.props.row))}
            class="flex min-h-11 min-w-0 items-center gap-2 text-left focus-visible:outline-none after:absolute after:inset-0 after:content-['']"
          >
            <Icon icon={Server} class="size-4 shrink-0 text-muted-foreground" />
            <span class="truncate font-medium">{name}</span>
          </button>
          <div class="flex shrink-0 items-center gap-2 text-sm">
            {showRole && row.isLead ? leadBadge() : null}
            <span class={healthTone(row)}>{healthWord(row)}</span>
            <Icon icon={ChevronRight} class="size-4 text-muted-foreground" />
          </div>
        </div>
        <div class="px-4 pt-1 pb-4">
          {reading === "quiet" ? <p class="text-sm text-muted-foreground">{age}</p> : null}
          {reading === "older" ? <p class="text-sm text-muted-foreground">{t("machines.noSample")}</p> : null}
          {(reading === "live" || reading === "stale") && row.sample !== undefined
            ? numbers(row, row.sample, reading === "stale", age, sparkMinutes, handle.props.onOpenAlerts === undefined ? undefined : () => handle.props.onOpenAlerts?.(handle.props.row))
            : null}
        </div>
      </Card>
    );
  };
}

const NO_VALUES: readonly (number | null)[] = [];

function numbers(
  row: MachineRow,
  sample: MachineSample,
  stale: boolean,
  age: string | null,
  sparkMinutes: number,
  onOpenAlerts: (() => void) | undefined,
): RemixNode {
  const mem = sample.memTotal > 0 ? sample.memUsed / sample.memTotal : 0;
  const firing = firingWords(row.firing);
  return (
    <div class="space-y-3">
      <div class="grid grid-cols-2 gap-4">
        {metric("cpu", row, sample.cpu, formatPercent(sample.cpu), tn("machines.cores", sample.cores), row.spark?.cpu ?? NO_VALUES, stale, sparkMinutes)}
        {metric("mem", row, mem, formatPercent(mem), formatBytesOf(sample.memUsed, sample.memTotal), row.spark?.mem ?? NO_VALUES, stale, sparkMinutes)}
      </div>
      {facts(sample, row.firing.includes("disk") && !stale)}
      {/* Above the stretched tap (`relative z-10`), so this line opens Alerts and the rest opens Status. */}
      {firing !== null ? firingLine(firing, onOpenAlerts, "relative z-10") : null}
      {stale && age !== null ? (
        <p class="flex items-center gap-1.5 text-sm text-status-working">
          <Icon icon={Clock} class="size-4 shrink-0" />
          {age}
        </p>
      ) : null}
    </div>
  );
}

/** One metric: its name, the number now, the half-hour spark, and a quiet note under it. */
function metric(
  kind: MachineMetric,
  row: MachineRow,
  now: number,
  value: string,
  note: string,
  values: readonly (number | null)[],
  stale: boolean,
  sparkMinutes: number,
): RemixNode {
  const label = t(kind === "cpu" ? "machines.metric.cpu" : "machines.metric.mem");
  const firing = row.firing.includes(kind);
  const threshold = row.alerts[kind]?.above ?? null;
  const tone: SparkTone = stale ? "quiet" : firing ? "firing" : "normal";
  return (
    <div class="min-w-0">
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-xs text-muted-foreground">{label}</span>
        <span
          class={cn(
            "text-lg leading-6 font-semibold tracking-tight tabular-nums",
            firing && !stale && "text-status-blocked",
            stale && "text-muted-foreground",
          )}
        >
          {value}
        </span>
      </div>
      <MachineSpark
        class="mt-1.5"
        values={values}
        now={stale ? null : now}
        minutes={sparkMinutes}
        threshold={threshold}
        tone={tone}
        label={sparkLabel(label, now, values, threshold, sparkMinutes)}
      />
      <p class="mt-1 truncate text-xs text-muted-foreground tabular-nums">{note}</p>
    </div>
  );
}

/**
 * The spark's sentence: the value now, the peak of the minutes drawn and the reading now together, and
 * the rule's line when one is set. With no minute drawn yet, the peak is the reading now.
 */
export function sparkLabel(
  metricName: string,
  now: number,
  values: readonly (number | null)[],
  threshold: number | null,
  minutes: number,
): string {
  let peak = now;
  for (const v of values) if (v !== null && v > peak) peak = v;
  const base = t("machines.spark.label", {
    metric: metricName,
    minutes,
    now: formatPercent(now),
    peak: formatPercent(peak),
  });
  return threshold === null ? base : `${base} ${t("machines.summary.threshold", { percent: formatPercent(threshold) })}`;
}

/**
 * The fullest disk, the load, then network down and up, each only where the machine reports it. One
 * quiet row that wraps, a fact at a time, and never cuts a number.
 */
function facts(sample: MachineSample, diskFiring: boolean): RemixNode {
  const rows: { key: string; label: string; value: string; firing?: boolean }[] = [];
  const disk = fullestDisk(sample.disks);
  if (disk !== null) rows.push({ key: "disk", label: t("machines.metric.disk"), value: formatPercent(disk.fraction), firing: diskFiring });
  if (sample.load1 !== undefined) rows.push({ key: "load", label: t("machines.load"), value: formatLoad(sample.load1) });
  if (sample.rxBps !== undefined) rows.push({ key: "down", label: t("machines.net.down"), value: formatBytesPerSecond(sample.rxBps) });
  if (sample.txBps !== undefined) rows.push({ key: "up", label: t("machines.net.up"), value: formatBytesPerSecond(sample.txBps) });
  if (rows.length === 0) return null;
  return (
    <dl class="flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-sm">
      {rows.map((f) => (
        <div key={f.key} class="flex items-baseline gap-1.5 whitespace-nowrap" data-fact={f.key}>
          <dt class="text-xs text-muted-foreground">{f.label}</dt>
          <dd class={cn("font-medium tabular-nums", f.firing && "text-status-blocked")}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Alert firing: CPU" in the blocked colour with its mark. With `onOpen`, a link to the Alerts view: a
 * 44px row, the chevron saying it goes somewhere. Shared by the card and the machine page.
 */
export function firingLine(words: string, onOpen?: () => void, className?: string): RemixNode {
  const body = (
    <>
      <Icon icon={TriangleAlert} class="size-4 shrink-0" />
      <span class="min-w-0">{words}</span>
    </>
  );
  if (onOpen === undefined) {
    return <p class={cn("flex items-center gap-1.5 text-sm font-medium text-status-blocked", className)}>{body}</p>;
  }
  return (
    <button
      type="button"
      mix={on("click", onOpen)}
      data-slot="machine-firing-link"
      class={cn(
        "-my-2 flex min-h-11 items-center gap-1.5 text-left text-sm font-medium text-status-blocked underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      {body}
      <Icon icon={ChevronRight} class="size-4 shrink-0" />
    </button>
  );
}

// ── The spark ────────────────────────────────────────────────────────────────
//
// A machine's last half hour of one metric as a tiny hand-made SVG: an area under a line, no axes.
//
// THE SCALE IS FIXED, so a spark is also a bar: the y axis is always 0 to 100 %, and the x axis is
// always the minutes asked for plus the reading now at the right edge (a dot joined to the last
// complete minute). A gap is a gap: `null` is a minute with no reading, and the line stops there.

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
  class?: string;
}

function yOf(v: number): number {
  const f = Math.min(1, Math.max(0, v));
  return PAD_Y + (1 - f) * (H - 2 * PAD_Y);
}

function round(n: number): number {
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
  series.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push([round(((offset + i) / slots) * W), round(yOf(v))]);
  });
  if (run.length > 0) runs.push(run);
  return runs;
}

function linePath(run: readonly [number, number][]): string {
  const [x0, y0] = run[0] ?? [0, 0];
  // One minute between two gaps is a zero-length segment, which the round cap draws as a dot.
  if (run.length === 1) return `M${x0} ${y0}L${x0} ${y0}`;
  return run.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join("");
}

function areaPath(run: readonly [number, number][]): string {
  const first = run[0];
  const last = run.at(-1);
  if (run.length < 2 || first === undefined || last === undefined) return "";
  return `${linePath(run)}L${last[0]} ${H}L${first[0]} ${H}Z`;
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
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        class={cn("block h-8 w-full overflow-visible", TONE[tone], handle.props.class)}
      >
        {/* The floor: a hairline the eye reads the height against, drawn in every state, empty too. */}
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} class="stroke-border" stroke-width={1} vector-effect="non-scaling-stroke" />
        {threshold !== null ? (
          <line
            x1={0}
            x2={W}
            y1={yOf(threshold)}
            y2={yOf(threshold)}
            data-series="threshold"
            class="stroke-status-working opacity-60"
            stroke-width={1}
            stroke-dasharray="3 3"
            vector-effect="non-scaling-stroke"
          />
        ) : null}
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
            stroke-width={1.5}
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        ))}
        {dot !== null ? (
          // The reading now: a zero-length segment with a round cap. A circle in a stretched viewBox
          // would turn into an ellipse; a non-scaling stroke cap stays round.
          <path
            d={`M${W} ${round(dot)}L${W} ${round(dot)}`}
            data-series="now"
            stroke="currentColor"
            stroke-width={4}
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    );
  };
}
