import { Progress } from "@/components/ui/progress";
import { t } from "@/lib/i18n";
import { type ProgressReading } from "@/lib/pane-marks";
import { cn } from "@/lib/utils";

// THE PROGRESS ROW UNDER CHAT'S HEADER (WIRE.md 7.12): what a working durable conversation is doing and
// how far it is. One 16px line of text over a 4px bar, 20px with the gap, so the row's height is stated and
// only `Collapse` (the caller's) moves content when it arrives. A step list reads as the running step's
// label with its place, a percent as its label (when it has one) and the number. A program's strings are
// text nodes only.

export function PaneProgressRow({ reading, className }: { reading: ProgressReading; className?: string }) {
  const name = t("chat.progress.aria");
  return (
    <div data-slot="pane-progress" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex h-4 min-w-0 items-baseline gap-2 text-xs leading-4 text-muted-foreground">
        {reading.kind === "steps" ? (
          <span data-slot="pane-progress-text" className="min-w-0 truncate">
            {t("chat.progress.step", { label: reading.label, n: reading.n, m: reading.m })}
          </span>
        ) : (
          <>
            <span data-slot="pane-progress-text" className="min-w-0 flex-1 truncate">
              {reading.label}
            </span>
            <span data-slot="pane-progress-value" className="shrink-0 tabular-nums">
              {t("chat.progress.percent", { value: Math.round(reading.value) })}
            </span>
          </>
        )}
      </div>
      <Progress value={reading.value} label={name} />
    </div>
  );
}
