import { StatusDot } from "@/components/status-badge";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { PaneJob } from "@/lib/types";
import { cn } from "@/lib/utils";

// The pane's background jobs, as a sheet over the page (issue 670, ADR 0128). A sheet for the reason the
// Agents sheet is one (agents-sheet.tsx): it floats, so nothing in flow moves when it opens.
//
// Two groups, in the order the bridge sends them: the jobs still running, each with its label, its
// command and how long it has run; then the jobs that ended in the last minutes, each with its exit
// code where the harness gave one and how long ago it ended. The rows send nothing and open nothing:
// a job has no transcript of its own, and its output is in Chat.

interface JobsSheetProps {
  open: boolean;
  onClose: () => void;
  /** ALREADY TRANSLATED. "Jobs 1", the same words the mark on the belt is named by. */
  title: string;
  jobs: readonly PaneJob[];
}

export function JobsSheet({ open, onClose, title, jobs }: JobsSheetProps) {
  useLocale();
  const running = jobs.filter((job) => job.endedAt === undefined);
  const ended = jobs.filter((job) => job.endedAt !== undefined);
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-3">
        {running.length > 0 && <JobGroup slot="jobs-running" heading={t("belt.jobs.running")} jobs={running} />}
        {ended.length > 0 && <JobGroup slot="jobs-ended" heading={t("belt.jobs.ended")} jobs={ended} />}
      </div>
    </BottomSheet>
  );
}

function JobGroup({ slot, heading, jobs }: { slot: string; heading: string; jobs: readonly PaneJob[] }) {
  return (
    <section data-slot={slot} className="-mx-4">
      <h3 className="px-4 pb-1 text-xs font-medium text-muted-foreground">{heading}</h3>
      <ul className="divide-y divide-border">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} />
        ))}
      </ul>
    </section>
  );
}

function JobRow({ job }: { job: PaneJob }) {
  const ended = job.endedAt !== undefined;
  // Running: how long it has run. Ended: how long ago it ended.
  const at = Date.parse(job.endedAt ?? job.startedAt);
  const failed = job.exitCode !== undefined && job.exitCode !== 0;
  return (
    <li data-slot="belt-job" className="flex min-h-11 w-full items-start gap-2.5 px-4 py-2.5 text-left text-sm leading-snug">
      <StatusDot status={ended ? "done" : "working"} surface="bg-card" className="mt-1" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        {job.label !== "" && <span className="truncate text-xs font-medium text-muted-foreground">{job.label}</span>}
        <code data-slot="belt-job-command" className="font-mono text-xs break-all">
          {job.command}
        </code>
        {job.exitCode !== undefined && (
          <span data-slot="belt-job-exit" className={cn("text-xs tabular-nums", failed ? "text-destructive" : "text-muted-foreground")}>
            {t("belt.jobs.exit", { code: job.exitCode })}
          </span>
        )}
      </span>
      {Number.isFinite(at) && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgoShort(at)}</span>}
    </li>
  );
}
