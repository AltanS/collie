import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { t as translate } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// Minimal modal focus handling (no deps, no full trap): on open move focus into the panel so
// keyboard / screen-reader users land inside the dialog; on close restore focus to whatever was
// focused before it opened. The panel must carry tabIndex={-1} to be a focus target.
function useDialogFocus(open: boolean, panelRef: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (!open) return;
    // SAFETY: `document.activeElement` is typed `Element | null`; the only thing read off it below
    // is the optional `focus()`, which is what makes it an HTMLElement in practice. The optional
    // call is what covers the case where it isn't one (an SVG element, say).
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open, panelRef]);
}

// A minimal bottom sheet — no Radix, no portals, no extra deps. Renders nothing when closed.
// Dismisses on backdrop tap or Escape. Animations come from tw-animate-css (already imported).
interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /**
   * A string everywhere except PaneActionsSheet, which composes the pane name with a `HostChip`
   * (the "which machine" disambiguator) on the same row — so this is `ReactNode`, not `string`.
   * Every other caller already passes a plain translated string, which is a `ReactNode` too, so
   * widening this cost them nothing. The `title ? … : undefined` id-linking below still works
   * because a non-empty node is truthy and the only falsy `ReactNode`s a caller passes here are
   * `undefined` and `""`, both "no title".
   */
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /**
   * A native-feel drag reveal, driven by `useSheetPull` (agent-chat.tsx's switcher handle is the
   * only caller today). While `!open && pull > 0` the panel mounts in a "peeking" state, following
   * the finger up from the bottom edge, no entrance animation, no focus capture (nothing has
   * actually opened yet). When `open` flips true right after a peek, the entrance skips the usual
   * slide-in and instead continues the transform from wherever the peek left off.
   */
  pull?: number;
  /**
   * The handle's own distance (px) from the viewport bottom, reported once per gesture by
   * `useSheetPull`'s `onAnchor`. The peeking panel's transform is `pullFrom + pull`, not `pull`
   * alone — without it the panel emerges from the viewport's bottom edge while the handle the
   * thumb is actually dragging sits well above it (above the composer), so the sheet appears with
   * the composer sandwiched between it and the finger. Presentation only: `shouldOpen` still
   * decides on `pull` alone, the anchor never enters that decision. Defaults to 0 (start from the
   * bottom edge), which is what every caller but the switcher handle wants.
   */
  pullFrom?: number;
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  className,
  pull = 0,
  pullFrom = 0,
}: BottomSheetProps) {
  useLocale();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef({ startY: 0, atTop: false, engaged: false, dy: 0 });
  const [dragY, setDragY] = React.useState(0);
  const titleId = React.useId();
  // A peek never opened, so it must never claim focus or block the page behind it from the a11y
  // tree's point of view either way; the dialog role below is only meaningful once `open` is true.
  const peeking = !open && pull > 0;
  // Remembers whether the LAST render was a peek, so the render where `open` flips true can tell
  // "this is a drag continuing into an open" from "this open had nothing before it" and skip the
  // slide-in entrance in the former case.
  const wasPeeking = React.useRef(false);
  useDialogFocus(open, panelRef);

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
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Drag-to-dismiss: pull the sheet down from the top to close it. The touchmove listener is
  // attached NON-PASSIVE so we can `preventDefault()` the downward pull — that's what suppresses
  // the browser's pull-to-refresh (otherwise a pull-down at the top would reload the whole app
  // instead of closing the sheet). A gesture that starts mid-scroll falls through to normal list
  // scrolling; only a pull that begins at the top engages the dismiss.
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    setDragY(0);
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
      if (off > CLOSE) onClose();
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
  }, [open, onClose]);

  // Read BEFORE updating: this render's "did the one before me peek" answer, which is what tells a
  // fresh open from a drag continuing into one. Updated for the NEXT render right after.
  const continuingFromPeek = open && wasPeeking.current;
  wasPeeking.current = peeking;

  if (!open && !peeking) return null;

  // Optional chaining is the jsdom guard here, not a `typeof` check: `matchMedia` is simply absent
  // on `window` in a test environment that hasn't polyfilled it, same as `navigator.vibrate` is
  // absent on iOS Safari in lib/haptics.ts.
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // Peeking: no dialog role, no aria-modal, no pointer events on the page underneath. Nothing has
  // opened yet, so nothing about this render should read as a modal to assistive tech or the mouse.
  const panelStyle: React.CSSProperties = peeking
    ? {
        // `pullFrom + pull`, not `pull` alone: `pullFrom` is the handle's own distance from the
        // viewport bottom (useSheetPull's `onAnchor`), so the panel's TOP edge starts there instead
        // of at the screen's bottom edge. `max(0px, …)` is the floor for a caller that passes 0 for
        // both (every BottomSheet but the switcher handle) — CSS `calc` can go negative, `max` can't.
        transform: `translateY(max(0px, calc(100% - ${pullFrom + pull}px)))`,
        transition: "none",
      }
    : continuingFromPeek
      ? {
          transform: "translateY(0)",
          transition: reducedMotion ? "none" : "transform 180ms ease-out",
        }
      : {
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: drag.current.engaged ? "none" : "transform 0.2s ease-out",
        };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      role={peeking ? undefined : "dialog"}
      aria-modal={peeking ? undefined : true}
      aria-labelledby={!peeking && title ? titleId : undefined}
      aria-hidden={peeking ? "true" : undefined}
      style={peeking ? { pointerEvents: "none" } : undefined}
    >
      {/* Backdrop: still dismisses on tap, but hidden from assistive tech — the ✕ in the header is
          the single accessible "Close", so the dialog isn't announced with a giant duplicate. Dismiss
          fires only when the pointer went DOWN on the backdrop too (see backdropArmed above).
          While peeking the backdrop just previews the coming dim: opacity tracks the pull directly,
          no animate-in class, because it isn't fading in on its own timeline, it's following the
          finger. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className={cn(
          "absolute inset-0 bg-black/50",
          !peeking && !continuingFromPeek && "duration-200 animate-in fade-in",
        )}
        style={peeking ? { opacity: Math.min(1, pull / 120) * 0.5 } : undefined}
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
        tabIndex={peeking ? undefined : -1}
        style={panelStyle}
        className={cn(
          // `rounded-t-md` (2px), not `rounded-t-2xl`: 16px was the roundest corner left in the app and it
          // sat on the most-seen surface. The sheet is a panel, and a panel has an edge.
          //
          // THE GROUND IS `--card`, NOT `--background`, and the edge is `--rule`. A sheet is a raised
          // surface over the page, which is the one thing --card is for — and on --background it was
          // the SAME value as the page it floats over. In dark that is the app's worst case: the page
          // is oklch(0.145), the scrim behind the panel only darkens it further, and the panel's only
          // separation was a --border hairline at 1.26:1. The operator's report was that the drawer
          // was hard to make out at all. --card is oklch(0.205), a real step up, so the panel reads
          // as raised rather than as a hole; --rule (2.06:1 dark) then draws the edge, because this
          // is a cut between two REGIONS and not a component's own outline (DESIGN.md §4). Light
          // gains the same separation for free: white on rgb(245) instead of rgb(245) on rgb(245).
          // `mx-auto w-full max-w-screen-sm`: the panel is content, not chrome, so it stops at the
          // same 640px column every route's body uses and ui/toast-viewport.tsx already caps its
          // floating layer at. The BACKDROP above stays `absolute inset-0` — the dim is the whole
          // screen or it is not a dim. Without this the panel spanned the whole viewport, 1366px on
          // a landscape 13-inch iPad, for rows that were drawn for a phone.
          "relative z-10 mx-auto max-h-[82dvh] w-full max-w-screen-sm overflow-y-auto overscroll-contain rounded-t-md border-t border-rule bg-card shadow-2xl",
          // The slide-in entrance plays on a fresh open only. A peek has no entrance (it's tracking
          // the finger, not animating), and a drag that continues into an open gets its own 180ms
          // transform transition above rather than restarting from the keyframe's own 100%.
          !peeking && !continuingFromPeek && "duration-200 animate-in slide-in-from-bottom",
          "pb-[calc(env(safe-area-inset-bottom)_+_1rem)]",
          className,
        )}
      >
        <div className="sticky top-0 z-10 border-b border-rule bg-card/95 backdrop-blur-md">
          {/* Grab handle — pull down (from anywhere at the top) to dismiss. */}
          <div className="flex justify-center pt-2 pb-1">
            {/* 4px tall, 36px wide — a stadium, so it takes the house 2px rather than full-round. */}
            <span className="h-1 w-9 rounded-md bg-muted-foreground/40" />
          </div>
          <div data-slot="sheet-title-row" className="flex items-center justify-between px-4 pb-3">
            <span
              id={title ? titleId : undefined}
              data-slot="sheet-title"
              // `flex min-w-0 flex-1 items-center gap-1.5`: harmless for the plain-string title
              // every caller but PaneActionsSheet passes (a lone text child in a flex box still
              // renders as one line) and is what lets THAT caller's composed node — the pane name
              // plus a `HostChip` — share the row and shrink into it instead of overflowing past
              // the close button.
              className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold"
            >
              {title}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={onClose}
              aria-label={translate("common.closeAria")}
            >
              <X className="size-4" />
            </Button>
          </div>
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
  useLocale();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useDialogFocus(open, panelRef);

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
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
          // Same ground and same edge as the bottom sheet above, for the same reason — one panel
          // surface app-wide, raised off the page rather than painted in the page's own colour.
          "relative z-10 flex h-full w-[86%] max-w-sm flex-col border-r border-rule bg-card shadow-2xl duration-200 animate-in slide-in-from-left",
          className,
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-rule bg-card/95 px-4 py-3 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.75rem)]">
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
              aria-label={translate("common.closeAria")}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-rule px-3 py-2 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]">
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
