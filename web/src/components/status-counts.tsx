import { Check } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { UnseenMark } from "@/components/ui/unseen-mark";
import { isUnseen } from "@/lib/triage";
import { statusLabel, type AgentStatus, type AgentView } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { cn } from "@/lib/utils";

/** One counted state: an agent status drawn as its dot, or "unseen" drawn as the square. */
type Counted = { kind: "status"; status: AgentStatus } | { kind: "unseen" };
const ORDER: readonly Counted[] = [
  { kind: "status", status: "blocked" },
  { kind: "unseen" },
  { kind: "status", status: "working" },
  { kind: "status", status: "done" },
  { kind: "status", status: "idle" },
];

/** The per-state tallies; `unseen` panes are counted there and not under their done/idle status. */
export interface StateCounts {
  blocked: number;
  unseen: number;
  working: number;
  done: number;
  idle: number;
}

const keyOf = (c: Counted): keyof StateCounts =>
  c.kind === "unseen" ? "unseen" : c.status === "blocked" || c.status === "working" || c.status === "done" ? c.status : "idle";

export function countStates(panes: readonly AgentView[]): StateCounts {
  const n: StateCounts = { blocked: 0, unseen: 0, working: 0, done: 0, idle: 0 };
  for (const p of panes) {
    if (p.kind === "shell") continue;
    if (p.status === "blocked") n.blocked++;
    else if (isUnseen(p)) n.unseen++;
    else if (p.status === "working") n.working++;
    else if (p.status === "done") n.done++;
    else if (p.status === "idle") n.idle++;
  }
  return n;
}

/**
 * A row of state counters: a mark and a number per state that has any, in urgency order.
 *
 * `labelled` is the dashboard's summary line, the one place the words are spelled ("2 needs you");
 * a workspace heading passes nothing and gets the numbers alone, since the summary above has already
 * taught what each mark means and a word on every heading was the same word eight times.
 *
 * ONE BASELINE (2026-09-16): every mark sits in the same 12px box and every item is `leading-none`
 * inside one `items-center` row, so a square, a dot and a digit share a centre line. The unseen count
 * used to sit a pixel high because its mark and its text were centred in an inline-flex that sat on
 * the parent's text baseline.
 *
 * ONE COUNT, ONE PIECE: a count never breaks inside itself. When all five states will not fit a
 * phone's width, whole counts move to a second line.
 */
export function StatusCounts({
  panes,
  labelled = false,
  className,
}: {
  panes: readonly AgentView[];
  labelled?: boolean;
  className?: string;
}) {
  useLocale();
  const n = countStates(panes);
  const shown = ORDER.filter((c) => n[keyOf(c)] > 0);
  if (shown.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 leading-none tabular-nums", className)}>
      {shown.map((c) => {
        const k = keyOf(c);
        const word = c.kind === "unseen" ? t("home.row.unseen") : statusLabel(c.status);
        return (
          <span
            key={k}
            className={cn("flex items-center gap-1.5 whitespace-nowrap", k === "blocked" && "text-status-blocked")}
            // Numbers alone still say what they count to a screen reader.
            aria-label={labelled ? undefined : `${n[k]} ${word}`}
          >
            <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
              {c.kind === "unseen" ? <UnseenMark size="sm" /> : <StatusDot status={c.status} className="size-2" />}
            </span>
            <span aria-hidden={labelled ? undefined : true}>
              {labelled ? `${n[k]} ${word}` : n[k]}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The summary line: the twenty-times-a-day glance, in ONE slot of one height. The dashboard's line
 * over every agent, and the pane switcher's "Needs you" line over the urgent ones alone, are this
 * one component, so the two can never spell the same fact two ways.
 *
 * `allClear` leads with the check and the "Nothing needs you" words, and turns the counts muted and
 * unlabelled; otherwise the counts carry their words. A tap goes to the first urgent thing via
 * `onJump`; with no `onJump` the line is a disabled button that still reads at full ink, so the slot
 * and its box are the same in every state (DESIGN.md §2).
 */
export function StatusSummaryLine({
  panes,
  allClear,
  onJump,
  className,
}: {
  panes: readonly AgentView[];
  allClear: boolean;
  onJump?: (() => void) | undefined;
  className?: string;
}) {
  useLocale();
  return (
    <button
      type="button"
      onClick={onJump}
      disabled={onJump === undefined}
      className={cn(
        "flex min-h-8 items-center gap-3 text-left text-xs font-medium text-foreground disabled:opacity-100",
        className,
      )}
    >
      {allClear && (
        <span className="flex items-center gap-1.5 leading-none">
          <Check className="size-4 shrink-0 text-status-done" aria-hidden />
          {t("home.allClear")}
        </span>
      )}
      <StatusCounts panes={panes} labelled={!allClear} className={allClear ? "text-muted-foreground" : undefined} />
    </button>
  );
}
