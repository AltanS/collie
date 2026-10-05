import { TriangleAlert } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { timeAgo } from "@/lib/format";
import { t, tn } from "@/lib/i18n";
import { formatBytesOf, formatBytesPerSecond, formatLoad, formatPercent } from "@/lib/machine-units";
import type { MachineMetric, MachineRow, MachineSample } from "@/lib/types";
import { cn } from "@/lib/utils";

// A machine's load NOW: a CPU bar, a memory bar, network down and up, and the one-minute load. It is
// the body of a card on /machines and the big numbers at the top of /machines/:id, so the two cannot
// disagree about a number; `size` is the only difference between them.
//
// ── A FIRING METRIC SAYS SO IN WORDS ─────────────────────────────────────────
// The bar of a metric whose alert is firing turns the blocked colour, and a line under the numbers
// names it ("Alert firing: CPU"). Colour alone is not a state (WCAG 1.4.1), and the push that got the
// operator here said the same words.
//
// ── NO NUMBERS FROM A MACHINE THAT IS NOT ANSWERING ──────────────────────────
// An unreachable, incompatible or conflicted machine shows its last reading's AGE and no numbers: a
// stale 12% beside the word "unreachable" reads as a calm machine. A reachable machine that sends no
// sample is an older Collie, and the line says what to do about it. Every age is measured against the
// answer's own `ts`, never `Date.now()`.

export type MachineLoadSize = "card" | "large";

const METRIC_KEY = { cpu: "machines.metric.cpu", mem: "machines.metric.mem" } as const;

/** The sentence that names the firing metrics, or `null` when none fires. */
export function firingWords(firing: readonly MachineMetric[]): string | null {
  if (firing.length === 0) return null;
  return t("machines.firing", { metrics: firing.map((m) => t(METRIC_KEY[m])).join(", ") });
}

/** The memory fraction, guarded against a zero total. */
function memFraction(sample: MachineSample): number {
  return sample.memTotal > 0 ? Math.min(1, Math.max(0, sample.memUsed / sample.memTotal)) : 0;
}

/** The "last reading" line for a machine that sends no numbers right now. */
export function readingLine(row: MachineRow, ts: number): string {
  if (row.sampledAt === undefined || row.sampledAt <= 0) return t("machines.lastReading.never");
  return t("machines.lastReading", { time: timeAgo(row.sampledAt, ts) });
}

export function MachineLoad({ row, ts, size }: { row: MachineRow; ts: number; size: MachineLoadSize }) {
  useLocale();
  const large = size === "large";
  const { sample } = row;

  if (sample === undefined || row.health !== "reachable") {
    // A reachable machine with no sample is an older Collie; any other is not answering.
    const text = row.health === "reachable" ? t("machines.noSample") : readingLine(row, ts);
    return <p className="text-sm text-muted-foreground">{text}</p>;
  }

  const cpuText = formatPercent(sample.cpu);
  const mem = memFraction(sample);
  const hasRate = sample.rxBps !== undefined || sample.txBps !== undefined;
  const firing = firingWords(row.firing);

  return (
    <div className={cn("space-y-3", large && "space-y-4")}>
      <Meter
        label={t("machines.metric.cpu")}
        fraction={sample.cpu}
        text={cpuText}
        note={tn("machines.cores", sample.cores)}
        firing={row.firing.includes("cpu")}
        large={large}
      />
      <Meter
        label={t("machines.metric.mem")}
        fraction={mem}
        text={formatBytesOf(sample.memUsed, sample.memTotal)}
        firing={row.firing.includes("mem")}
        large={large}
      />
      {(hasRate || sample.load1 !== undefined) && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {sample.rxBps !== undefined && <Fact label={t("machines.net.down")} value={formatBytesPerSecond(sample.rxBps)} large={large} />}
          {sample.txBps !== undefined && <Fact label={t("machines.net.up")} value={formatBytesPerSecond(sample.txBps)} large={large} />}
          {sample.load1 !== undefined && <Fact label={t("machines.load")} value={formatLoad(sample.load1)} large={large} />}
        </dl>
      )}
      {firing !== null && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-status-blocked">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {firing}
        </p>
      )}
    </div>
  );
}

function Meter({
  label,
  fraction,
  text,
  note,
  firing,
  large,
}: {
  label: string;
  fraction: number;
  text: string;
  note?: string;
  firing: boolean;
  large: boolean;
}) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const percent = Math.round(clamped * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {label}
          {note !== undefined && <span className="ml-1.5">{note}</span>}
        </span>
        <span className={cn("tabular-nums", large ? "text-2xl font-semibold tracking-tight" : "text-sm font-medium")}>{text}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
        className="mt-1 h-2 w-full overflow-hidden rounded-sm bg-muted"
      >
        <div className={cn("h-full", firing ? "bg-status-blocked" : "bg-status-info")} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Fact({ label, value, large }: { label: string; value: string; large: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("tabular-nums", large ? "text-lg font-semibold" : "font-medium")}>{value}</dd>
    </div>
  );
}
