import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

// Modal focus handling (no deps): on open move focus into the panel, KEEP it there while the dialog
// is up, and on close restore focus to whatever was focused before. The panel must carry
// tabIndex={-1} to be a focus target.
//
// The containment is not optional politeness — these panels declare `aria-modal="true"`, which tells
// assistive tech that everything behind them is inert. Without a trap that claim is a lie: tabbing
// past the last row walked straight out into the page behind (measured: Tab #28 landed on the header
// link under the "Switch pane" sheet), so a keyboard user could be driving controls a screen reader
// insists aren't there.
//
// A panel may nominate where focus should LAND by marking one descendant `data-autofocus` — the
// pane switcher points it at the row you're currently in, so the sheet opens on "you are here"
// rather than at the top. Deliberately never put it on a text input: focusing one on open pops the
// Android keyboard over the very list the sheet exists to show.
function useDialogFocus(open: boolean, panelRef: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    (panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel)?.focus();

    // Capture phase so the cycle wins over anything a child does with Tab.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !panel) return;
      // Collapsed sections are unmounted rather than hidden, so everything this matches is real —
      // no visibility filter (which would need layout boxes jsdom doesn't produce anyway).
      const items = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault(); // nothing to land on; hold focus on the panel itself
        panel.focus();
        return;
      }
      const active = document.activeElement;
      const inside = panel.contains(active);
      // The panel itself counts as a boundary, not as an item: it's tabIndex={-1}, so it is where
      // focus starts but never something Tab returns to. Going FORWARD from it the browser already
      // lands on `first`; going BACKWARD it would leave the dialog, so that direction wraps.
      const atStart = !inside || active === first || active === panel;
      const atEnd = !inside || active === last;
      if (e.shiftKey ? atStart : atEnd) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previouslyFocused?.focus?.();
    };
  }, [open, panelRef]);
}

// A minimal bottom sheet — no Radix, no portals, no extra deps. Renders nothing when closed.
// Dismisses on backdrop tap or Escape. Animations come from tw-animate-css (already imported).
interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /**
   * Rendered inside the STICKY header block, under the title row — for a control that must survive
   * scrolling the body (a filter field). Body content scrolls away; this doesn't.
   */
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function BottomSheet({
  open,
  onClose,
  title,
  headerExtra,
  children,
  className,
}: BottomSheetProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef({ startY: 0, atTop: false, engaged: false, dy: 0 });
  const [dragY, setDragY] = React.useState(0);
  const titleId = React.useId();
  useDialogFocus(open, panelRef);
  // `onClose` through a ref, and OUT of the effect deps below.
  //
  // Callers write `onClose={() => setDrawer(null)}` — a new function identity every render — and this
  // app re-renders about twice a second under the poll. With `onClose` in the deps, every one of
  // those tore down and re-attached the touch listeners AND re-ran `setDragY(0)`: measured 18
  // teardown/re-attach cycles in 9 seconds, and a drag-to-dismiss that snapped back to zero under
  // the user's finger three times during a single 3-second pull. Since `transition` is `none` while
  // dragging, each reset was an instant hard snap. Fixing it caller-side with useCallback would work
  // and would silently re-break for the next caller.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Backdrop dismiss requires press AND release on the backdrop itself (the Radix
  // outside-pointerdown rule) — NOT just whatever the browser happens to synthesize a `click` on. A
  // long-press that opens this sheet has its finger still down at the moment the sheet mounts; the
  // browser's release click then lands on whatever is now under the finger, which is the backdrop —
  // and without this guard that click would immediately close the sheet it just opened. Arming only
  // on a backdrop `pointerdown` means a click that originated elsewhere (e.g. the pill's release)
  // never dismisses.
  const backdropArmed = React.useRef(false);
  React.useEffect(() => {
    if (open) {
      backdropArmed.current = false;
      setDragY(0);
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Drag-to-dismiss: pull the sheet down from the top to close it. The touchmove listener is
  // attached NON-PASSIVE so we can `preventDefault()` the downward pull — that's what suppresses
  // the browser's pull-to-refresh (otherwise a pull-down at the top would reload the whole app
  // instead of closing the sheet). A gesture that starts mid-scroll falls through to normal list
  // scrolling; only a pull that begins at the top engages the dismiss.
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const SLOP = 6; // ignore taps / tiny jitter before engaging the drag
    const CLOSE = 90; // px past which release closes instead of snapping back

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      drag.current = { startY: t.clientY, atTop: panel.scrollTop <= 0, engaged: false, dy: 0 };
    };
    const onMove = (e: TouchEvent) => {
      const d = drag.current;
      if (!d.atTop) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - d.startY;
      if (!d.engaged && dy > SLOP) d.engaged = true;
      if (d.engaged) {
        e.preventDefault();
        const off = Math.max(0, dy);
        d.dy = off;
        setDragY(off);
      }
    };
    const onEnd = () => {
      const off = drag.current.dy;
      drag.current = { startY: 0, atTop: false, engaged: false, dy: 0 };
      if (off > CLOSE) onCloseRef.current();
      else setDragY(0);
    };

    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd);
    panel.addEventListener("touchcancel", onEnd);
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
    };
    // Deliberately NOT [open, onClose] — see onCloseRef above.
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      {/* Backdrop: still dismisses on tap, but hidden from assistive tech — the ✕ in the header is
          the single accessible "Close", so the dialog isn't announced with a giant duplicate. Dismiss
          fires only when the pointer went DOWN on the backdrop too — see backdropArmed above. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 bg-black/50 duration-200 animate-in fade-in"
        onPointerDown={() => {
          backdropArmed.current = true;
        }}
        onClick={() => {
          if (!backdropArmed.current) return;
          backdropArmed.current = false;
          onClose();
        }}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: drag.current.engaged ? "none" : "transform 0.2s ease-out",
        }}
        className={cn(
          "relative z-10 max-h-[82dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-border bg-background shadow-2xl duration-200 animate-in slide-in-from-bottom",
          "pb-[calc(env(safe-area-inset-bottom)_+_1rem)]",
          className,
        )}
      >
        {/* Opaque, not `bg-background/95 backdrop-blur-md`: over a dense list the translucency left a
            legible ghost of the scrolled-past section header sitting behind the title. */}
        <div className="sticky top-0 z-10 border-b border-border/60 bg-background">
          {/* Grab handle — pull down (from anywhere at the top) to dismiss. Dropped on a short
              viewport, where the header's fixed height is the scarce resource: at 844x390 it took 40%
              of the panel, and with the Android keyboard up (index.html sets
              `interactive-widget=resizes-content`, so the keyboard shrinks dvh) it took 68% and left
              ZERO whole rows visible — typing into a filter whose results you cannot see. */}
          <div className="flex justify-center pt-2 pb-1 [@media(max-height:500px)]:hidden">
            <span className="h-1 w-9 rounded-full bg-muted-foreground/40" />
          </div>
          <div className="flex items-center justify-between px-4 pb-3 [@media(max-height:500px)]:py-1 [@media(max-height:500px)]:pb-1">
            {/* A real <h2>: the sections inside these sheets are h3s "because the sheet's own title
                is the h2" — which was false while this was a <span>, leaving a heading outline with
                no root and a level skipped for anyone navigating by headings. */}
            <h2 id={title ? titleId : undefined} className="text-sm font-semibold">
              {title}
            </h2>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </div>
          {headerExtra && (
            <div className="px-4 pb-3 [@media(max-height:500px)]:pb-2">{headerExtra}</div>
          )}
        </div>
        <div className="px-4 py-3">{children}</div>
      </div>
    </div>
  );
}

