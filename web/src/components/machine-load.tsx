import { ChevronRight, TriangleAlert } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { timeAgo } from "@/lib/format";
import { t, tn } from "@/lib/i18n";
import { diskFraction, fullestDisk } from "@/lib/machine-reading";
import { formatBytesOf, formatBytesPerSecond, formatLoad, formatPercent } from "@/lib/machine-units";
import type { MachineDisk, MachineMetric, MachineRow, MachineSample } from "@/lib/types";
import { cn } from "@/lib/utils";

// A machine's load NOW, the big numbers at the top of the Status view of /machines/:id: a CPU bar, a
// memory bar, one bar per disk, network down and up, and the one-minute load.
//
// ── ONE BAR PER DISK ─────────────────────────────────────────────────────────
// Each filesystem the machine reports (home, root, the state folder, one per device) gets its mount,
// used and total in one unit, the percent, and a bar. The fullest one is the disk the alert judges, so
// its bar alone turns the blocked colour while a disk alert fires. A mount label may be cut short; a
// number never is.
//
// ── A FIRING METRIC SAYS SO IN WORDS ─────────────────────────────────────────
// The bar of a metric whose alert is firing turns the blocked colour, and a line under the numbers
// names it ("Alert firing: CPU"). Colour alone is not a state (WCAG 1.4.1), and the push that got the
// operator here said the same words. Where the page can show the rules, the line is a link to the
// Alerts view.
//
// ── NO NUMBERS FROM A MACHINE THAT IS NOT ANSWERING ──────────────────────────
// An unreachable, incompatible or conflicted machine shows its last reading's AGE and no numbers: a
// stale 12% beside the word "unreachable" reads as a calm machine. A reachable machine that sends no
// sample is an older Collie, and the line says what to do about it. Every age is measured against the
// answer's own `ts`, never `Date.now()`.

export type MachineLoadSize = "card" | "large";

const METRIC_KEY = { cpu: "machines.metric.cpu", mem: "machines.metric.mem", disk: "machines.metric.disk" } as const;

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

export function MachineLoad({
  row,
  ts,
  size,
  onOpenAlerts,
}: {
  row: MachineRow;
  ts: number;
  size: MachineLoadSize;
  /** Opens the Alerts view. With it, the firing line is a link there. */
  onOpenAlerts?: () => void;
}) {
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
      {sample.disks !== undefined && sample.disks.length > 0 && (
        <DiskBars disks={sample.disks} firing={row.firing.includes("disk")} />
      )}
      {(hasRate || sample.load1 !== undefined) && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {sample.rxBps !== undefined && <Fact label={t("machines.net.down")} value={formatBytesPerSecond(sample.rxBps)} large={large} />}
          {sample.txBps !== undefined && <Fact label={t("machines.net.up")} value={formatBytesPerSecond(sample.txBps)} large={large} />}
          {sample.load1 !== undefined && <Fact label={t("machines.load")} value={formatLoad(sample.load1)} large={large} />}
        </dl>
      )}
      {firing !== null && <FiringLine words={firing} onOpen={onOpenAlerts} />}
    </div>
  );
}

/**
 * "Alert firing: CPU" in the blocked colour with its mark. With `onOpen`, a link to the Alerts view:
 * a 44px row, the chevron saying it goes somewhere. Shared by the page and the machine card.
 */
export function FiringLine({ words, onOpen, className }: { words: string; onOpen?: () => void; className?: string }) {
  const body = (
    <>
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{words}</span>
    </>
  );
  if (onOpen === undefined) {
    return <p className={cn("flex items-center gap-1.5 text-sm font-medium text-status-blocked", className)}>{body}</p>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      data-slot="machine-firing-link"
      className={cn(
        "-my-2 flex min-h-11 items-center gap-1.5 text-left text-sm font-medium text-status-blocked underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      {body}
      <ChevronRight className="size-4 shrink-0" aria-hidden />
    </button>
  );
}

/** One bar per filesystem: mount, used / total, percent. The fullest one carries a firing disk alert. */
function DiskBars({ disks, firing }: { disks: readonly MachineDisk[]; firing: boolean }) {
  const fullest = fullestDisk(disks)?.disk;
  return (
    <div className="space-y-2" data-slot="machine-disks">
      <div className="text-xs text-muted-foreground">{t("machines.metric.disk")}</div>
      {disks.map((disk) => {
        const fraction = diskFraction(disk);
        const percent = formatPercent(fraction);
        const bytes = formatBytesOf(disk.used, disk.total);
        const hot = firing && disk === fullest;
        return (
          <div key={disk.mount}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-mono text-xs">{disk.mount}</span>
              <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                <span className="text-xs text-muted-foreground">{bytes}</span>
                <span className={cn("font-medium", hot && "text-status-blocked")}>{percent}</span>
              </span>
            </div>
            <div
              role="meter"
              aria-label={t("machines.disk.label", { mount: disk.mount })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              aria-valuetext={`${percent}, ${bytes}`}
              className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-muted"
            >
              <div className={cn("h-full", hot ? "bg-status-blocked" : "bg-status-info")} style={{ width: `${Math.round(fraction * 100)}%` }} />
            </div>
          </div>
        );
      })}
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
        <span className={cn("tabular-nums", large ? "text-2xl font-semibold tracking-tight" : "text-sm font-medium", firing && "text-status-blocked")}>
          {text}
        </span>
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
