import { ChevronRight } from "lucide-react";

import { ListGroup } from "@/components/ui/list-group";
import { countFor, type WorkspaceChangeTarget } from "@/hooks/use-workspace-change-counts";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { WorkspaceChangeCount } from "@/lib/workspace-changes";

/** One row: the workspace's heading text and where its answer is kept. */
export interface WorkspaceChangesRow extends WorkspaceChangeTarget {
  label: string;
}

/** The second line's words, or the numbers. One line box in every state, so nothing moves. */
function CountLine({ count }: { count: WorkspaceChangeCount }) {
  switch (count.kind) {
    case "loading":
      return <span>{t("home.changes.loading")}</span>;
    case "clean":
      return <span>{t("home.changes.clean")}</span>;
    case "no-folder":
      return <span>{t("home.changes.noFolder")}</span>;
    case "unavailable":
      return <span>{t("home.changes.unavailable")}</span>;
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
                quiet && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm font-medium leading-5">{row.label}</span>
                <span className="flex h-4 items-center text-xs leading-4 text-muted-foreground tabular-nums">
                  <CountLine count={count} />
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
