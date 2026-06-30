import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusDot } from "@/components/status-badge";
import type { AgentView } from "@/lib/types";

interface PaneStripProps {
  /** The panes that share the current tab (agents + shells), in stable order. */
  panes: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
}

// The panes within the current tab, as a horizontal switcher one level below the tab bar
// (space › tab › pane). Mobile deliberately doesn't replicate the desktop's pane tiling — a tab can
// hold several panes, and this is just a quick way to flip between them. Rendered only when the tab
// actually holds more than one pane (a lone pane needs no switcher), so it's an optional extra row.
export function PaneStrip({ panes, currentPaneId, onSelect }: PaneStripProps) {
  if (panes.length < 2) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-t border-border/40 bg-muted/20 px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <SectionLabel>Panes</SectionLabel>
      {panes.map((p) => {
        const active = p.paneId === currentPaneId;
        const isShell = p.kind === "shell";
        // The "pN" suffix of the pane id disambiguates same-named panes (two claudes in one tab).
        const tag = p.paneId.split(":").pop();
        return (
          <button
            key={p.paneId}
            type="button"
            onClick={() => onSelect(p.paneId)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium transition-colors active:scale-95",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {isShell ? (
              <TerminalSquare className="size-3.5 shrink-0" />
            ) : (
              <StatusDot status={p.status} />
            )}
            <span>{isShell ? "shell" : p.agent}</span>
            <span
              className={cn(
                "font-mono text-[10px]",
                active ? "text-primary-foreground/70" : "text-muted-foreground/60",
              )}
            >
              {tag}
            </span>
          </button>
        );
      })}
    </div>
  );
}
