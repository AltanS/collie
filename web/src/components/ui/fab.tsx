import { Loader2, Plus } from "lucide-react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

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
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label={label}
        aria-busy={busy}
        data-slot="fab"
        data-collapsed={collapsed || undefined}
        className={cn(
          "pointer-events-auto flex h-12 items-center justify-center overflow-hidden border border-border bg-background text-foreground shadow-md animate-in fade-in hover:bg-accent hover:text-accent-foreground active:scale-95 active:bg-accent disabled:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          // Dark: the page and a flat row are the same near-black, and --border is a 12% white hairline
          // there (1.26:1). The card step (0.205 against 0.145) lifts the fill so the button still
          // reads as a button over the list; hover and press go back to --accent.
          "dark:bg-card dark:hover:bg-accent dark:active:bg-accent",
          "transition-[width,border-radius,transform] duration-200 ease-out motion-reduce:transition-none",
          // 24px on a 48px square is the circle; 2px is the house corner on the wider pill.
          collapsed ? "w-12 rounded-[24px]" : "w-24 rounded-md",
        )}
      >
        {busy ? <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden /> : <Plus className="size-5 shrink-0" aria-hidden />}
        {/* The word fades and folds with the width. aria-hidden: the label above already names it. */}
        <span
          aria-hidden
          className={cn(
            "overflow-hidden whitespace-nowrap text-sm font-medium transition-[max-width,opacity,margin] duration-200 ease-out motion-reduce:transition-none",
            collapsed ? "ml-0 max-w-0 opacity-0" : "ml-1.5 max-w-16 opacity-100",
          )}
        >
          {label}
        </span>
      </button>
    </div>,
    document.body,
  );
}
