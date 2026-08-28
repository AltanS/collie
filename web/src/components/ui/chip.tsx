import { cn } from "@/lib/utils";
import { STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { useLongPress } from "@/hooks/use-long-press";
import { StatusDot } from "@/components/status-badge";
import { TRIAGE_STATUS, type TriageKey } from "@/lib/triage";
import { statusLabel } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";

interface ChipProps {
  label: string;
  active: boolean;
  /** Subtle ring marking the item focused in the desktop TUI. */
  ring?: boolean;
  /**
   * The most urgent thing happening inside this space/tab ({@link worstTriage}) — drawn as a leading
   * dot in the same palette the herd list uses, so a chip and a row can't mean different things by
   * the same colour. Omit (or pass null) when the container holds no agent at all: that's not the
   * same as idle, and a resting dot would claim otherwise.
   */
  status?: TriageKey | null;
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
// a leading status dot saying what's going on inside. Tab chips additionally wire a long-press to
// open their rename sheet (space chips leave it unset — the handlers stay inert).
//
// The dot leads the label rather than riding the corner as a badge: a corner badge needs a ring in
// the chip's own fill, and the chip has two fills (active/inactive). Inline, it just works, and it
// matches how the space rows and section headings already read.
export function Chip({ label, active, ring, status, onClick, onLongPress, onTapActive }: ChipProps) {
  useLocale();
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
        // `rounded-md` (2px), not `rounded-full`: the chip is wider than it is tall, so full-round
        // would make it a stadium, and the mark holds no stadium. Full-round is reserved for shapes
        // whose width equals their height — the leading status dot below is one, the chip is not.
        //
        // The border is in the base string and transparent at rest, so every state — resting, active,
        // TUI-focused — occupies exactly the same box and only the paint changes. The desktop-focus
        // mark used to be `ring-1 ring-inset`, which also did not reflow; a border is the house
        // technique for state and keeps the ring slots free.
        //
        // The 44px tap floor is bought as HIT area, not as height: see STRIP_TAP_TARGET. Three of
        // these rows stack above the fold on a phone, so ten real pixels each is thirty pixels of
        // list the operator no longer sees — and a target does not have to be visible to be hit.
        // STRIP_TAP_TARGET carries the `relative` this needs anyway, plus the transparent ::before
        // that takes the drawn 34px box to a 46px TOUCH box. min-w-11 is the same floor in the other
        // axis: every chip but "All" is already past 44px wide, and "All" measured 43.
        STRIP_TAP_TARGET,
        "flex min-w-11 shrink-0 select-none items-center justify-center gap-1.5 [-webkit-touch-callout:none] whitespace-nowrap rounded-md border border-transparent px-3 py-1.5 text-sm font-medium transition-colors active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70",
        ring && !active && "border-primary/40",
      )}
    >
      {status && (
        <>
          {/* A hollow resting dot is filled with the chip's own fill, which differs when active. */}
          <StatusDot
            status={TRIAGE_STATUS[status]}
            surface={active ? "bg-primary" : "bg-muted"}
            className="size-2"
          />
          {/* The dot is colour-only; say it in words for screen readers. */}
          <span className="sr-only">{statusLabel(TRIAGE_STATUS[status])}</span>
        </>
      )}
      {label}
    </button>
  );
}
