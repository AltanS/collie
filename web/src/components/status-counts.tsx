import { Check } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { StatusDot } from "@/components/status-badge";
import { hasResizeObserver } from "@/lib/env";
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
 * A workspace heading passes nothing and gets the numbers alone, since the summary above has already
 * taught what each mark means and a word on every heading was the same word eight times. `labelled`
 * is the dashboard's summary line and hands over to {@link SummaryCounts}, which spells the words.
 *
 * ONE BASELINE (2026-09-16): every mark sits in the same 12px box and every item is `leading-none`
 * inside one `items-center` row, so a square, a dot and a digit share a centre line. The unseen count
 * used to sit a pixel high because its mark and its text were centred in an inline-flex that sat on
 * the parent's text baseline.
 *
 * ONE COUNT, ONE PIECE: a count never breaks inside itself, and never wraps to a second line. The
 * row is `flex-nowrap` and `overflow-hidden`, each count is `shrink-0` so a number never cuts
 * mid-digit, and when the set is still wider than the slot the right edge fades under the same mask
 * the belt's scrollers use (`ui/overflow-edges.tsx`, measured, so a row that fits is never faded).
 * A bare count's word lives in an `aria-label`, so the button still reads every count in words.
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
  if (labelled) return <SummaryCounts panes={panes} className={className} />;
  return <BareCounts panes={panes} className={className} />;
}

/** The states a row shows, in urgency order, with their words: zero counts are omitted. */
function shownCounts(panes: readonly AgentView[]) {
  const n = countStates(panes);
  return ORDER.filter((c) => n[keyOf(c)] > 0).map((c) => {
    const k = keyOf(c);
    const word = c.kind === "unseen" ? t("home.row.unseen") : statusLabel(c.status);
    return { c, k, count: n[k], word };
  });
}

function CountMark({ c }: { c: Counted }) {
  return (
    <span aria-hidden className="flex size-3 shrink-0 items-center justify-center">
      {c.kind === "unseen" ? <UnseenMark size="sm" /> : <StatusDot status={c.status} className="size-2" />}
    </span>
  );
}

