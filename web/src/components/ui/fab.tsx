import { Icon } from "@/components/icons/icon";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { PRESS_REACH, SHEET_ACTION_TAP_TARGET } from "@/components/ui/tap-target";

interface FabProps {
  /** ALREADY TRANSLATED. The accessible name: "New". */
  label: string;
  onClick: () => void;
  /** A create is in flight. The glyph swaps for a spinner in place and the button disables. */
  busy?: boolean;
  /**
   * Where the button's bottom edge sits, as a Tailwind `bottom-*` class: the caller knows what is
   * under it (the dashboard's footer), the primitive does not.
   */
  bottom: string;
  /**
   * Draw the round "+" alone. Absent or false draws "+ New", the word beside the glyph, in the house
   * 2px corner. The caller sets it once the list under the button has scrolled, and clears it at the
   * top: the word teaches the button once, then the circle gets out of the way.
   */
  collapsed?: boolean;
}

/**
 * The one floating action button, bottom-right of the content column. It is the single exception to
 * "the sheet is the app's only floating layer" (DESIGN.md §1), and the exception is narrow. It is
 * `fixed` and reserves nothing in flow, so showing, hiding, busying or shrinking it moves no content
 * (§2); the caller keeps the last row scrollable clear of it.
 *
 * TWO SHAPES, ONE BUTTON (M48, card 3.2). At rest it reads "+ New": wider than tall, so it takes the
 * house 2px corner (§3), never a stadium. `collapsed` shrinks it to the 48px round "+", the one shape
 * allowed a full radius, because width equals height. Width and corner move together over 200ms,
 * and not at all under reduced motion. The word is the button's name in both shapes (`aria-label`),
 * so a screen reader hears "New" whichever is drawn.
 *
 * Portalled to <body> for the reason `ui/toast-viewport.tsx` is: a screen transition's `transform`
 * on any ancestor would turn `fixed` into "fixed to that ancestor" and silently carry the button
 * with the route. The layer is the same 640px column the toast and the sheet stop at. `z-30` sits
 * under the toast (`z-40`) and the sheets (`z-50`); the caller's toast lift keeps the two apart.
 *
 * QUIET, NOT LOUD (owner, 2026-10-09: "screaming a bit too much"). It wears the outline button's
 * clothes, not the primary fill: `bg-background`, a uniform 1px `--border` edge, foreground ink, and
 * the `shadow-md` the app's other floating things carry (the strip band, the chat jump button). Hover
 * and press take `--accent`. 48px tall, over the 44px tap floor (§4).
 *
 * It owns the look, the busy swap and the name. It owns no gate: whether it is drawn, and whether a
 * tap may write, is the caller's. `disabled:opacity-100` keeps a busy button at full ink: the spinner
 * is the state, and a faded spinner reads as broken.
 */
export function Fab({ label, onClick, busy = false, bottom, collapsed = false }: FabProps) {
  return createPortal(
    <div
      data-slot="fab-layer"
      className={cn(
        "pointer-events-none fixed inset-x-0 z-30 mx-auto flex w-full max-w-screen-sm justify-end px-4",
        bottom,
      )}
    >
      <FabButton label={label} onClick={onClick} busy={busy} collapsed={collapsed} />
    </div>,
    document.body,
  );
}

interface FabButtonProps {
  /** ALREADY TRANSLATED. The accessible name: "New". */
  label: string;
  onClick: () => void;
  busy?: boolean;
  /** `float` is the dashboard's 48px button; `compact` is the 32px one in a sheet's title row. */
  size?: "float" | "compact";
  /** The round "+" alone. Only the `float` size folds; a compact button always shows its word. */
  collapsed?: boolean;
}

/**
 * THE NEW BUTTON'S FACE, without a place to stand. The one look of "+ New" (the outline-button clothes,
 * the `add` glyph, the word, the busy spinner swap, the name) so the dashboard's floating button and the
 * Switch pane sheet's title-row button are the same button and never two class lists that drift. It
 * positions nothing: {@link Fab} carries it in the fixed layer, `BottomSheet`'s `action` slot carries it
 * in the title row.
 *
 * `compact` is the title-row size. The same border, fill, ink, hover and press tokens and the same
 * 2px corner, but 32px tall like the close button beside it (the row does not grow, and
 * `SHEET_BODY_STICKY` still holds), with no shadow and no entrance: a sheet is already a raised surface
 * and has its own slide-in. The 44px floor is bought back as hit area, the way the header pills buy it
 * (`SHEET_ACTION_TAP_TARGET`, `ui/tap-target.ts`).
 */
export function FabButton({ label, onClick, busy = false, size = "float", collapsed = false }: FabButtonProps) {
  const compact = size === "compact";
  const folded = collapsed && !compact;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      aria-busy={busy}
      data-slot={compact ? "fab-compact" : "fab"}
      data-collapsed={folded || undefined}
      className={cn(
        "flex items-center justify-center border border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground active:scale-95 active:bg-accent disabled:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        // Dark: the page and a flat row are the same near-black, and --border is a 12% white hairline
        // there (1.26:1). The card step (0.205 against 0.145) lifts the fill so the button still
        // reads as a button over the list; hover and press go back to --accent.
        "dark:bg-card dark:hover:bg-accent dark:active:bg-accent",
        compact
          ? cn("h-8 rounded-md px-2.5", SHEET_ACTION_TAP_TARGET, "transition-transform")
          : cn(
              "pointer-events-auto h-12 shadow-md animate-in fade-in",
              PRESS_REACH,
              "transition-[width,border-radius,transform] duration-200 ease-out motion-reduce:transition-none",
              // 24px on a 48px square is the circle; 2px is the house corner on the wider pill.
              folded ? "w-12 rounded-[24px]" : "w-24 rounded-md",
            ),
      )}
    >
      {/* The clip for the label's fold lives here and not on the button: a clip on the button would cut
          the press reach (ui/tap-target.ts, PRESS_REACH) off at the border. Same box, same corners. */}
      <span className={cn("flex items-center justify-center overflow-hidden rounded-[inherit]", compact ? "" : "size-full")}>
        {busy ? (
          <Icon name="busy" className={cn("shrink-0 animate-spin", compact ? "size-4" : "size-5")} aria-hidden />
        ) : (
          <Icon name="add" className={cn("shrink-0", compact ? "size-4" : "size-5")} aria-hidden />
        )}
        {/* The word fades and folds with the width. aria-hidden: the label above already names it. */}
        <span
          aria-hidden
          className={cn(
            "overflow-hidden whitespace-nowrap text-sm font-medium transition-[max-width,opacity,margin] duration-200 ease-out motion-reduce:transition-none",
            // The compact size never folds, so its word carries no cap: a longer word (a locale's) shows whole.
            folded ? "ml-0 max-w-0 opacity-0" : cn("ml-1.5 opacity-100", !compact && "max-w-16"),
          )}
        >
          {label}
        </span>
      </span>
    </button>
  );
}
