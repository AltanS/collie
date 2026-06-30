import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { clearStatus, useStatus, type StatusTone } from "@/lib/status";

// A slim, self-contained status line. Rendered inside a pointer-events-none positioning wrapper (an
// overlay above the composer / at the bottom of home), it shows the latest status with a tone colour
// + icon. Non-errors fade on their own; errors persist and are tap-to-dismiss (the bar re-enables
// pointer events + shows an ✕ for that). Renders nothing when there's no status.
const TONE: Record<StatusTone, string> = {
  info: "text-muted-foreground",
  success: "text-status-done",
  warn: "text-status-working",
  error: "text-status-blocked",
};

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: AlertCircle,
} as const;

export function StatusArea({ className }: { className?: string }) {
  const status = useStatus();
  if (!status) return null;
  const Icon = ICONS[status.tone];
  const dismissable = status.tone === "error";
  return (
    <div
      key={status.id}
      role="status"
      aria-live="polite"
      onClick={dismissable ? () => clearStatus() : undefined}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded-md border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-sm backdrop-blur duration-200 animate-in fade-in",
        dismissable
          ? "pointer-events-auto cursor-pointer border-status-blocked/50"
          : "border-border/60",
        TONE[status.tone],
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{status.text}</span>
      {dismissable && <X className="size-3.5 shrink-0 opacity-70" />}
    </div>
  );
}
