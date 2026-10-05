import { memo } from "react";
import { ChevronRight, Clock, Crown, Server, TriangleAlert } from "lucide-react";

import { healthTone, healthWord } from "@/components/crew-formation";
import { firingWords, readingLine } from "@/components/machine-load";
import { MachineSpark, type SparkTone } from "@/components/machine-spark";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { machineReading } from "@/lib/machine-reading";
import { formatBytesOf, formatBytesPerSecond, formatLoad, formatPercent } from "@/lib/machine-units";
import type { MachineMetric, MachineRow, MachineSample } from "@/lib/types";
import { cn } from "@/lib/utils";

// ONE machine card, for the two places that list machines: the Machines list (routes/machines.tsx)
// and the dashboard's Crew tab (components/crew-tab.tsx). One component, so the two never drift.
//
// ── WHAT A CARD SAYS ─────────────────────────────────────────────────────────
// The name, the health in words, then CPU and memory side by side: the number now, and under it the
// last half hour as a spark on a fixed 0 to 100 % scale (components/machine-spark.tsx). Then the
// load and network where the machine reports them. A firing metric turns its number and its spark
// the blocked colour AND says so in words under them ("Alert firing: CPU"), because colour alone is
// not a state (WCAG 1.4.1).
//
// A machine that is not answering shows its health and the age of its last reading, and nothing
// else. An older machine says to update it. A reachable machine whose reading stopped moving shows
// its numbers quieted and the age in words (lib/machine-reading.ts names the four cases).
//
// ── THE WHOLE CARD IS THE TAP ────────────────────────────────────────────────
// The name is the card's one button, and its hit area is stretched over the card
// (`after:absolute after:inset-0`), so the numbers and sparks stay real elements a screen reader can
// read, and a tap anywhere opens the machine. The focus mark is drawn on the card, outside it, with
// the 2px offset every focus mark in the app has (DESIGN.md §2).
//
// ── IT DRAWS ONLY WHEN ITS ROW MOVES ─────────────────────────────────────────
// Memoised on `row`, `ts` and the flags. `ts` moves on every read, so the card would redraw on every
// poll if it took it whole: it takes `stale` and the reading's age as words instead, which change far
// less often, and the census keeps an unchanged row's identity (lib/loaders.ts).

/** The "Lead" mark. `rounded-md` is 2px: an icon plus an uppercase word is a stadium, not a circle. */
export function LeadBadge() {
  return (
    <span className="flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      <Crown className="size-2.5" aria-hidden />
      {t("connection.host.lead")}
    </span>
  );
}

export interface MachineCardProps {
  row: MachineRow;
  /** The answer's `ts`. Only the reading's age is read off it (see the header). */
  ts: number;
  /** A crew: the lead's card wears the Lead mark. A solo collie's one card does not. */
  showRole: boolean;
  /** The minutes the sparks span: the same number the census was asked for. */
  sparkMinutes: number;
  onOpen: (row: MachineRow) => void;
}

export function MachineCard({ row, ts, showRole, sparkMinutes, onOpen }: MachineCardProps) {
  const reading = machineReading(row, ts);
  // The age is words, so a card redraws when "2m ago" becomes "3m ago", not on every poll.
  const age = reading === "live" || reading === "older" ? null : readingLine(row, ts);
  return (
    <MachineCardBody row={row} reading={reading} age={age} showRole={showRole} sparkMinutes={sparkMinutes} onOpen={onOpen} />
  );
}

interface BodyProps {
  row: MachineRow;
  reading: ReturnType<typeof machineReading>;
  age: string | null;
  showRole: boolean;
  sparkMinutes: number;
  onOpen: (row: MachineRow) => void;
}

