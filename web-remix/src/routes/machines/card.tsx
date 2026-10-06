// ONE machine card for the Machines list (web/src/components/machine-card.tsx).
//
// WHAT A CARD SAYS: the name, the health in words, then CPU and memory side by side (the number now,
// and under it the last half hour as a spark on a fixed 0 to 100 % scale), then one quiet row of facts
// where the machine reports them: its fullest disk, the load, network down and up. A firing metric turns
// its number the blocked colour AND says so in words under them; that line is a link of its own, to the
// machine's Alerts view, above the card's stretched tap. A machine that is not answering shows its
// health and the age of its last reading, and nothing else. An older machine says to update it. A
// reachable machine whose reading stopped moving shows its numbers quieted and the age in words.
//
// THE WHOLE CARD IS THE TAP: the name is the card's one button, its hit area stretched over the card, so
// the numbers and sparks stay real elements a screen reader can read.
import { on, type Handle } from "remix/component";
import { ChevronRight, Clock, Crown, Server } from "lucide";

import { t, tn } from "@web/lib/i18n";
import { fullestDisk, machineReading } from "@web/lib/machine-reading";
import { formatBytesOf, formatBytesPerSecond, formatLoad, formatPercent } from "@web/lib/machine-units";
import type { MachineMetric, MachineRow, MachineSample } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { healthTone, healthWord } from "../crew/formation";
import { FiringLine, firingWords, readingLine } from "./load";
import { MachineSpark } from "./spark";
import type { SparkTone } from "./spark-math";

