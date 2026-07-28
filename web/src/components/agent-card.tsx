import { ChevronRight, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ShellBadge, StatusBadge } from "@/components/status-badge";
import { AgentIcon } from "@/components/agent-icon";
import { timeAgo } from "@/lib/format";
import { paneTitle, paneTitleInTab } from "@/lib/pane-name";
import type { AgentView } from "@/lib/types";

interface AgentCardProps {
  agent: AgentView;
  onClick: () => void;
  /**
   * Show "how long ago" beside the badge, and which timestamp it means: "seen" for the Recent
   * section (when you last opened it), "active" for Ready · unseen (when it finished). Omitted
   * elsewhere — a blocked agent's age is noise next to the fact that it's blocked.
   */
  age?: "seen" | "active";
  /**
   * Where the row is being shown. "herd" (default) is a flat list across every space, so the title
   * carries `project · tab`. "tab" is a list already grouped under its space and tab — repeating
   * them would say nothing, so the pane's own name leads instead.
   */
  scope?: "herd" | "tab";
}

// A pane row, used by the triage home and the space view. Usually an agent; for a bare shell pane
// (kind:"shell") it shows a terminal glyph and a muted "shell" tag instead of a status badge.
//
// The title is `project · tab` (see paneTitle) — NOT the agent name, which every row would otherwise
// share. The agent's identity lives in the avatar; the pane's own name, when it has one, sits on the
// second line where the cwd used to be.
export function AgentCard({ agent, onClick, age, scope = "herd" }: AgentCardProps) {
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
  const { primary, secondary } = scope === "tab" ? paneTitleInTab(agent) : paneTitle(agent);
  const stamp = age === "seen" ? agent.lastSeenAt : age === "active" ? agent.lastActiveAt : undefined;

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left transition-transform active:scale-[0.99]"
    >
      <Card
        className={cn(
          "flex-row items-center gap-3 rounded-xl px-3.5 py-3 shadow-sm",
          blocked && "border-status-blocked/40 bg-status-blocked/5",
        )}
      >
        {isShell ? (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full border bg-muted">
            <TerminalSquare className="size-4 text-muted-foreground" />
          </div>
        ) : (
          <AgentIcon agent={agent.agent} className="size-9" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{primary}</div>
          {secondary && (
            <div className="truncate font-mono text-xs text-muted-foreground">{secondary}</div>
          )}
        </div>
        {stamp !== undefined && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {timeAgo(stamp)}
          </span>
        )}
        {isShell ? <ShellBadge /> : <StatusBadge status={agent.status} />}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Card>
    </button>
  );
}
