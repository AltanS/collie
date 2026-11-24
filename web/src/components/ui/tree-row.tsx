import type { ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { TreeIndent } from "@/components/ui/tree-indent";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * ONE ROW OF THE TREE ORDER (lib/pane-tree.ts), around the list's own row: the indent for its depth, then a
 * 28px column that holds the fold toggle when the row starts a branch and stays empty otherwise, so siblings
 * line up whether or not they have children. The toggle is a SIBLING of the row's button, never inside it
 * (DESIGN.md, `ui/row-open.ts`: no control is nested in the button), 44px tall like the row.
 */
export function TreeRow({
  depth,
  branch,
  folded,
  name,
  onToggle,
  children,
}: {
  depth: number;
  /** True when the row starts a branch the toggle can fold. */
  branch: boolean;
  folded: boolean;
  /** The row's name, for the toggle's accessible name. */
  name: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  useLocale();
  return (
    <div data-slot="tree-row" className="flex min-w-0 items-stretch">
      <TreeIndent depth={depth} />
      {branch ? (
        <button
          type="button"
          data-slot="tree-toggle"
          aria-expanded={!folded}
          aria-label={t(folded ? "tree.expand" : "tree.collapse", { name })}
          onClick={onToggle}
          className="flex min-h-11 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground active:bg-muted"
        >
          <Icon
            name="disclosure"
            className={cn("size-4 motion-safe:transition-transform", !folded && "rotate-90")}
            aria-hidden
          />
        </button>
      ) : (
        <span aria-hidden className="w-7 shrink-0" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * What a folded branch hides, beside its starter's name: the sessions inside that wait on the operator, in the
 * blocked ink with the status mark, and a muted count of everything else it hides. Nothing when it hides none.
 */
export function FoldSummary({ hidden, waiting, className }: { hidden: number; waiting: number; className?: string }) {
  useLocale();
  if (hidden === 0) return null;
  return (
    <span data-slot="fold-summary" className={cn("flex shrink-0 items-center gap-1", className)}>
      {/* The counts are drawn for the eye; the words say the same to a screen reader. */}
      <span className="sr-only">
        {waiting > 0 && `${tn("tree.waiting", waiting)}, `}
        {tn("tree.hidden", hidden)}
      </span>
      {waiting > 0 && (
        <Badge
          variant="secondary"
          aria-hidden
          className="h-4 gap-1 px-1 py-0 text-[11px] leading-none tabular-nums text-status-blocked"
        >
          <StatusDot status="blocked" surface="bg-secondary" className="size-2.5" />
          {waiting}
        </Badge>
      )}
      <span aria-hidden className="text-[11px] leading-none tabular-nums text-muted-foreground">
        +{hidden}
      </span>
    </span>
  );
}
