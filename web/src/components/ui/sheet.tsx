import * as React from "react";
import { Icon } from "@/components/icons/icon";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MODAL_CENTER_ENTRANCE, MODAL_CENTER_FRAME, MODAL_FRAME, MODAL_PANEL_LOOK, MODAL_SCRIM, useModalRoom } from "@/components/ui/modal";
import { t as translate } from "@/lib/i18n";
import { useFoldPosture } from "@/hooks/use-fold-posture";
import { useLocale } from "@/hooks/use-locale";
import { useWidthClass } from "@/hooks/use-width-class";
import { hasResizeObserver } from "@/lib/env";
import { isAnchorShown, placeMenu } from "@/lib/menu-place";
import { EXPANDED_MIN_PX, WIDE_MIN_HEIGHT_PX } from "@/lib/wide-layout";

// Minimal modal focus handling (no deps, no full trap): on open move focus into the panel so
// keyboard / screen-reader users land inside the dialog; on close restore focus to whatever was
// focused before it opened. The panel must carry tabIndex={-1} to be a focus target.
//
// BOTH focus calls pass `preventScroll: true`, and that is the fix for a page that jumped when a
// sheet opened (M48 spec 03, seen in the keys playground). A bare `focus()` asks the browser to
// scroll the focused element into view, and this panel is focused on the very frame it mounts, while
// its slide-in keyframe still holds it a full height below the screen. The browser then scrolls the
// nearest scroll container to reach it, and that container is the content BEHIND the sheet (any
// ancestor that clips with `overflow` and moves a `fixed` child with `transform`). A modal that
// opens must not move the page under its scrim. The restore on close has the same flaw in reverse:
// the opener may have been scrolled out of view while the sheet was open.
export function useDialogFocus(open: boolean, panelRef: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (!open) return;
    // SAFETY: `document.activeElement` is typed `Element | null`; the only thing read off it below
    // is the optional `focus()`, which is what makes it an HTMLElement in practice. The optional
    // call is what covers the case where it isn't one (an SVG element, say).
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open, panelRef]);
}

// HOW MANY BOTTOM SHEETS ARE OPEN, for the one thing that has to know: the dashboard's floating New
// button hides itself while any sheet is up (DESIGN.md §1, ui/fab.tsx). A module-level count behind
// `useSyncExternalStore`, because the button and the sheets share no ancestor that could pass the
// fact down, and a sheet may be mounted from any component. Counts `open` only: a peeking panel
// (`pull > 0`) is a finger still dragging, not an open sheet.
let openSheets = 0;
/** The open layers in the order they opened: Escape closes only the last one, never the sheet under it too. */
const layerStack: object[] = [];
const sheetListeners = new Set<() => void>();
function bumpOpenSheets(by: 1 | -1): void {
  openSheets += by;
  for (const listener of sheetListeners) listener();
}
function subscribeOpenSheets(listener: () => void): () => void {
  sheetListeners.add(listener);
  return () => {
    sheetListeners.delete(listener);
  };
}

/** True while at least one `BottomSheet` is open anywhere in the app. */
export function useAnySheetOpen(): boolean {
  return React.useSyncExternalStore(
    subscribeOpenSheets,
    () => openSheets > 0,
    () => false,
  );
}

/**
 * The bottom clearance of a TALL sheet whose last control must be reachable when scrolled to the end:
 * 24px plus the safe area, so the home indicator never sits on it. The panel's own default is 16px plus
 * the safe area, which is right for a short sheet that ends in a row of text; a tall editor ends in a
 * button, and a thumb needs air under it. Passed as the sheet's `className`, so it replaces the default
 * rather than stacking on it.
 */
export const TALL_SHEET_CLEARANCE = "pb-[calc(env(safe-area-inset-bottom)_+_1.5rem)]";

