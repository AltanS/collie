import { ChevronRight } from "lucide-react";

import { ChangeCountSlot } from "@/components/change-count";
import { ListGroup } from "@/components/ui/list-group";
import { countFor, type WorkspaceChangeTarget } from "@/hooks/use-workspace-change-counts";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { spaceChangesPath } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { WorkspaceChangeCount } from "@/lib/workspace-changes";

/** One row: the workspace's heading text and where its answer is kept. */
export interface WorkspaceChangesRow extends WorkspaceChangeTarget {
  label: string;
}

/**
 * The dashboard's Changes tab (ADR 0066): every workspace the strip leaves shown, in the dashboard's
 * own order, with its changed-file count and its summed +added −removed. A tap opens that
 * workspace's Changes route, and hands the row's button along so the label and the count line can
 * glide into that screen's header (lib/glide.ts, the `changes` pair). Each button is the pair's
 * origin, keyed by the path it opens, so that screen's back arrow can find it and glide back into it.
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
  onOpen: (row: WorkspaceChangesRow, from: HTMLElement) => void;
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
              data-glide-origin="changes"
              data-glide-key={spaceChangesPath(row.workspaceId, row.scope)}
              onClick={(e) => onOpen(row, e.currentTarget)}
              className={cn(
                "flex min-h-13 w-full items-center gap-3 px-3.5 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                "count-row",
                quiet && "opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                {/* `self-start max-w-full`: the label's box is its text, not the row, so its snapshot
                    has the same shape as the header's label it glides into. */}
                <span data-glide="label" className="max-w-full self-start truncate text-sm font-medium leading-5">
                  {row.label}
                </span>
                <span className="flex h-4 items-center text-xs leading-4 text-muted-foreground tabular-nums">
                  <ChangeCountSlot count={count} glide="count" />
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
