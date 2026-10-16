import { Badge } from "@/components/ui/badge";
import { paneBadge } from "@/lib/pane-marks";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE MARK NEXT TO A DURABLE PANE'S TITLE (WIRE.md 7.11): a count or a short word, in the shared label
// pill (`ui/badge.tsx`, the secondary look), set to the row's 16px so it never makes a line taller than
// the name beside it. It renders nothing without a mark, and a program's string is a text node only.

export function PaneBadge({ pane, className }: { pane: Pick<AgentView, "badge">; className?: string }) {
  const text = paneBadge(pane);
  if (text === null) return null;
  return (
    <Badge
      variant="secondary"
      data-slot="pane-badge"
      className={cn("h-4 min-w-4 max-w-28 px-1 py-0 text-[11px] leading-none tabular-nums", className)}
    >
      <span className="min-w-0 truncate">{text}</span>
    </Badge>
  );
}
