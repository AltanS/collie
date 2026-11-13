import { Icon } from "@/components/icons/icon";
import { StatusDot } from "@/components/status-badge";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { TreeGuide } from "@/lib/pane-tree";
import { statusLabel, type AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Box-drawing guides in front of a nested child pane row (`├`, `└`, `│`), shaped after Herdr App's
 * `agents` sidebar so parent-child depth reads at a glance without taking width from top-level rows.
 */
export function PaneTreeGuides({
  guides,
  className,
}: {
  guides: readonly TreeGuide[];
  className?: string;
}) {
  if (guides.length === 0) return null;
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center self-stretch", className)}>
      {guides.map((guide, depth) => (
        <span key={`${String(depth)}-${guide}`} className="relative h-full w-3.5 shrink-0">
          {(guide === "│" || guide === "├") && (
            <span className="absolute inset-y-0 left-1 w-px bg-border" />
          )}
          {guide === "└" && (
            <span className="absolute top-0 bottom-1/2 left-1 w-px bg-border" />
          )}
          {(guide === "├" || guide === "└") && (
            <span className="absolute top-1/2 right-0.5 left-1 h-px bg-border" />
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * Sibling disclosure control beside a parent row that owns live sub-agents. Kept outside the parent
 * row's `<button>` so the markup never nests interactive controls and a fold tap never navigates.
 */
export function PaneTreeFoldButton({
  count,
  status,
  folded,
  onToggle,
  surface = "bg-background",
  className,
}: {
  count: number;
  status: AgentStatus | undefined;
  folded: boolean;
  onToggle: (() => void) | undefined;
  surface?: string;
  className?: string;
}) {
  useLocale();
  if (count <= 0 || onToggle === undefined) return null;
  const label = t(folded ? "home.subagents.expand" : "home.subagents.collapse", { count });
  return (
    <button
      type="button"
      aria-expanded={!folded}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-1 px-2.5 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground active:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      {folded && status !== undefined && status !== "idle" && status !== "unknown" && (
        <StatusDot
          status={status}
          surface={surface}
          label={statusLabel(status)}
          className="size-2.5"
        />
      )}
      <span aria-hidden="true">{count}</span>
      <Icon
        name="disclosure"
        aria-hidden
        className={cn("size-3.5 shrink-0 transition-transform", !folded && "rotate-90")}
      />
    </button>
  );
}