/** The "Lead" mark. `rounded-md` is 2px: an icon plus an uppercase word is a stadium, not a circle. */
export function LeadBadge(handle: Handle) {
  useLocale(handle);
  return () => (
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
  /** Opens the machine on its Alerts view: the firing line's link. */
  onOpenAlerts?: (row: MachineRow) => void;
}

const NO_VALUES: readonly (number | null)[] = [];

export function MachineCard(handle: Handle<MachineCardProps>) {
  useLocale(handle);
  return () => {
    const { row, ts, showRole, sparkMinutes } = handle.props;
    const reading = machineReading(row, ts);
    // The age is words, so it changes when "2m ago" becomes "3m ago", not on every poll.
    const age = reading === "live" || reading === "older" ? null : readingLine(row, ts);
    const name = row.name || row.id;
    return (
      <Card
        data-testid="machine-card"
        data-machine-id={row.id}
        class="relative gap-0 py-0 has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-ring"
      >
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
            {showRole && row.isLead ? <LeadBadge /> : null}
            <span class={healthTone(row)}>{healthWord(row)}</span>
            <Icon icon={ChevronRight} class="size-4 text-muted-foreground" />
          </div>
        </div>
        <div class="px-4 pt-1 pb-4">
          {reading === "quiet" ? <p class="text-sm text-muted-foreground">{age}</p> : null}
          {reading === "older" ? <p class="text-sm text-muted-foreground">{t("machines.noSample")}</p> : null}
          {(reading === "live" || reading === "stale") && row.sample !== undefined ? (
            <Numbers
              row={row}
              sample={row.sample}
              stale={reading === "stale"}
              age={age}
              sparkMinutes={sparkMinutes}
              onOpenAlerts={handle.props.onOpenAlerts === undefined ? undefined : () => handle.props.onOpenAlerts?.(handle.props.row)}
            />
          ) : null}
        </div>
      </Card>
    );
  };
}

interface NumbersProps {
  row: MachineRow;
  sample: MachineSample;
  stale: boolean;
  age: string | null;
  sparkMinutes: number;
  onOpenAlerts: (() => void) | undefined;
}

function Numbers(handle: Handle<NumbersProps>) {
  return () => {
    const { row, sample, stale, age, sparkMinutes, onOpenAlerts } = handle.props;
    const mem = sample.memTotal > 0 ? sample.memUsed / sample.memTotal : 0;
    const firing = firingWords(row.firing);
    return (
      <div class="space-y-3">
        <div class="grid grid-cols-2 gap-4">
          <Metric
            metric="cpu"
            row={row}
            now={sample.cpu}
            value={formatPercent(sample.cpu)}
            note={tn("machines.cores", sample.cores)}
            values={row.spark?.cpu ?? NO_VALUES}
            stale={stale}
            sparkMinutes={sparkMinutes}
          />
          <Metric
            metric="mem"
            row={row}
            now={mem}
            value={formatPercent(mem)}
            note={formatBytesOf(sample.memUsed, sample.memTotal)}
            values={row.spark?.mem ?? NO_VALUES}
            stale={stale}
            sparkMinutes={sparkMinutes}
          />
        </div>
        <Facts sample={sample} diskFiring={row.firing.includes("disk") && !stale} />
        {/* Above the stretched tap (`relative z-10`), so this line opens Alerts and the rest opens Status. */}
        {firing === null ? null : <FiringLine words={firing} onOpen={onOpenAlerts} class="relative z-10" />}
        {stale && age !== null ? (
          <p class="flex items-center gap-1.5 text-sm text-status-working">
            <Icon icon={Clock} class="size-4 shrink-0" />
            {age}
          </p>
        ) : null}
      </div>
    );
  };
}

interface MetricProps {
  metric: MachineMetric;
  row: MachineRow;
  now: number;
  value: string;
  note: string;
  values: readonly (number | null)[];
  stale: boolean;
  sparkMinutes: number;
}

/** One metric: its name, the number now, the half-hour spark, and a quiet note under it. */
function Metric(handle: Handle<MetricProps>) {
  return () => {
    const { metric, row, now, value, note, values, stale, sparkMinutes } = handle.props;
    const label = t(metric === "cpu" ? "machines.metric.cpu" : "machines.metric.mem");
    const firing = row.firing.includes(metric);
    const threshold = row.alerts[metric]?.above ?? null;
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
  };
}

/**
 * The spark's sentence: the value now, the peak of the minutes drawn and the reading now together, and
 * the rule's line when one is set. With no minute drawn yet, the peak is the reading now.
 */
export function sparkLabel(
  metric: string,
  now: number,
  values: readonly (number | null)[],
  threshold: number | null,
  minutes: number,
): string {
  let peak = now;
  for (const v of values) if (v !== null && v > peak) peak = v;
  const base = t("machines.spark.label", { metric, minutes, now: formatPercent(now), peak: formatPercent(peak) });
  return threshold === null ? base : `${base} ${t("machines.summary.threshold", { percent: formatPercent(threshold) })}`;
}

/** The fullest disk, the load, then network down and up, each only where the machine reports it. */
function Facts(handle: Handle<{ sample: MachineSample; diskFiring: boolean }>) {
  return () => {
    const { sample, diskFiring } = handle.props;
    const facts: { key: string; label: string; value: string; firing?: boolean }[] = [];
    const disk = fullestDisk(sample.disks);
    if (disk !== null) facts.push({ key: "disk", label: t("machines.metric.disk"), value: formatPercent(disk.fraction), firing: diskFiring });
    if (sample.load1 !== undefined) facts.push({ key: "load", label: t("machines.load"), value: formatLoad(sample.load1) });
    if (sample.rxBps !== undefined) facts.push({ key: "down", label: t("machines.net.down"), value: formatBytesPerSecond(sample.rxBps) });
    if (sample.txBps !== undefined) facts.push({ key: "up", label: t("machines.net.up"), value: formatBytesPerSecond(sample.txBps) });
    if (facts.length === 0) return null;
    return (
      <dl class="flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-sm">
        {facts.map((f) => (
          <div key={f.key} class="flex items-baseline gap-1.5 whitespace-nowrap" data-fact={f.key}>
            <dt class="text-xs text-muted-foreground">{f.label}</dt>
            <dd class={cn("font-medium tabular-nums", f.firing === true && "text-status-blocked")}>{f.value}</dd>
          </div>
        ))}
      </dl>
    );
  };
}
