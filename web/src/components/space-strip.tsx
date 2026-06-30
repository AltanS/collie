import { ChevronLeft, Plus } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { SectionLabel } from "@/components/ui/section-label";
import { blockedCount } from "@/lib/spaces";
import type { AgentView, WorkspaceView } from "@/lib/types";

interface SpaceStripProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /** Selected workspace id, or null for the "All" triage view. */
  selected: string | null;
  onSelect: (workspaceId: string | null) => void;
  onNewSpace: () => void;
  /** When set (the drill-in view), lead with an explicit "‹ Back" button to the dashboard instead
   *  of the "All" chip — so the way back is obvious, not reliant on the header wordmark. */
  onBack?: () => void;
}

// A horizontal strip of spaces (Herdr workspaces) above the home list. In the drill-in (`onBack`
// set), it leads with a Back button to the dashboard, then the sibling spaces for quick switching;
// otherwise it leads with the "All" triage chip. A trailing + creates a new space. The space focused
// in the desktop TUI gets a subtle ring; a space with a blocked agent gets a dot.
export function SpaceStrip({
  workspaces,
  agents,
  selected,
  onSelect,
  onNewSpace,
  onBack,
}: SpaceStripProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-background py-1 pl-1.5 pr-3 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-95"
        >
          <ChevronLeft className="size-4" />
          Back
        </button>
      ) : (
        <>
          <SectionLabel>Spaces</SectionLabel>
          <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />
        </>
      )}
      {workspaces.map((w) => (
        <Chip
          key={w.workspaceId}
          label={w.label}
          active={selected === w.workspaceId}
          ring={w.focused}
          alert={blockedCount(w.workspaceId, agents) > 0}
          onClick={() => onSelect(w.workspaceId)}
        />
      ))}
      <button
        type="button"
        onClick={onNewSpace}
        aria-label="New space"
        className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}