// A left-edge drawer — same no-deps approach as BottomSheet, but slides in from the side and fills
// the viewport height with a scrollable body. Used for the thread sidebar (TUI-style switcher).
interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Optional action(s) rendered in the header, to the left of the close (✕) button. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function SideSheet({
  open,
  onClose,
  title,
  headerAction,
  children,
  footer,
  className,
}: SideSheetProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useDialogFocus(open, panelRef);
  // Same reason as BottomSheet: callers pass a fresh `onClose` identity every render, and this app
  // re-renders twice a second under the poll. Keeping it out of the effect deps stops the Escape
  // listener being torn down and re-attached on every one of them.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Backdrop dismiss requires press AND release on the backdrop itself (the Radix
  // outside-pointerdown rule) — NOT just whatever the browser happens to synthesize a `click` on. A
  // long-press that opens this sheet has its finger still down at the moment the sheet mounts; the
  // browser's release click then lands on whatever is now under the finger, which is the backdrop —
  // and without this guard that click would immediately close the sheet it just opened. Arming only
  // on a backdrop `pointerdown` means a click that originated elsewhere (e.g. the pill's release)
  // never dismisses.
  const backdropArmed = React.useRef(false);
  React.useEffect(() => {
    if (open) backdropArmed.current = false;
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          "relative z-10 flex h-full w-[86%] max-w-sm flex-col border-r border-border bg-background shadow-2xl duration-200 animate-in slide-in-from-left",
          className,
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-background/95 px-4 py-3 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.75rem)]">
          <span id={title ? titleId : undefined} className="text-sm font-semibold">
            {title}
          </span>
          <div className="flex items-center gap-1">
            {headerAction}
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-border/60 px-3 py-2 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]">
            {footer}
          </div>
        )}
      </div>
      {/* Backdrop: dismisses on tap but hidden from assistive tech — the header ✕ is the accessible
          "Close", so the drawer isn't announced with a giant duplicate close target. Dismiss fires
          only when the pointer went DOWN on the backdrop too — see backdropArmed above. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="flex-1 bg-black/50 duration-200 animate-in fade-in"
        onPointerDown={() => {
          backdropArmed.current = true;
        }}
        onClick={() => {
          if (!backdropArmed.current) return;
          backdropArmed.current = false;
          onClose();
        }}
      />
    </div>
  );
}
