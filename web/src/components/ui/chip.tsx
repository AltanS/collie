import { cn } from "@/lib/utils";

interface ChipProps {
  label: string;
  active: boolean;
  /** Subtle ring marking the item focused in the desktop TUI. */
  ring?: boolean;
  /** Alert dot for a blocked agent within this space/tab. */
  alert?: boolean;
  onClick: () => void;
}

// Pill button shared by the space and tab strips: active fill, an optional desktop-focus ring, and
// an optional alert dot for a contained blocked agent.
export function Chip({ label, active, ring, alert, onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors active:scale-95",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70",
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
