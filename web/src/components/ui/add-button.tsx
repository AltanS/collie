import { Loader2, Plus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The face's drawn size. `sm` is 28px, for a row 30px tall or less: the pane screen's tab row and a
 * dashboard workspace heading. `md` is 32px, for the 34px pill strips: the space strip.
 */
export type AddButtonSize = "sm" | "md";

const FACE = {
  sm: "size-7",
  md: "size-8",
} as const satisfies Record<AddButtonSize, string>;

interface AddButtonProps {
  /** The accessible name, which says what the "+" makes and where: "New tab", "New tab in moonward". */
  label: string;
  onClick: () => void;
  /**
   * A create is in flight. The button disables itself and swaps its glyph for a spinner, so a second
   * tap is not a second create and the tap that went through has an answer on screen.
   */
  busy?: boolean;
  size: AddButtonSize;
  /**
   * The hit area, as a transparent `::before` recipe: `STRIP_TAP_TARGET_SQUARE` in a pill strip,
   * `TAB_ROW_SQUARE_TAP_TARGET` in the tab row (both `ui/labelled-strip.tsx`), the caller's own
   * elsewhere. Required, because no one reach fits every row: a reach is measured against what sits
   * around the button, and only the call site can see that. Every recipe carries `relative` and
   * `before:content-['']`.
   *
   * The face draws a 1px dashed border, and an absolutely placed `::before` resolves its insets
   * against the PADDING box, 1px inside the drawn edge. So a reach of `-9px` on the 28px face is
   * 26 + 18 = 44px across, and reaches 8px past the circle, not 9.
   */
  reach: string;
  className?: string;
}

// ONE LOOK FOR "NEW" IN A ROW (DESIGN.md §1). A dashed circle with a "+" in it, at the end of a row
// of things, says "one more of these", and it is the same idea wherever it stands: after the last
// space chip, after the last tab, after a workspace heading's counts. The two strips hand-rolled it
// with the same class string at two sizes; the heading was its third caller, so it lives here now.
//
// A true square is the one shape allowed to keep `rounded-full` (DESIGN.md §3), so both faces are
// circles. The glyph and the spinner are the same 16px in the same box, swapped in place, so the
// button never resizes between its idle and busy shapes (DESIGN.md §2). `disabled:opacity-100`
// keeps a busy button at full ink: the spinner is the state, and a faded spinner reads as broken.
//
// It owns the look, the busy swap and the name. It owns no gate: whether the "+" is drawn at all is
// the caller's capability check, and whether a tap may write is the caller's handler.
export function AddButton({ label, onClick, busy = false, size, reach, className }: AddButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      aria-busy={busy}
      className={cn(
        reach,
        FACE[size],
        "flex shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95 disabled:opacity-100",
        className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" />}
    </button>
  );
}
