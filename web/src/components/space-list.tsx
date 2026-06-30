import { FolderPlus } from "lucide-react";

import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/status-badge";
import { blockedCount, worstSpaceStatus } from "@/lib/spaces";
import type { AgentView, WorkspaceView } from "@/lib/types";

interface SpaceListProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /** The workspace of the pane you're currently viewing, marked as "here". */
  currentWorkspaceId?: string;
  onSelect: (workspaceId: string) => void;
  onNewSpace: () => void;
}

// The SPACES half of the nav hub (top), mirroring the Herdr TUI's spaces list: every workspace —
// including ones with no agent yet (a fresh shell) — with a status dot reflecting its most-urgent
// agent. A "+" in the header creates a new space. Tapping a space opens it (home, space view).
export function SpaceList({
  workspaces,
  agents,
  currentWorkspaceId,
  onSelect,
  onNewSpace,
}: SpaceListProps) {
  return (
    <section className="flex flex-col gap-0.5 px-2 pt-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Spaces <span className="opacity-60">({workspaces.length})</span>
        </h3>
        <button
          type="button"
          onClick={onNewSpace}
          aria-label="New space"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted active:scale-95"
        >
          <FolderPlus className="size-4" />
        </button>
      </div>

      {workspaces.map((w) => {
        const status = worstSpaceStatus(w.workspaceId, agents);
        const here = w.workspaceId === currentWorkspaceId;
        return (
          <button
            key={w.workspaceId}
            type="button"
            onClick={() => onSelect(w.workspaceId)}
            aria-current={here ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
              here ? "bg-accent/60" : "hover:bg-muted/60 active:bg-muted",
            )}
          >
            {status ? (
              <StatusDot status={status} />
            ) : (
              <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">{w.label}</span>
                {here && <span className="shrink-0 text-[11px] text-muted-foreground">· here</span>}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {w.tabCount} {w.tabCount === 1 ? "tab" : "tabs"} · {w.paneCount}{" "}
                {w.paneCount === 1 ? "pane" : "panes"}
              </div>
            </div>
            {blockedCount(w.workspaceId, agents) > 0 && (
              <span className="size-2 shrink-0 rounded-full bg-status-blocked" />
            )}
          </button>
        );
      })}
    </section>
  );
}
