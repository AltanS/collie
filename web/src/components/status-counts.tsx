import { Check } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { MASK, useOverflowEdges } from "@/components/ui/overflow-edges";
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

/** The most counts a labelled row can hold and still spell its first one in words. Three or more
 *  and the words would push the later counts under the fade, so all of them go bare (2026-10-06). */
const SPELLED_MAX_COUNTS = 2;

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
 * `labelled` is the dashboard's summary line, the one place a word is spelled: the first count only,
 * and only while the row holds two counts or fewer ("2 needs you", then a bare number); a workspace heading passes nothing and gets the numbers alone,
 * since the summary above has already taught what each mark means and a word on every heading was
 * the same word eight times.
 *
 * ONE BASELINE (2026-09-16): every mark sits in the same 12px box and every item is `leading-none`
 * inside one `items-center` row, so a square, a dot and a digit share a centre line. The unseen count
 * used to sit a pixel high because its mark and its text were centred in an inline-flex that sat on
 * the parent's text baseline.
 *
 * ONE COUNT, ONE PIECE: a count never breaks inside itself, and never wraps to a second line.
 *
 * ONE ROW, ALWAYS (2026-10-06): the dashboard's summary is a single line and never taller. The
 * controls beside it are 188px and `shrink-0`, so the line gets what is left: 162px at 390 and 92px
 * at 320. Labelled, the FIRST (worst) count keeps its word ("2 needs you") only while the row holds
 * two counts or fewer; with three or more, every count is a dot and a number in its own ink, the
 * way the numbers-only row draws them, so five fit the 162px slot at 390 (8px apart, 159px). A bare count's word moves
 * into an `aria-label`, so the button still reads every count in words. The row is `flex-nowrap` and
 * `overflow-hidden`, each count is `shrink-0` so a number never cuts mid-digit, and when the set
 * is still wider than the slot (huge numbers, a narrow phone) the right edge fades under the same
 * mask the belt's scrollers use (`ui/overflow-edges.tsx`, measured, so a row that fits is never
 * faded). It used to wrap whole counts onto further rows, up to five, and a long label ran under
 * the controls at 320.
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
  const { ref, edge } = useOverflowEdges<HTMLSpanElement>();
  const n = countStates(panes);
  const shown = ORDER.filter((c) => n[keyOf(c)] > 0);
  if (shown.length === 0) return null;
  return (
    <span
      ref={ref}
      className={cn(
        "flex min-w-0 flex-nowrap items-center overflow-hidden py-0.5 leading-none tabular-nums",
        // The summary packs its counts 8px apart: five bare counts at realistic numbers measure 175px
        // at 12px and 159px at 8px, against the 162px slot at 390. A heading's counts keep 12px.
        labelled ? "gap-x-2" : "gap-x-3",
        edge === "right" && MASK.right,
        className,
      )}
    >
      {shown.map((c, i) => {
        const k = keyOf(c);
        // Labelled, the first count alone spells its word, and only while the row holds two counts
        // or fewer; with three or more every count is bare and names itself.
        const spelled = labelled && i === 0 && shown.length <= SPELLED_MAX_COUNTS;
        const word = c.kind === "unseen" ? t("home.row.unseen") : statusLabel(c.status);
        return (
          <span
            key={k}
            className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap", k === "blocked" && "text-status-blocked")}
            // Numbers alone still say what they count to a screen reader.
            aria-label={spelled ? undefined : `${n[k]} ${word}`}
          >
            <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
              {c.kind === "unseen" ? <UnseenMark size="sm" /> : <StatusDot status={c.status} className="size-2" />}
            </span>
            <span aria-hidden={spelled ? undefined : true}>
              {spelled ? `${n[k]} ${word}` : n[k]}
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
 *
 * `focusable` keeps a line with no `onJump` reachable by script: `aria-disabled` and `tabIndex={-1}`
 * in place of `disabled`, so it stays out of the tab order and still announces itself unavailable,
 * but focus can land on it. The dashboard asks for it once pins are in play, because focus goes to
 * this line when an unpinned row leaves Focus's list (ADR 0070), and a disabled button cannot hold
 * focus. The box is the same either way.
 */
export function StatusSummaryLine({
  panes,
  allClear,
  onJump,
  id,
  focusable = false,
  className,
}: {
  panes: readonly AgentView[];
  allClear: boolean;
  onJump?: (() => void) | undefined;
  id?: string;
  focusable?: boolean;
  className?: string;
}) {
  useLocale();
  const inert = onJump === undefined;
  return (
    <button
      id={id}
      type="button"
      onClick={onJump}
      disabled={inert && !focusable}
      aria-disabled={inert && focusable ? true : undefined}
      tabIndex={inert && focusable ? -1 : undefined}
      className={cn(
        "flex min-h-8 min-w-0 max-w-full items-center gap-3 text-left text-xs font-medium text-foreground disabled:opacity-100",
        className,
      )}
    >
      {allClear && (
        <span className="flex min-w-0 items-center gap-1.5 leading-none">
          <Check className="size-4 shrink-0 text-status-done" aria-hidden />
          <span className="min-w-0 truncate">{t("home.allClear")}</span>
        </span>
      )}
      <StatusCounts panes={panes} labelled={!allClear} className={allClear ? "text-muted-foreground" : undefined} />
    </button>
  );
}