const MachineCardBody = memo(function MachineCardBody({ row, reading, age, showRole, sparkMinutes, onOpen }: BodyProps) {
  useLocale();
  const name = row.name || row.id;
  return (
    <Card className="relative gap-0 py-0 has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-ring">
      <div className="flex min-h-11 items-center justify-between gap-3 pt-2 pr-3 pl-4">
        <button
          type="button"
          onClick={() => onOpen(row)}
          className="flex min-h-11 min-w-0 items-center gap-2 text-left focus-visible:outline-none after:absolute after:inset-0 after:content-['']"
        >
          <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{name}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2 text-sm">
          {showRole && row.isLead && <LeadBadge />}
          <span className={healthTone(row)}>{healthWord(row)}</span>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
        </div>
      </div>
      <div className="px-4 pt-1 pb-4">
        {reading === "quiet" && <p className="text-sm text-muted-foreground">{age}</p>}
        {reading === "older" && <p className="text-sm text-muted-foreground">{t("machines.noSample")}</p>}
        {(reading === "live" || reading === "stale") && row.sample !== undefined && (
          <Numbers row={row} sample={row.sample} stale={reading === "stale"} age={age} sparkMinutes={sparkMinutes} />
        )}
      </div>
    </Card>
  );
});

const NO_VALUES: readonly (number | null)[] = [];

function Numbers({
  row,
  sample,
  stale,
  age,
  sparkMinutes,
}: {
  row: MachineRow;
  sample: MachineSample;
  stale: boolean;
  age: string | null;
  sparkMinutes: number;
}) {
  const mem = sample.memTotal > 0 ? sample.memUsed / sample.memTotal : 0;
  const firing = firingWords(row.firing);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
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
      <Facts sample={sample} />
      {firing !== null && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-status-blocked">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {firing}
        </p>
      )}
      {stale && age !== null && (
        <p className="flex items-center gap-1.5 text-sm text-status-working">
          <Clock className="size-4 shrink-0" aria-hidden />
          {age}
        </p>
      )}
    </div>
  );
}

/** One metric: its name, the number now, the half-hour spark, and a quiet note under it. */
function Metric({
  metric,
  row,
  now,
  value,
  note,
  values,
  stale,
  sparkMinutes,
}: {
  metric: MachineMetric;
  row: MachineRow;
  now: number;
  value: string;
  note: string;
  values: readonly (number | null)[];
  stale: boolean;
  sparkMinutes: number;
}) {
  const label = t(metric === "cpu" ? "machines.metric.cpu" : "machines.metric.mem");
  const firing = row.firing.includes(metric);
  const threshold = row.alerts[metric]?.above ?? null;
  const tone: SparkTone = stale ? "quiet" : firing ? "firing" : "normal";
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span
          className={cn(
            "text-lg leading-6 font-semibold tracking-tight tabular-nums",
            firing && !stale && "text-status-blocked",
            stale && "text-muted-foreground",
          )}
        >
          {value}
        </span>
      </div>
      <MachineSpark
        className="mt-1.5"
        values={values}
        now={stale ? null : now}
        minutes={sparkMinutes}
        threshold={threshold}
        tone={tone}
        label={sparkLabel(label, now, values, threshold, sparkMinutes)}
      />
      <p className="mt-1 truncate text-xs text-muted-foreground tabular-nums">{note}</p>
    </div>
  );
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
  const base = t("machines.spark.label", {
    metric,
    minutes,
    now: formatPercent(now),
    peak: formatPercent(peak),
  });
  return threshold === null ? base : `${base} ${t("machines.summary.threshold", { percent: formatPercent(threshold) })}`;
}

/** Load, then network down and up, each only where the machine reports it. One quiet row. */
function Facts({ sample }: { sample: MachineSample }) {
  const facts: { key: string; label: string; value: string }[] = [];
  if (sample.load1 !== undefined)
    facts.push({
      key: "load",
      label: t("machines.load"),
      value: formatLoad(sample.load1),
    });
  if (sample.rxBps !== undefined)
    facts.push({
      key: "down",
      label: t("machines.net.down"),
      value: formatBytesPerSecond(sample.rxBps),
    });
  if (sample.txBps !== undefined)
    facts.push({
      key: "up",
      label: t("machines.net.up"),
      value: formatBytesPerSecond(sample.txBps),
    });
  if (facts.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-sm">
      {facts.map((f) => (
        <div key={f.key} className="flex items-baseline gap-1.5">
          <dt className="text-xs text-muted-foreground">{f.label}</dt>
          <dd className="font-medium tabular-nums">{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}
