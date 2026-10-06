// A machine's load NOW, the big numbers at the top of the Status view of /machines/:id
// (web/src/components/machine-load.tsx): a CPU bar, a memory bar, one bar per disk, network down and
// up, and the one-minute load. The fullest disk's bar alone turns the blocked colour while a disk alert
// fires. A firing metric says so in WORDS under the numbers ("Alert firing: CPU"): colour alone is not a
// state (WCAG 1.4.1). A machine that is not answering shows its last reading's AGE and no numbers: a
// stale 12% beside the word "unreachable" reads as a calm machine. Every age is measured against the
// answer's own `ts`, never `Date.now()`.
import { on, type Handle } from "remix/component";
import { ChevronRight, TriangleAlert } from "lucide";

import { timeAgo } from "@web/lib/format";
import { t, tn } from "@web/lib/i18n";
import { diskFraction, fullestDisk } from "@web/lib/machine-reading";
import { formatBytesOf, formatBytesPerSecond, formatLoad, formatPercent } from "@web/lib/machine-units";
import type { MachineDisk, MachineMetric, MachineRow, MachineSample } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { Icon } from "../../ui/icon";

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

export interface MachineLoadProps {
  row: MachineRow;
  ts: number;
  size: MachineLoadSize;
  /** Opens the Alerts view. With it, the firing line is a link there. */
  onOpenAlerts?: () => void;
}

export function MachineLoad(handle: Handle<MachineLoadProps>) {
  useLocale(handle);
  return () => {
    const { row, ts, size } = handle.props;
    const large = size === "large";
    const { sample } = row;

    if (sample === undefined || row.health !== "reachable") {
      // A reachable machine with no sample is an older Collie; any other is not answering.
      const text = row.health === "reachable" ? t("machines.noSample") : readingLine(row, ts);
      return <p class="text-sm text-muted-foreground">{text}</p>;
    }

    const hasRate = sample.rxBps !== undefined || sample.txBps !== undefined;
    const firing = firingWords(row.firing);
    return (
      <div class={cn("space-y-3", large && "space-y-4")} data-testid="machine-load">
        <Meter
          label={t("machines.metric.cpu")}
          fraction={sample.cpu}
          text={formatPercent(sample.cpu)}
          note={tn("machines.cores", sample.cores)}
          firing={row.firing.includes("cpu")}
          large={large}
        />
        <Meter
          label={t("machines.metric.mem")}
          fraction={memFraction(sample)}
          text={formatBytesOf(sample.memUsed, sample.memTotal)}
          firing={row.firing.includes("mem")}
          large={large}
        />
        {sample.disks !== undefined && sample.disks.length > 0 ? <DiskBars disks={sample.disks} firing={row.firing.includes("disk")} /> : null}
        {hasRate || sample.load1 !== undefined ? (
          <dl class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {sample.rxBps === undefined ? null : <Fact label={t("machines.net.down")} value={formatBytesPerSecond(sample.rxBps)} large={large} />}
            {sample.txBps === undefined ? null : <Fact label={t("machines.net.up")} value={formatBytesPerSecond(sample.txBps)} large={large} />}
            {sample.load1 === undefined ? null : <Fact label={t("machines.load")} value={formatLoad(sample.load1)} large={large} />}
          </dl>
        ) : null}
        {firing === null ? null : <FiringLine words={firing} onOpen={handle.props.onOpenAlerts} />}
      </div>
    );
  };
}

/**
 * "Alert firing: CPU" in the blocked colour with its mark. With `onOpen`, a link to the Alerts view: a
 * 44px row, the chevron saying it goes somewhere. Shared by the page and the machine card.
 */
export function FiringLine(handle: Handle<{ words: string; onOpen?: (() => void) | undefined; class?: string }>) {
  return () => {
    const { words, onOpen } = handle.props;
    const body = (
      <>
        <Icon icon={TriangleAlert} class="size-4 shrink-0" />
        <span class="min-w-0">{words}</span>
      </>
    );
    if (onOpen === undefined) {
      return <p class={cn("flex items-center gap-1.5 text-sm font-medium text-status-blocked", handle.props.class)}>{body}</p>;
    }
    return (
      <button
        type="button"
        data-slot="machine-firing-link"
        mix={on("click", () => handle.props.onOpen?.())}
        class={cn(
          "-my-2 flex min-h-11 items-center gap-1.5 text-left text-sm font-medium text-status-blocked underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          handle.props.class,
        )}
      >
        {body}
        <Icon icon={ChevronRight} class="size-4 shrink-0" />
      </button>
    );
  };
}

/** One bar per filesystem: mount, used / total, percent. The fullest one carries a firing disk alert. */
function DiskBars(handle: Handle<{ disks: readonly MachineDisk[]; firing: boolean }>) {
  return () => {
    const { disks, firing } = handle.props;
    const fullest = fullestDisk(disks)?.disk;
    return (
      <div class="space-y-2" data-slot="machine-disks">
        <div class="text-xs text-muted-foreground">{t("machines.metric.disk")}</div>
        {disks.map((disk) => {
          const fraction = diskFraction(disk);
          const percent = formatPercent(fraction);
          const bytes = formatBytesOf(disk.used, disk.total);
          const hot = firing && disk === fullest;
          return (
            <div key={disk.mount}>
              <div class="flex items-baseline justify-between gap-3 text-sm">
                <span class="min-w-0 truncate font-mono text-xs">{disk.mount}</span>
                <span class="flex shrink-0 items-baseline gap-2 tabular-nums">
                  <span class="text-xs text-muted-foreground">{bytes}</span>
                  <span class={cn("font-medium", hot && "text-status-blocked")}>{percent}</span>
                </span>
              </div>
              <div
                role="meter"
                aria-label={t("machines.disk.label", { mount: disk.mount })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(fraction * 100)}
                aria-valuetext={`${percent}, ${bytes}`}
                class="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-muted"
              >
                <div class={cn("h-full", hot ? "bg-status-blocked" : "bg-status-info")} style={{ width: `${String(Math.round(fraction * 100))}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };
}

function Meter(handle: Handle<{ label: string; fraction: number; text: string; note?: string; firing: boolean; large: boolean }>) {
  return () => {
    const { label, fraction, text, note, firing, large } = handle.props;
    const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    const percent = Math.round(clamped * 100);
    return (
      <div>
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-xs text-muted-foreground">
            {label}
            {note === undefined ? null : <span class="ml-1.5">{note}</span>}
          </span>
          <span class={cn("tabular-nums", large ? "text-2xl font-semibold tracking-tight" : "text-sm font-medium", firing && "text-status-blocked")}>
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
          class="mt-1 h-2 w-full overflow-hidden rounded-sm bg-muted"
        >
          <div class={cn("h-full", firing ? "bg-status-blocked" : "bg-status-info")} style={{ width: `${String(percent)}%` }} />
        </div>
      </div>
    );
  };
}

function Fact(handle: Handle<{ label: string; value: string; large: boolean }>) {
  return () => {
    const { label, value, large } = handle.props;
    return (
      <div class="flex items-baseline gap-1.5">
        <dt class="text-xs text-muted-foreground">{label}</dt>
        <dd class={cn("tabular-nums", large ? "text-lg font-semibold" : "font-medium")}>{value}</dd>
      </div>
    );
  };
}