/**
 * Where a block in the sheet's body sticks: right under the sticky head, and across the panel's whole
 * width (the body's 16px gutter taken back), so its own rule meets both edges as the head's does. The
 * session switcher's filter field. The offset is the head's stated height, a sum of fixed boxes, in rem
 * so it grows with the text size: the grab handle's row (`pt-2 pb-1` around the `h-1` handle, 1rem),
 * the title row (the `size-8` close button, taller than the `text-sm` title, plus `pb-3`, 2.75rem) and
 * the head's 1px `border-b`. Change one of those and this sum with it; `sheet.test.tsx` reads both.
 */
export const SHEET_BODY_STICKY = "top-[calc(3.75rem+1px)] -mx-4 px-4";

/**
 * The tallest a sheet drawn as a dialog stands: about 82% of the window, as the bottom sheet, and never
 * past the room above an on-screen keyboard (`--modal-room`, ui/modal.tsx) less the frame's padding.
 */
const DIALOG_MAX_H = "min(82dvh, calc(var(--modal-room) - 1.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)))";
/**
 * The height left for the body's content in a dialog: the panel's cap less the head (3.75rem and its 1px
 * rule, the same sum as {@link SHEET_BODY_STICKY}), the body's `py-3` and the panel's `pb-1`.
 */
const DIALOG_BODY_ROOM = `calc(${DIALOG_MAX_H} - 5.5rem - 1px)`;

/**
 * The cap of a picture in a `size="viewer"` sheet: the height its dialog leaves for the body. Set only on
 * a dialog (`--sheet-body-room`); on a bottom sheet the property is unset, so the cap is `none` and the
 * picture is drawn exactly as before.
 */
export const SHEET_PICTURE_FIT = "max-h-(--sheet-body-room)";

/** The widest a `size="viewer"` dialog stands. */
const VIEWER_MAX_W = "min(92vw, 1200px)";
/**
 * The body's inner width of a `viewer` dialog at its widest (less the body's `px-4` and the panel's 1px
 * edges), published as `--sheet-body-width` on a viewer dialog only. A content that must not change the
 * dialog's size from one page to the next (`PagerSheet`) takes it as its width; unset elsewhere.
 */
const VIEWER_BODY_W = `calc(${VIEWER_MAX_W} - 2rem - 2px)`;

/**
 * How the sheet is drawn: from the bottom edge, or as a centred dialog. A dialog on the `expanded` width
 * class with the screen flat, when the sheet's own layer has an expanded room too; a bottom sheet on
 * `compact` and `medium`, where the thumb is at the bottom edge, on a foldable folded as a book or held as
 * a tabletop, where the middle of the window is the hinge, and in a phone-size frame. Read only while a
 * sheet is up (`SheetLayer`), so a closed sheet listens to nothing.
 */
export type SheetPresentation = "sheet" | "dialog";

/**
 * A sheet's drawing, as its panel's `data-presentation` names it: the two above, or `menu`, a dialog
 * drawn beside the button that opened it (`anchor`).
 */
export type SheetDrawing = SheetPresentation | "menu";

/**
 * Whether a box the size of the sheet's fixed layer is an expanded room: at least `EXPANDED_MIN_PX` wide
 * and `WIDE_MIN_HEIGHT_PX` tall. A box with no size at all has no layout to read (nothing laid out, or a
 * test's DOM), and then the window decides alone.
 */
export function isExpandedRoom(room: { width: number; height: number }): boolean {
  if (room.width === 0 && room.height === 0) return true;
  return room.width >= EXPANDED_MIN_PX && room.height >= WIDE_MIN_HEIGHT_PX;
}

/**
 * THE ROOM IS THE LAYER'S, NOT ONLY THE WINDOW'S. The website and the design reference draw the app's
 * screens in phone frames in the page, no iframe, and a frame's stage carries a transform, so a `fixed`
 * layer inside it is laid out in the stage. The width class still comes from the window, so a phone-size
 * demo on a desktop would draw a dialog inside the phone. The probe is a `fixed inset-0` box in the
 * layer: its box is the layer's containing block, the window or the stage, read in the layout phase
 * before the first paint, and again when it resizes. No frame has to set anything.
 */
