import type { Handle } from "remix/component";

import { statusLabel, type AgentStatus } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { Badge } from "../../ui/badge";

// Port of StatusBadge from web/src/components/status-badge.tsx: the status spelled out as an outline
// pill, a small disc then the word, tinted with the status colour. The space screen's cards end with it.
const DOT = {
  blocked: "bg-status-blocked",
  working: "bg-status-working",
  done: "bg-status-done",
  idle: "bg-status-idle",
  unknown: "bg-status-unknown",
} satisfies Record<AgentStatus, string>;

const CHIP = {
  blocked: "border-status-blocked/30 bg-status-blocked/15 text-status-blocked",
  working: "border-status-working/30 bg-status-working/15 text-status-working",
  done: "border-status-done/30 bg-status-done/15 text-status-done",
  idle: "border-status-idle/30 bg-status-idle/10 text-status-idle",
  unknown: "border-status-unknown/30 bg-status-unknown/10 text-status-unknown",
} satisfies Record<AgentStatus, string>;

export function StatusBadge(handle: Handle<{ status: AgentStatus; stale?: boolean }>) {
  return () => {
    const { status, stale = false } = handle.props;
    return (
      <Badge variant="outline" data-testid="status-pill" class={cn("gap-1.5 transition-opacity", CHIP[status], stale && "opacity-40")}>
        <span class={cn("size-1.5 rounded-full", DOT[status])} />
        {statusLabel(status)}
      </Badge>
    );
  };
}
