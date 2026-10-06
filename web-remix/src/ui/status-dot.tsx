import type { Handle } from "remix/component";

import type { AgentStatus } from "@web/lib/types";
import { cn } from "@web/lib/utils";

// Port of StatusDot from web/src/components/status-badge.tsx. The resting states (idle, unknown)
// are hollow rings filled with their surface; the states that mean something is happening are
// solid. Only the dot the operator watches a pane through breathes (`live`).
const DOT = {
  blocked: "bg-status-blocked",
  working: "bg-status-working",
  done: "bg-status-done",
  idle: "bg-status-idle",
  unknown: "bg-status-unknown",
} satisfies Record<AgentStatus, string>;

const RING = {
  blocked: "border-status-blocked",
  working: "border-status-working",
  done: "border-status-done",
  idle: "border-status-idle/60",
  unknown: "border-status-unknown/60",
} satisfies Record<AgentStatus, string>;

const RESTING: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["idle", "unknown"]);

export interface StatusDotProps {
  status: AgentStatus;
  surface?: string;
  label?: string;
  stale?: boolean;
  live?: boolean;
  class?: string;
}

export function StatusDot(handle: Handle<StatusDotProps>) {
  return () => {
    const { status, surface = "bg-background", label, stale = false, live = false } = handle.props;
    const hollow = RESTING.has(status);
    return (
      <span
        role={label === undefined ? undefined : "img"}
        aria-label={label}
        aria-hidden={label === undefined ? "true" : undefined}
        class={cn("relative flex size-2.5 shrink-0 transition-opacity", stale && "opacity-40", handle.props.class)}
      >
        <span
          class={cn(
            "relative inline-flex size-full rounded-full",
            live && status === "working" && !stale && "status-breathe",
            hollow ? cn("border-[1.5px]", surface, RING[status]) : DOT[status],
          )}
        />
      </span>
    );
  };
}
