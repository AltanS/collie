import { Inbox } from "lucide-react";

import { cn } from "@/lib/utils";
import { AGENT_GROUPS } from "@/lib/agent-groups";
import type { AgentView, BridgeStatus } from "@/lib/types";
import { AgentCard } from "./agent-card";

interface AgentListProps {
  agents: AgentView[];
  bridge: BridgeStatus | undefined;
  onOpen: (paneId: string) => void;
}

export function AgentList({ agents, bridge, onOpen }: AgentListProps) {
  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
        <Inbox className="size-7" />
        <span className="text-sm">
          {bridge === "connected" ? "No agents running." : "Waiting for Herdr…"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 px-3 py-4">
      {AGENT_GROUPS.map((g) => {
        const members = agents.filter((a) => g.match(a.status));
        if (members.length === 0) return null;
        return (
          <section key={g.key} className="flex flex-col gap-2">
            <h2
              className={cn(
                "px-1 text-xs font-semibold uppercase tracking-wide",
                g.accent ? "text-status-blocked" : "text-muted-foreground",
              )}
            >
              {g.label} <span className="opacity-60">({members.length})</span>
            </h2>
            <div className="flex flex-col gap-2">
              {members.map((a) => (
                <AgentCard key={a.paneId} agent={a} onClick={() => onOpen(a.paneId)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
