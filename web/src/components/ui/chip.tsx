import { cn } from "@/lib/utils";
import { useLongPress } from "@/hooks/use-long-press";

interface ChipProps {
  label: string;
  active: boolean;
  /** Subtle ring marking the item focused in the desktop TUI. */
  ring?: boolean;
  /** Alert dot for a blocked agent within this space/tab. */
  alert?: boolean;
  onClick: () => void;
  /**
   * Long-press (or right-click / Android contextmenu) opens actions for this chip — e.g. the tab
   * rename sheet. Inert when unset (the space strip's chips don't wire it), so the handlers are safe
   * to spread unconditionally.
   */
  onLongPress?: () => void;
  /**
   * A plain tap when the chip is already `active` — opens actions instead of a no-op re-select,
   * mirroring the pane pill. Only meaningful alongside {@link onLongPress}.
   */
  onTapActive?: () => void;
}

// Pill button shared by the space and tab strips: active fill, an optional desktop-focus ring, and
// an optional alert dot for a contained blocked agent. Tab chips additionally wire a long-press to
// open their rename sheet (space chips leave it unset — the handlers stay inert).
export function Chip({ label, active, ring, alert, onClick, onLongPress, onTapActive }: ChipProps) {
  const longPress = useLongPress(onLongPress);

  // A long-press already suppresses the ensuing click (via longPress.onClickCapture), so this only
  // ever sees a genuine tap. Tapping the already-active chip opens actions (when wired) rather than a
  // dead re-select.
  function handleClick() {
    if (active && onTapActive) {
      onTapActive();
      return;
    }
    onClick();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      {...longPress}
      aria-current={active ? "true" : undefined}
      className={cn(
        // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe / touch callout,
        // whose native long-press gesture otherwise fires pointercancel and kills the hold timer.
        "relative shrink-0 select-none [-webkit-touch-callout:none] whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition-colors active:scale-95",
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
