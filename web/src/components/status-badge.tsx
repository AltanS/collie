import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { type AgentStatus, STATUS_LABEL } from "@/lib/types";

const DOT: Record<AgentStatus, string> = {
  blocked: "bg-status-blocked",
  working: "bg-status-working",
  done: "bg-status-done",
  idle: "bg-status-idle",
  unknown: "bg-status-unknown",
};

const CHIP: Record<AgentStatus, string> = {
  blocked: "border-status-blocked/30 bg-status-blocked/15 text-status-blocked",
  working: "border-status-working/30 bg-status-working/15 text-status-working",
  done: "border-status-done/30 bg-status-done/15 text-status-done",
  idle: "border-status-idle/30 bg-status-idle/10 text-status-idle",
  unknown: "border-status-unknown/30 bg-status-unknown/10 text-status-unknown",
};

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <span className={cn("relative flex size-2.5 shrink-0", className)}>
      {status === "working" && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75",
            DOT[status],
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", DOT[status])} />
    </span>
  );
}

export function StatusBadge({ status, className }: { status: AgentStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5", CHIP[status], className)}>
      <span className={cn("size-1.5 rounded-full", DOT[status])} />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
