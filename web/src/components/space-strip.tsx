import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { blockedCount } from "@/lib/spaces";
import type { AgentView, WorkspaceView } from "@/lib/types";

interface SpaceStripProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /** Selected workspace id, or null for the "All" triage view. */
  selected: string | null;
  onSelect: (workspaceId: string | null) => void;
  onNewSpace: () => void;
}

// A horizontal strip of spaces (Herdr workspaces) above the home list. "All" shows the agent
// triage; tapping a space switches to its tab/pane view. A trailing + creates a new space. The
// space focused in the desktop TUI gets a subtle ring; a space with a blocked agent gets a dot.
export function SpaceStrip({ workspaces, agents, selected, onSelect, onNewSpace }: SpaceStripProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Chip label="All" active={selected === null} onClick={() => onSelect(null)} />
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

function Chip({
  label,
  active,
  ring,
  alert,
  onClick,
}: {
  label: string;
  active: boolean;
  ring?: boolean;
  alert?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors active:scale-95",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
        ring && !active && "ring-1 ring-inset ring-primary/40",
      )}
    >
      {label}
      {alert && (
        <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-status-blocked ring-2 ring-background" />
      )}
    </button>
  );
}
