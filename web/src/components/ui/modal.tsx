import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useVisibleHeight } from "@/hooks/use-visible-height";
import { cn } from "@/lib/utils";

// THE MODAL (ADR 0167). A panel over a dimmed scrim for a DECISION that blocks until it is answered, and
// for the Actions palette. A `BottomSheet` holds a task; this holds a choice. It owns the shell only: the
// scrim, the panel's look (the house radius, a uniform border on all four sides, a soft shadow; never an
// accent edge, DESIGN.md), the dialog semantics, Escape, the scrim tap, the focus in and back, the portal
// to `<body>` and the room above the on-screen keyboard. It owns no words and no content.
//
// THE ROOM. `--app-h` follows the keyboard where the browser resizes the page for it (Android, with the
// app's `interactive-widget=resizes-content`); the visible height covers a keyboard that only overlays
// the page (iOS). The panel's room is the smaller of the two, published as `--modal-room`.
//
// PLACEMENT. `top`: the panel hangs from the top of the screen, as tall as its content and at most the
// room (the palette: the keyboard owns the bottom half and the field keeps it up). `center`: the panel
// stands in the middle of the room, so with a keyboard that overlays the page it is centred in the part
// above the keyboard. A `center` modal takes the focus to its panel, so a field that held it lets go and
// a soft keyboard goes down; the panel is centred in the full height once it has.

interface ModalProps {
  placement: "top" | "center";
  onClose: () => void;
  /** The dialog's name, read from an element in it (its title), or given as words. One of the two. */
  labelledBy?: string;
  label?: string;
  /** The element the focus goes to on open, inside the tap that opened it (the palette's field). Absent: the panel. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** The panel's own size and inner layout: its width, its max height, its padding. */
  className?: string;
  /** `data-slot` of the panel and of the scrim, for tests and e2e. */
  slot?: string;
  scrimSlot?: string;
  children: ReactNode;
}

const PLACEMENT = {
  top: { frame: "pt-[calc(0.75rem+env(safe-area-inset-top))]", enter: "slide-in-from-top-2" },
  center: { frame: "justify-center pt-[calc(0.75rem+env(safe-area-inset-top))]", enter: "zoom-in-95" },
} as const;

// THE SHELL'S LOOK, shared with a `BottomSheet` drawn as a centred dialog on a wide window (ui/sheet.tsx,
// ADR 0167's addendum). One place for the classes, so the two panels cannot drift apart.

/** The fixed layer that holds the scrim and the panel, before the placement's own classes. */
export const MODAL_FRAME = "fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col items-center px-3";
/** The `center` placement's frame classes. */
export const MODAL_CENTER_FRAME = PLACEMENT.center.frame;
/** The panel's look: `--card`, the house radius, a uniform border on all four sides, the soft shadow. */
export const MODAL_PANEL_LOOK = "rounded-md border border-border bg-card shadow-2xl";
/** The `center` entrance: a short fade and a small zoom in. */
export const MODAL_CENTER_ENTRANCE = `duration-150 animate-in fade-in ${PLACEMENT.center.enter}`;
/** The dimmed scrim's classes. */
export const MODAL_SCRIM = "absolute inset-0 bg-black/50 duration-150 animate-in fade-in";

/**
 * The frame's style: the room above the soft keyboard as `--modal-room`, and for `center` the bottom
 * padding that keeps the panel centred in that room, not in the page.
 */
export function useModalRoom(placement: "top" | "center"): CSSProperties {
  const visible = useVisibleHeight();
  const room: CSSProperties & Record<"--modal-room", string> = { "--modal-room": `${visible}px` };
  // Centred in the room, not in the page: the part of the page under an overlaying keyboard is padded off.
  return placement === "center"
    ? { ...room, paddingBottom: `calc(0.75rem + env(safe-area-inset-bottom) + max(0px, var(--app-h) - var(--modal-room)))` }
    : room;
}

export function Modal({ placement, onClose, labelledBy, label, initialFocus, className, slot, scrimSlot, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Focus on open, in the layout phase, so a field that takes it can raise the soft keyboard inside the
  // opening tap; give the focus back on close. Both without a scroll: a modal that opens must not move
  // the page under its scrim (ui/sheet.tsx, `useDialogFocus`).
  useLayoutEffect(() => {
    // SAFETY: `activeElement` is `Element | null`; only its optional `focus` is called on the way out.
    const before = document.activeElement as HTMLElement | null;
    (initialFocus?.current ?? panelRef.current)?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
    // The focus moves once per open; a caller's new ref object on a later render must not move it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes. Read through a ref, so a caller's fresh `onClose` on each render does not re-bind it.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const frameStyle = useModalRoom(placement);
  const { frame, enter } = PLACEMENT[placement];

  return createPortal(
    <div className={cn(MODAL_FRAME, frame)} style={frameStyle}>
      {/* The scrim: a tap that went down AND up on it closes, so the release of the tap that opened
          the modal never closes it again (ui/sheet.tsx, the backdrop's rule). */}
      <Scrim onClose={onClose} slot={scrimSlot} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy === undefined ? label : undefined}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        data-slot={slot}
        data-placement={placement}
        className={cn(
          "relative z-10 flex flex-col overflow-hidden outline-none duration-150 animate-in fade-in",
          MODAL_PANEL_LOOK,
          enter,
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function Scrim({ onClose, slot }: { onClose: () => void; slot: string | undefined }) {
  const armed = useRef(false);
  return (
    <button
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      data-slot={slot}
      className={MODAL_SCRIM}
      onPointerDown={() => {
        armed.current = true;
      }}
      onClick={() => {
        if (!armed.current) return;
        armed.current = false;
        onClose();
      }}
    />
  );
}
