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
}

/**
 * The one floating action button: a round "+" in the primary fill, bottom-right of the content
 * column. It is the single exception to "the sheet is the app's only floating layer" (DESIGN.md §1),
 * and the exception is narrow. It is `fixed` and reserves nothing in flow, so showing, hiding or
 * busying it moves no content (§2); the caller keeps the last row scrollable clear of it.
 *
 * Portalled to <body> for the reason `ui/toast-viewport.tsx` is: a screen transition's `transform`
 * on any ancestor would turn `fixed` into "fixed to that ancestor" and silently carry the button
 * with the route. The layer is the same 640px column the toast and the sheet stop at, so on a wide
 * screen the button sits at the column's right edge, not the window's. `z-30` sits under the toast
 * (`z-40`) and the sheets (`z-50`); the caller's toast lift keeps the two from overlapping at all.
 *
 * It owns the look, the busy swap and the name. It owns no gate: whether it is drawn, and whether a
 * tap may write, is the caller's.
 *
 * A true circle is the one shape allowed `rounded-full` (DESIGN.md §3). The glyph and the spinner
 * are the same 24px in the same box, swapped in place. `disabled:opacity-100` keeps a busy button at
 * full ink: the spinner is the state, and a faded spinner reads as broken.
 */
export function Fab({ label, onClick, busy = false, bottom }: FabProps) {
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
        className="pointer-events-auto flex size-14 items-center justify-center rounded-full border border-transparent bg-primary text-primary-foreground shadow-lg transition-transform duration-150 animate-in fade-in hover:bg-primary/90 active:scale-95 disabled:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {busy ? <Loader2 className="size-6 animate-spin" aria-hidden /> : <Plus className="size-6" aria-hidden />}
      </button>
    </div>,
    document.body,
  );
}