function useLayerRoom(probe: React.RefObject<HTMLElement | null>): boolean {
  const [roomy, setRoomy] = React.useState(true);
  React.useLayoutEffect(() => {
    const el = probe.current;
    if (el === null) return;
    const read = () => setRoomy(isExpandedRoom(el.getBoundingClientRect()));
    read();
    const resizes = hasResizeObserver() ? new ResizeObserver(read) : null;
    resizes?.observe(el);
    window.addEventListener("resize", read);
    return () => {
      resizes?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [probe]);
  return roomy;
}

function useSheetPresentation(probe: React.RefObject<HTMLElement | null>, only: "auto" | "sheet"): SheetPresentation {
  const widthClass = useWidthClass();
  const posture = useFoldPosture();
  const roomy = useLayerRoom(probe);
  return only === "auto" && widthClass === "expanded" && posture === "flat" && roomy ? "dialog" : "sheet";
}

// A minimal bottom sheet — no Radix, no portals, no extra deps. Renders nothing when closed.
// Dismisses on backdrop tap or Escape. Animations come from tw-animate-css (already imported).
//
// ON A WIDE WINDOW IT IS A CENTRED DIALOG (ADR 0167, addendum 2026-11-20). Same component, same task, same
// rows: on the `expanded` width class the panel stands in the middle of the window in the modal's look
// (ui/modal.tsx), with no grab handle, no pull down to close and no peek. See `useSheetPresentation`.
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
  /**
   * Pull-down on the panel closes the sheet. Default true, so every existing caller keeps that
   * gesture. The image editor turns it off so a downward crop drag or annotation stroke on the
   * canvas never pulls the sheet closed.
   */
  dragToDismiss?: boolean;
  /**
   * A control at the trailing end of the title row, directly before the close button. Absent: the row is
   * exactly as it was. The slot adds no height of its own (the row is as tall as the 32px close button),
   * so a caller passes a control no taller than that, and buys any hit area past it with a reach of its
   * own (`ui/tap-target.ts`). The sheet knows nothing about what the control does.
   */
  action?: React.ReactNode;
  /**
   * The dialog's width on a wide window. `column` (the default): the 640px column every sheet has.
   * `viewer`: as wide as its picture, up to `min(92vw, 1200px)` and never narrower than the column, for a
   * sheet whose content is a picture or a document page (`ImageSheet`, `PagerSheet`); its picture caps its
   * height with `SHEET_PICTURE_FIT`, and a content that pages may take the widest body width,
   * `--sheet-body-width`. `form`: a form with a foot of its own (the New dialog, components/new-over.tsx). The
   * panel does not scroll and its body has no padding: the content lays out its columns, scrolls them itself and
   * keeps its foot in view, at most 720px tall. The caller gives its width (`className`, `max-w-*`); it holds a
   * focus trap, since its foot's buttons are the last stop of the Tab order. A bottom sheet ignores the width.
   */
  size?: "column" | "viewer" | "form";
  /**
   * `auto` (the default): a centred dialog on a wide window, a bottom sheet elsewhere. `sheet`: a bottom
   * sheet on every width class, for a sheet that is the whole screen on purpose while it is up (the tour,
   * `tour-sheet.tsx`, its one caller). Nothing else passes it.
   */
  presentation?: "auto" | "sheet";
  /**
   * The button that opened the sheet, for a small menu opened from it (the pane, tab and space menus).
   * Where the sheet is a dialog and the button is in the document and in view when it opens, the sheet is
   * drawn as a MENU beside it: below the button, trailing edges aligned, flipped above when the room
   * below is too small, kept 8px inside the window (`lib/menu-place.ts`), 20rem wide, in the modal's look,
   * with no dimming and no entrance (the reasons of `ui/anchored-menu.tsx`). It follows a scroll and a
   * resize. No title row and no close button unless the caller passes `action`; the title stays the
   * dialog's name. On close the focus goes back to the button. Absent, gone or hidden, and on a bottom
   * sheet: no change at all. Pass it only when the sheet was opened by a tap on that button.
   */
  anchor?: React.RefObject<HTMLElement | null>;
  /**
   * When the sheet is drawn as a menu beside `anchor`, put the focus on its first row as it opens, so the
   * arrow keys and Enter work at once. For a menu a key opened (the Pane menu); a tap opens it with the
   * focus on the panel, as before. The arrow keys move between the rows of any menu, with this or without.
   */
  focusFirstRow?: boolean;
}

export function BottomSheet(props: BottomSheetProps) {
  // Closed and not pulled: nothing is drawn, and nothing below runs, so the many closed sheets of a
  // screen hold no width or focus listeners of their own.
  if (!props.open && !((props.pull ?? 0) > 0)) return null;
  return <SheetLayer {...props} />;
}

function SheetLayer({
  open,
  onClose,
  title,
  children,
  className,
  pull = 0,
  pullFrom = 0,
  dragToDismiss = true,
  action,
  size = "column",
  presentation: only = "auto",
  anchor,
  focusFirstRow = false,
}: BottomSheetProps) {
  useLocale();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef({ startY: 0, atTop: false, engaged: false, dy: 0 });
  const [dragY, setDragY] = React.useState(0);
  const titleId = React.useId();
  const probeRef = React.useRef<HTMLSpanElement>(null);
  const presentation = useSheetPresentation(probeRef, only);
  const dialog = presentation === "dialog";
  const room = useModalRoom("center");
  const menu = useAnchoredMenu({ open, dialog, anchor, panel: panelRef, probe: probeRef });
  const drawing: SheetDrawing = menu ? "menu" : presentation;
  // A peek never opened, so it must never claim focus or block the page behind it from the a11y
  // tree's point of view either way; the dialog role below is only meaningful once `open` is true.
  // A dialog never peeks: the pull is a touch gesture of the compact layout, and a dialog drawn half
  // way up from nowhere would mean nothing.
  const peeking = !dialog && !open && pull > 0;
  // Remembers whether the LAST render was a peek, so the render where `open` flips true can tell
  // "this is a drag continuing into an open" from "this open had nothing before it". That one render
  // takes the 180ms glide below; it is true for that render only.
  const wasPeeking = React.useRef(false);
  // Whether the CURRENT open began as a peek, held until the sheet closes. The entrance classes read
  // this, not `continuingFromPeek`: that is true for one render only, so the next re-render of the
  // open sheet (a poll, a keyboard resize) added `animate-in`, which restarts the keyframe at
  // translateY(100%) — the sheet dropped out of view and slid back in.
  const openedFromPeek = React.useRef(false);
  useDialogFocus(open, panelRef);
  // A menu gives the focus back to its button, also where the browser did not focus it on the tap
  // (Safari): declared after `useDialogFocus`, so this cleanup runs after that one's restore.
  React.useEffect(() => {
    if (!menu) return;
    const trigger = anchor?.current;
    return () => trigger?.focus({ preventScroll: true });
  }, [menu, anchor]);
  React.useEffect(() => {
    if (!menu || !focusFirstRow) return;
    menuRows(panelRef.current)[0]?.focus({ preventScroll: true });
  }, [menu, focusFirstRow]);
  // The arrow keys of a menu go between its rows. Heard on the window, as Escape is, and only while it is a menu.
  React.useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => moveMenuFocus(e, panelRef.current);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  React.useEffect(() => {
    if (!open) return;
    bumpOpenSheets(1);
    return () => bumpOpenSheets(-1);
  }, [open]);

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

  // Escape closes the top layer only: a sheet opened from a sheet (Start without prompts? over the New dialog)
  // is closed alone, and the one under it stays.
  const layer = React.useRef({});
  React.useEffect(() => {
    if (!open) return;
    const me = layer.current;
    layerStack.push(me);
    return () => {
      const at = layerStack.lastIndexOf(me);
      if (at !== -1) layerStack.splice(at, 1);
    };
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && layerStack[layerStack.length - 1] === layer.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  // A FORM DIALOG'S TOP EDGE STAYS WHERE THE PERSON FIRST MET IT. It opens centred and re-centres while its content
  // arrives; from the first release of a press, or a key, inside it, the top is held and a change of its height (another variant
  // of the form) grows or shrinks it downward, so the field under the pointer does not move. `offsetTop`, not the
  // box: the entrance zoom is a transform. The frame then stacks from its top. Reset on close and on a resize.
  const [formTop, setFormTop] = React.useState<number | null>(null);
  const holdFormTop = () => {
    if (formTop !== null || size !== "form" || !dialog) return;
    const panel = panelRef.current;
    const frame = panel?.parentElement;
    if (panel == null || frame == null) return;
    setFormTop(Math.max(0, panel.offsetTop - parseFloat(getComputedStyle(frame).paddingTop)));
  };
  React.useEffect(() => {
    if (!open) setFormTop(null);
    if (!open || formTop === null) return;
    const release = () => setFormTop(null);
    window.addEventListener("resize", release);
    return () => window.removeEventListener("resize", release);
  }, [open, formTop]);
  // A form dialog keeps the Tab order inside it: past its last control the focus goes to its first, and back.
  React.useEffect(() => {
    if (!open || size !== "form" || !dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || layerStack[layerStack.length - 1] !== layer.current) return;
      const panel = panelRef.current;
      if (panel === null) return;
      const stops = tabStops(panel);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey && (!inside || active === first || active === panel)) {
        e.preventDefault();
        last.focus();
        return;
      }
      if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, size, dialog]);

  // Drag-to-dismiss: pull the sheet down from the top to close it. The touchmove listener is
  // attached NON-PASSIVE so we can `preventDefault()` the downward pull — that's what suppresses
  // the browser's pull-to-refresh (otherwise a pull-down at the top would reload the whole app
  // instead of closing the sheet). A gesture that starts mid-scroll falls through to normal list
  // scrolling; only a pull that begins at the top engages the dismiss. A move a child claimed with
  // preventDefault, or one with two fingers down, lets the pull go (see onMove).
  //
  // `onClose` IS READ THROUGH A REF, NOT A DEPENDENCY. A caller may pass a fresh function on every
  // render (the switcher passes `closeDrawer`, an inline arrow), and with `onClose` in the deps every
  // re-render of the caller re-ran this effect, whose `setDragY(0)` snapped a sheet held mid-drag
  // back to the top. The pane polls every 1.5s while an agent works, so a slow drag flickered back to
  // 0 on each poll and jumped under the finger again on the next move (2026-11-06). The reset below
  // belongs to a new open only.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    const panel = panelRef.current;
    // A dialog takes no pull: no listener, so no touch (a touchscreen laptop, a tablet held sideways)
    // moves its panel, and its style never reads `dragY`.
    if (!open || !panel || !dragToDismiss || dialog) return;
    setDragY(0);
    const SLOP = 6; // ignore taps / tiny jitter before engaging the drag
    const CLOSE = 90; // px past which release closes instead of snapping back

    // Lets go of the pull for the rest of this touch, and the panel settles back to the top.
    const release = () => {
      drag.current = { startY: 0, atTop: false, engaged: false, dy: 0 };
      setDragY(0);
    };
    const onStart = (e: TouchEvent) => {
      // A second finger landing is a pinch, never a pull to close.
      if (e.touches.length > 1) {
        release();
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const inTextarea = e.target instanceof Element && e.target.closest("textarea") !== null;
      drag.current = { startY: t.clientY, atTop: !inTextarea && panel.scrollTop <= 0, engaged: false, dy: 0 };
    };
    const onMove = (e: TouchEvent) => {
      const d = drag.current;
      if (!d.atTop) return;
      // A move a part inside the sheet already claimed (a zoomed picture's pan or pinch calls
      // preventDefault before the move bubbles here, ui/zoom-picture.tsx), or a second finger, is
      // never a pull to close. The drag lets go for the rest of this touch and the panel settles back.
      if (e.defaultPrevented || e.touches.length > 1) {
        release();
        return;
      }
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
  }, [open, dragToDismiss, dialog]);

  // Read BEFORE updating: this render's "did the one before me peek" answer, which is what tells a
  // fresh open from a drag continuing into one. Updated for the NEXT render right after.
  const continuingFromPeek = open && wasPeeking.current;
  wasPeeking.current = peeking;
  openedFromPeek.current = open && (openedFromPeek.current || continuingFromPeek);
  const skipEntrance = openedFromPeek.current;

  // The room probe (`useLayerRoom`): a box the size of this layer's containing block, drawn nothing.
  const probe = <span ref={probeRef} aria-hidden="true" data-slot="sheet-room" className="pointer-events-none invisible fixed inset-0" />;
  // A pull the window's class turned down (a dialog never peeks) still measures the room: in a phone-size
  // frame the layer is a bottom sheet after all, and the peek follows the finger there.
  if (!open && !peeking) return pull > 0 ? probe : null;

  // Optional chaining is the jsdom guard here, not a `typeof` check: `matchMedia` is simply absent
  // on `window` in a test environment that hasn't polyfilled it, same as `navigator.vibrate` is
  // absent on iOS Safari in lib/haptics.ts.
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // A dialog's cap stands inline, so no caller's `max-h-*` outgrows it, and it publishes the height its
  // body has left for a picture (`SHEET_PICTURE_FIT`). It never carries a transform.
  const dialogStyle: React.CSSProperties & Partial<Record<"--sheet-body-room" | "--sheet-body-width", string>> = {
    maxHeight: size === "form" ? `min(720px, ${DIALOG_MAX_H})` : DIALOG_MAX_H,
    "--sheet-body-room": DIALOG_BODY_ROOM,
  };
  if (formTop !== null) dialogStyle.marginTop = formTop;
  if (size === "viewer") dialogStyle["--sheet-body-width"] = VIEWER_BODY_W;
  // Peeking: no dialog role, no aria-modal, no pointer events on the page underneath. Nothing has
  // opened yet, so nothing about this render should read as a modal to assistive tech or the mouse.
  const panelStyle: React.CSSProperties | undefined = menu
    ? undefined
    : dialog
    ? dialogStyle
    : peeking
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
      className={menu ? "fixed inset-0 z-50" : dialog ? cn(MODAL_FRAME, MODAL_CENTER_FRAME, formTop !== null && "justify-start") : "fixed inset-x-0 top-0 z-50 flex h-(--app-h) flex-col justify-end"}
      role={peeking ? undefined : "dialog"}
      aria-modal={peeking ? undefined : true}
      aria-labelledby={!peeking && title ? titleId : undefined}
      aria-hidden={peeking ? "true" : undefined}
      style={peeking ? { pointerEvents: "none" } : dialog && !menu ? room : undefined}
    >
      {probe}
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
        className={
          menu
            ? // A menu dims nothing: its button stays in plain view (ui/anchored-menu.tsx). A clear layer
              // that closes on an outside press, by the same press-and-release rule.
              "absolute inset-0 cursor-default"
            : dialog
            ? cn(MODAL_SCRIM, "motion-reduce:animate-none")
            : cn("absolute inset-0 bg-black/50", !peeking && !skipEntrance && "duration-200 animate-in fade-in")
        }
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
        onPointerUpCapture={size === "form" ? holdFormTop : undefined}
        onKeyDownCapture={size === "form" ? holdFormTop : undefined}
        data-presentation={drawing}
        className={menu ? menuPanelClass(className) : dialog ? dialogPanelClass(size, className) : cn(
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
          !peeking && !skipEntrance && "duration-200 animate-in slide-in-from-bottom",
          "pb-[calc(env(safe-area-inset-bottom)_+_1rem)]",
          className,
        )}
      >
        {/* Solid, never a blur: a sheet's rows animate (a working dot, a spinner) as they scroll under
            this row, and a blur over an animation redraws every frame (issue 748). */}
        {menu && !action ? (
          // A menu beside its button needs no heading and no close: the title is the dialog's name only.
          <span id={title ? titleId : undefined} data-slot="sheet-title" className="sr-only">
            {title}
          </span>
        ) : (
        <div className="sticky top-0 z-10 border-b border-rule bg-card">
          {/* Grab handle — pull down (from anywhere at the top) to dismiss. */}
          {/* Not on a dialog, which takes no pull. Its title row takes the handle's 1rem as padding
              instead (`py-3.5` for `pb-3`), so the head keeps the height SHEET_BODY_STICKY states. */}
          {dialog ? null : (
            <div data-slot="sheet-handle" className="flex justify-center pt-2 pb-1">
              {/* 4px tall, 36px wide — a stadium, so it takes the house 2px rather than full-round. */}
              <span className="h-1 w-9 rounded-md bg-muted-foreground/40" />
            </div>
          )}
          <div data-slot="sheet-title-row" className={cn("flex items-center justify-between px-4", dialog ? "py-3.5" : "pb-3")}>
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
            {/* 12px (`mr-3`) between the action and the close button: a mis-tap on the action may leave the screen,
                a mis-tap on the close button only closes the sheet, so their hit areas keep clear of each other,
                pressed too (the action's press reach is 3% of its width, the close button's 1.5%). */}
            {action ? (
              <span data-slot="sheet-action" className="mr-3 flex shrink-0 items-center">
                {action}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={onClose}
              aria-label={translate("common.closeAria")}
            >
              <Icon name="close" className="size-4" />
            </Button>
          </div>
        </div>
        )}
        <div data-slot="sheet-body" className={dialog && size === "form" ? "flex min-h-0 flex-1 flex-col" : "px-4 py-3"}>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The panel of a sheet drawn as a menu beside its button: the modal's look, 20rem wide, placed by
 * `useAnchoredMenu`, no entrance. The caller's sizes give way as they do in a dialog.
 */
function menuPanelClass(className: string | undefined): string {
  return cn(
    "absolute z-10 w-80 max-w-[calc(100%-1rem)] overflow-y-auto overscroll-contain outline-none",
    MODAL_PANEL_LOOK,
    className,
    "h-auto max-h-none rounded-md pb-0",
  );
}

/** The rows of a menu beside its button: the buttons and links that can take the focus, in order. */
function menuRows(panel: HTMLElement | null): HTMLElement[] {
  if (panel === null) return [];
  return [...panel.querySelectorAll<HTMLElement>("button, a[href]")].filter((row) => !row.matches(":disabled, [tabindex='-1']"));
}

/**
 * A menu's roving focus: Down and Up move to the next and the previous row (past the last row it wraps),
 * Home and End go to the ends. Enter and Space press the focused row as a button does, so nothing is added
 * for them. With the focus on the panel itself, Down takes the first row and Up the last.
 */
function moveMenuFocus(e: KeyboardEvent, panel: HTMLElement | null): void {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const rows = menuRows(panel);
  const at = rows.findIndex((row) => row === document.activeElement);
  const target = menuTarget({ key: e.key, at, count: rows.length });
  if (target === null) return;
  e.preventDefault();
  rows[target]?.focus({ preventScroll: true });
}

/** The row a key moves the focus to, or null when the key is not a menu's. `at` is -1 when no row has the focus. */
function menuTarget(input: { key: string; at: number; count: number }): number | null {
  const { key, at, count } = input;
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowDown") return (at + 1) % count;
  if (key === "ArrowUp") return at < 0 ? count - 1 : (at - 1 + count) % count;
  return null;
}

/**
 * Whether the open sheet is drawn as a menu beside `anchor`, and its place. Decided in the layout phase
 * of the open, before the first paint: a dialog, and the button in the document and in view. The panel
 * is placed by writing its `top`, `left` and `max-height` straight to it, measured against the layer's
 * own box (the probe's), and again on any scroll, a resize, or a change of the rows' height. It follows;
 * it never closes on a scroll, because a pane's own output scrolls the page under it.
 */
function useAnchoredMenu({
  open,
  dialog,
  anchor,
  panel,
  probe,
}: {
  open: boolean;
  dialog: boolean;
  anchor: React.RefObject<HTMLElement | null> | undefined;
  panel: React.RefObject<HTMLDivElement | null>;
  probe: React.RefObject<HTMLSpanElement | null>;
}): boolean {
  const [shown, setShown] = React.useState(false);
  React.useLayoutEffect(() => {
    const decide = () => setShown(open && dialog && isAnchorShown(anchor?.current ?? null, { width: window.innerWidth, height: window.innerHeight }));
    decide();
  }, [open, dialog, anchor]);
  const menu = open && dialog && shown;
  React.useLayoutEffect(() => {
    const el = panel.current;
    const body = el?.querySelector('[data-slot="sheet-body"]');
    if (!menu || el === null || anchor === undefined) return;
    const place = () => {
      const trigger = anchor.current;
      const layer = probe.current?.getBoundingClientRect();
      if (trigger === null || !trigger.isConnected || layer === undefined) return;
      const a = trigger.getBoundingClientRect();
      // The panel's own height, whatever its cap: the rows plus its 1px edges.
      const height = el.scrollHeight + (el.offsetHeight - el.clientHeight);
      const at = placeMenu({
        anchor: { left: a.left - layer.left, top: a.top - layer.top, width: a.width, height: a.height },
        panel: { width: el.offsetWidth, height },
        window: { width: layer.width || window.innerWidth, height: layer.height || window.innerHeight },
      });
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
      el.style.maxHeight = `${at.maxHeight}px`;
      el.dataset.side = at.side;
    };
    place();
    const resizes = hasResizeObserver() && body ? new ResizeObserver(place) : null;
    if (body) resizes?.observe(body);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { capture: true, passive: true });
    return () => {
      resizes?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, { capture: true });
    };
  }, [menu, anchor, panel, probe]);
  return menu;
}

/**
 * The panel of a sheet drawn as a dialog: the modal's look and entrance (none under reduced motion), the
 * body scrolling inside. The caller's `className` comes before the dialog's own corner and bottom padding,
 * so a bottom sheet's square top (`rounded-t-none`), its safe-area clearance (`TALL_SHEET_CLEARANCE`) or
 * its fixed height (`h-[85dvh]`, the key board editor and Pins) gives way: a dialog has four round
 * corners, stands clear of the bottom edge and is as tall as its content. Its height cap is the
 * inline `DIALOG_MAX_H`, above any caller's `max-h-*`.
 */
function dialogPanelClass(size: "column" | "viewer" | "form", className: string | undefined): string {
  return cn(
    size === "form" ? "relative z-10 flex flex-col overflow-hidden outline-none" : "relative z-10 overflow-y-auto overscroll-contain outline-none",
    MODAL_PANEL_LOOK,
    MODAL_CENTER_ENTRANCE,
    "motion-reduce:animate-none",
    size === "viewer" ? "w-fit min-w-[min(40rem,100%)] max-w-[min(92vw,1200px)]" : "w-full max-w-screen-sm",
    className,
    size === "form" ? "h-auto rounded-md" : "h-auto rounded-md pb-1",
  );
}

/** The controls of a panel the Tab key stops at, in order. */
function tabStops(panel: HTMLElement): HTMLElement[] {
  const candidates = panel.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]");
  return [...candidates].filter((el) => !el.matches(":disabled, [tabindex='-1'], [aria-hidden='true'] *, [inert] *") && el.getClientRects().length > 0);
}
