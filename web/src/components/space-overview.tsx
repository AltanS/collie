import { ChevronRight, FolderPlus, Layers, LayoutGrid } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { StatusDot } from "@/components/status-badge";
import { blockedCount, worstSpaceStatus } from "@/lib/spaces";
import type { AgentView, WorkspaceView } from "@/lib/types";

interface SpaceOverviewProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  onOpen: (workspaceId: string) => void;
  onNewSpace: () => void;
}

// The dashboard's top section: every space as a card with a status dot (its most-urgent agent), a
// blocked tint, and compact tab/pane counts. Tapping a space drills into its tab/pane view.
export function SpaceOverview({ workspaces, agents, onOpen, onNewSpace }: SpaceOverviewProps) {
  return (
    <section className="flex flex-col gap-2 px-3 py-4">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Spaces <span className="opacity-60">({workspaces.length})</span>
        </h2>
        <button
          type="button"
          onClick={onNewSpace}
          aria-label="New space"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted active:scale-95"
        >
          <FolderPlus className="size-4" />
        </button>
      </div>

      {workspaces.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">No spaces yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {workspaces.map((w) => {
            const status = worstSpaceStatus(w.workspaceId, agents);
            const blocked = blockedCount(w.workspaceId, agents) > 0;
            return (
              <button
                key={w.workspaceId}
                type="button"
                onClick={() => onOpen(w.workspaceId)}
                className="w-full text-left transition-transform active:scale-[0.99]"
              >
                <Card
                  className={cn(
                    "flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm",
                    blocked && "border-status-blocked/40 bg-status-blocked/5",
                  )}
                >
                  {status ? (
                    <StatusDot status={status} />
                  ) : (
                    <span className="size-2.5 shrink-0 rounded-full border border-muted-foreground/40" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium">{w.label}</span>
                  <Count icon={Layers} n={w.tabCount} unit="tab" />
                  <Count icon={LayoutGrid} n={w.paneCount} unit="pane" />
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Card>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

// A compact count pill — icon + number, with a spelled-out aria-label (e.g. "3 panes") for a11y.
function Count({ icon: Icon, n, unit }: { icon: LucideIcon; n: number; unit: string }) {
  return (
    <span
      aria-label={`${n} ${unit}${n === 1 ? "" : "s"}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground"
    >
      <Icon className="size-3.5" aria-hidden />
      {n}
    </span>
  );
}