/** The numbers-only row: a workspace heading's counts, and the muted counts of the all-clear line. */
function BareCounts({ panes, className }: { panes: readonly AgentView[]; className?: string | undefined }) {
  useLocale();
  const { ref, edge } = useOverflowEdges<HTMLSpanElement>();
  const shown = shownCounts(panes);
  if (shown.length === 0) return null;
  return (
    <span
      ref={ref}
      className={cn(
        "flex min-w-0 flex-nowrap items-center gap-x-3 overflow-hidden py-0.5 leading-none tabular-nums",
        edge === "right" && MASK.right,
        className,
      )}
    >
      {shown.map(({ c, k, count, word }) => (
        <span
          key={k}
          className={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap", k === "blocked" && "text-status-blocked")}
          // Numbers alone still say what they count to a screen reader.
          aria-label={`${count} ${word}`}
        >
          <CountMark c={c} />
          <span aria-hidden>{count}</span>
        </span>
      ))}
    </span>
  );
}

/** How far a summary row has been cut back: how many counts still spell their word, how many show. */
interface SummaryFit {
  key: string;
  spelled: number;
  shown: number;
}

/**
 * The dashboard's summary words, ONE LINE AT EVERY WIDTH (2026-10-07). The line sits beside the
 * needs-you switch and gets what is left of the row: 284px at 360, 314 at 390, 336 at 412. The rule
 * that keeps it one line is applied in this order, and every step is a measurement of the real glyphs
 * in the real locale, never a count of how many states there are:
 *
 *   1. A state with a zero count is not drawn.
 *   2. Every count spells its word ("3 needs you", "2 unseen", "7 working", "2 idle").
 *   3. Too wide, and the LOWEST-priority count drops its word and keeps its dot and number, then the
 *      next one up, in the order idle, done, working, unseen. The worst count keeps its word longest.
 *   4. Last, the worst count drops its word too, and the row is dots and numbers.
 *   5. Wider still (huge numbers, a very narrow phone), whole counts leave the row from the right,
 *      lowest priority first. Nothing is ever cut mid-word or mid-number and no ellipsis is drawn.
 *
 * A dropped word and a dropped count are not lost: every count keeps an `aria-label` in words, and
 * a count that left the row stays in the document as screen-reader text. The words are the part of
 * the line that costs width and carries the least: the mark is the state's colour, the number is the
 * fact.
 *
 * HOW IT MEASURES. The row is `overflow-hidden` and `flex-nowrap`, and a layout effect after every
 * render asks whether it overflows its slot; if it does it steps one rung down (step 3, 4, 5) and
 * renders again BEFORE paint, so the line is never seen wider than its slot. A change of slot width,
 * of the words (a locale) or of the counts starts again from step 2, because widening the slot has to
 * give the words back. The slot is the row's own box, so it must be `flex-1` inside its button:
 * a row sized by its content could never see that it was too wide. jsdom has no layout, so a test
 * hands the row a width and reads which rung it stopped on.
 */
function SummaryCounts({ panes, className }: { panes: readonly AgentView[]; className?: string | undefined }) {
  useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const [slot, setSlot] = useState(0);
  const [fontTick, setFontTick] = useState(0);
  const [fit, setFit] = useState<SummaryFit | null>(null);
  const shown = shownCounts(panes);
  const present = shown.length > 0;
  const key = `${slot}|${fontTick}|${shown.map((s) => `${s.count} ${s.word}`).join("|")}`;
  // A fit measured for another slot, another word or another set of counts is stale: start over.
  const now: SummaryFit = fit !== null && fit.key === key ? fit : { key, spelled: shown.length, shown: shown.length };

  // Before paint, after every render that changes the words, the slot or the rung: one rung down
  // while the row is wider than its slot. The 1px slack is the usual sub-pixel guard
  // (`useOverflowEdges`). Each step lowers `spelled` or `shown`, so this stops.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || el.scrollWidth - el.clientWidth <= 1) return;
    if (now.spelled > 0) setFit({ key, spelled: now.spelled - 1, shown: now.shown });
    else if (now.shown > 1) setFit({ key, spelled: 0, shown: now.shown - 1 });
    // `now` is rebuilt every render, so the rung is what the effect depends on, not the object.
  }, [key, now.spelled, now.shown]);

  // The slot's width, and the fonts finishing: both change what fits without changing a render.
  // Only the slot is observed, never the counts inside it, or each step would start a new round.
  // The first read is before paint, so the slot the first fit used is the real one.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => setSlot(Math.round(el.clientWidth));
    measure();
    const ro = hasResizeObserver() ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    // Guarded for jsdom, which has no font set.
    const fonts = "fonts" in document ? document.fonts : null;
    const onFonts = () => setFontTick((tick) => tick + 1);
    fonts?.addEventListener("loadingdone", onFonts);
    return () => {
      ro?.disconnect();
      fonts?.removeEventListener("loadingdone", onFonts);
    };
  }, [present]);

  if (!present) return null;
  return (
    <span
      ref={ref}
      className={cn(
        "flex min-w-0 flex-1 flex-nowrap items-center gap-x-2 overflow-hidden py-0.5 leading-none tabular-nums",
        className,
      )}
    >
      {shown.map(({ c, k, count, word }, i) => {
        const spelled = i < now.spelled;
        const visible = i < now.shown;
        return (
          <span
            key={k}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap",
              k === "blocked" && "text-status-blocked",
              // Off the row, still in the document for a screen reader.
              !visible && "sr-only",
            )}
            // A bare count still says what it counts to a screen reader.
            aria-label={spelled ? undefined : `${count} ${word}`}
          >
            <CountMark c={c} />
            <span aria-hidden={spelled ? undefined : true}>{spelled ? `${count} ${word}` : count}</span>
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
