import { ChevronRight, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { ShellBadge, StatusBadge } from "@/components/status-badge";
import { AgentIcon } from "@/components/agent-icon";
import { shortCwd } from "@/lib/format";
import type { AgentView } from "@/lib/types";

// A pane row, used by the triage home and the space view. Usually an agent; for a bare shell pane
// (kind:"shell") it shows a terminal glyph and a muted "shell" tag instead of a status badge.
export function AgentCard({ agent, onClick }: { agent: AgentView; onClick: () => void }) {
  const isShell = agent.kind === "shell";
  const blocked = agent.status === "blocked";
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
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{isShell ? "shell" : agent.agent}</span>
            <span className="truncate text-xs text-muted-foreground">· {agent.workspaceLabel}</span>
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {shortCwd(agent.cwd)}
          </div>
        </div>
        {isShell ? <ShellBadge /> : <StatusBadge status={agent.status} />}
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Card>
    </button>
  );
}
