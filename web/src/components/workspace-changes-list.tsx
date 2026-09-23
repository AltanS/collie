import { ChevronRight } from "lucide-react";
import { useState } from "react";

import { ListGroup } from "@/components/ui/list-group";
import { countFor, type WorkspaceChangeTarget } from "@/hooks/use-workspace-change-counts";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { countArrival, countSignature, type CountArrival, type WorkspaceChangeCount } from "@/lib/workspace-changes";

/** One row: the workspace's heading text and where its answer is kept. */
export interface WorkspaceChangesRow extends WorkspaceChangeTarget {
  label: string;
}

/** The second line's words, or the numbers. */
function CountText({ count }: { count: Exclude<WorkspaceChangeCount, { kind: "loading" }> }) {
  switch (count.kind) {
    case "clean":
      return <>{t("home.changes.clean")}</>;
    case "no-folder":
      return <>{t("home.changes.noFolder")}</>;
    case "unavailable":
      return <>{t("home.changes.unavailable")}</>;
    case "changed":
      return (
        <span className="flex items-center gap-2">
          <span>{tn("home.changes.files", count.files)}</span>
          <span className="font-mono text-[11px]">
            <span className="text-status-done">+{count.added}</span>{" "}
            <span className="text-status-blocked">−{count.removed}</span>
          </span>
        </span>
      );
  }
}

/**
 * A row's second line: a skeleton bar until the first answer, then the words or the numbers. The
 * bar and the text share ONE grid cell inside the fixed 16px line, so the swap moves nothing.
 *
 * How a value shows (`countArrival`): the first answer crossfades in over the skeleton; a later,
 * different value swaps in place with a short opacity dip; an answer the page kept from an earlier
 * visit shows at once. The arrival is decided once per value, so a refresh with the same answer
 * renders the same classes and touches no node. The motion lives in index.css (`.count-*`), which
 * turns all of it off under reduced motion.
 */
function CountSlot({ count }: { count: WorkspaceChangeCount }) {
  const sig = countSignature(count);
  const [shown, setShown] = useState<{ sig: string; how: CountArrival }>(() => ({
    sig,
    how: countArrival(null, count),
  }));
  let how = shown.how;
  if (shown.sig !== sig) {
    how = countArrival(shown.sig, count);
    setShown({ sig, how });
  }
  const loading = count.kind === "loading";
  return (
    <span className="grid h-4 items-center [grid-template-areas:'slot'] *:[grid-area:slot]" data-slot="count-line" data-state={loading ? "loading" : how}>
      <span aria-hidden className={cn("count-skeleton h-2.5 w-24 rounded-full bg-muted", !loading && "count-skeleton--done")} />
      {loading ? (
        <span className="sr-only">{t("home.changes.loading")}</span>
      ) : (
        <span key={sig} className={cn(how === "arrive" && "count-arrive", how === "update" && "count-update")}>
          <CountText count={count} />
        </span>
      )}
    </span>
  );
}

/**
 * The dashboard's Changes tab (ADR 0066): every workspace the strip leaves shown, in the dashboard's
 * own order, with its changed-file count and its summed +added −removed. A tap opens that
 * workspace's Changes route.
 *
 * NO ROW MOVES AS ANSWERS ARRIVE. Every row is listed from the first paint, each with its two lines
 * reserved, and a count fills its own line in place. A workspace with nothing to show (clean, or no
 * folder to read) stays in its place, dimmed, rather than folding under a "N clean" line: a fold
 * would move every row below it the moment the last answer came in.
 */
export function WorkspaceChangesList({
  rows,
  counts,
  onOpen,
}: {
  rows: readonly WorkspaceChangesRow[];
  counts: ReadonlyMap<string, WorkspaceChangeCount>;
  onOpen: (row: WorkspaceChangesRow) => void;
}) {
  useLocale();
  return (
    <ListGroup as="ul" aria-label={t("home.changes.listAria")}>
      {rows.map((row) => {
        const count = countFor(counts, row.key);
        const quiet = count.kind === "clean" || count.kind === "no-folder";
        return (
          <li key={row.key}>
            <button
              type="button"
              onClick={() => onOpen(row)}
              className={cn(
                "flex min-h-13 w-full items-center gap-3 px-3.5 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                "count-row",
                quiet && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm font-medium leading-5">{row.label}</span>
                <span className="flex h-4 items-center text-xs leading-4 text-muted-foreground tabular-nums">
                  <CountSlot count={count} />
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </li>
        );
      })}
    </ListGroup>
  );
}
