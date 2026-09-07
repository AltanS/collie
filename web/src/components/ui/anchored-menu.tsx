import * as React from "react";

import { cn } from "@/lib/utils";
import { useDialogFocus } from "@/components/ui/sheet";

// ── A SMALL MENU THAT OPENS BESIDE ITS TRIGGER, NOT OVER IT ──────────────────────────────────────
//
// The counterpart to `ui/sheet.tsx`'s BottomSheet, and it exists because a bottom sheet answers a
// question this app also asks in a place a bottom sheet cannot serve: a control at the BOTTOM of
// the screen.
//
// ── WHY, MEASURED ────────────────────────────────────────────────────────────
// The composer's attach button sits 12px off the bottom edge. A bottom sheet slides up from that
// same edge, so it is over that button almost at once — sampled per frame on a 412x915 viewport,
// the panel covered the button 42ms after the tap, and a press highlight on it was never on screen
// unobstructed for a single frame. Anything a control draws to say "your tap landed" is therefore
// invisible whenever a bottom sheet is what the tap opens. Anchoring the menu ABOVE the trigger is
// what makes the trigger's own feedback survive, and it puts the choice under the thumb that just
// moved there rather than at the other end of a 44px-tall slide.
//
// ── NO ENTRANCE ANIMATION, AND THAT IS NOT A §7 EXCEPTION ────────────────────
// It appears in one frame. DESIGN.md §7's hard rule is about a state that RE-LAYS-OUT its
// neighbours, and this panel is absolutely positioned: it is out of flow, it overlays, and nothing
// around it moves by a pixel when it arrives. A slide-in here would only delay the answer to a tap
// the operator has already made, which is the whole fault this component was built to fix.
//
// ── IT IS NOT A `role="menu"` ────────────────────────────────────────────────
// A `menu` role obliges every child to be a `menuitem` with roving-tabindex keyboard semantics.
// Callers pass the SAME `ActionRow` a sheet takes — one row definition for both surfaces is the
// point — so this claims `dialog`, exactly as BottomSheet does, and the rows stay ordinary buttons
// a tab reaches in order.

export interface AnchoredMenuProps {
  open: boolean;
  onClose: () => void;
  /** The accessible name. There is no visible title: two rows in a box need no heading. */
  label: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Renders nothing when closed. Positioned against the nearest positioned ancestor, so the CALLER
 * owns the anchor — wrap the trigger in a `relative` box and this lands above its right edge.
 */
export function AnchoredMenu({ open, onClose, label, children, className }: AnchoredMenuProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  useDialogFocus(open, panelRef);

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
    <>
      {/* The dismiss surface, and it is DELIBERATELY not a scrim: dimming the page would take back
          the visibility this component exists to give the trigger. Press and release must both
          land here — the same rule BottomSheet's backdrop follows, and for the same reason: the
          release of the tap that OPENED this menu would otherwise land on the surface and close it
          again in the same gesture. */}
      <button
        type="button"
        aria-label={label}
        tabIndex={-1}
        className="fixed inset-0 z-40 cursor-default"
        onPointerDown={(e) => {
          e.currentTarget.dataset.armed = "1";
        }}
        onClick={(e) => {
          if (e.currentTarget.dataset.armed === "1") onClose();
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          // `bottom-full` against the caller's anchor, so it grows UPWARD and the trigger below it
          // is never covered. `min-w-44` because two one-word rows in a box the width of a
          // paperclip is a box nobody can read.
          "absolute bottom-full right-0 z-50 mb-2 min-w-44 rounded-xl border border-border bg-popover p-1 shadow-lg outline-none",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
