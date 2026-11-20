// WHERE A MENU STANDS BESIDE ITS BUTTON (ui/sheet.tsx, a sheet with an `anchor` on a wide window). Pure:
// boxes in, a place out. `ui/anchored-menu.tsx` places its panel by CSS against its caller's box and has
// no placement to share; this is the one computed placement.
//
// Below the button first, its trailing edge on the button's trailing edge. Above it when the panel does
// not fit below and does fit above. When it fits on neither side, on the side with more room, as tall as
// that room (the body scrolls). Then moved to stay `MENU_MARGIN` inside the window on every side.

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface MenuPlace {
  readonly left: number;
  readonly top: number;
  /** The panel's cap: the room on the side it opens to. */
  readonly maxHeight: number;
  readonly side: "below" | "above";
}

/** The air between the button and the menu. */
export const MENU_GAP = 4;
/** The least room between the menu and the window's edge. */
export const MENU_MARGIN = 8;

export function placeMenu(input: { anchor: Box; panel: { width: number; height: number }; window: { width: number; height: number } }): MenuPlace {
  const { anchor, panel, window: win } = input;
  const below = win.height - MENU_MARGIN - (anchor.top + anchor.height + MENU_GAP);
  const above = anchor.top - MENU_GAP - MENU_MARGIN;
  const side = sideOf(panel.height, below, above);
  const room = Math.max(0, side === "below" ? below : above);
  const height = Math.min(panel.height, room);
  const top = side === "below" ? anchor.top + anchor.height + MENU_GAP : anchor.top - MENU_GAP - height;
  const left = anchor.left + anchor.width - panel.width;
  return {
    left: clamp(left, MENU_MARGIN, win.width - MENU_MARGIN - panel.width),
    top: clamp(top, MENU_MARGIN, win.height - MENU_MARGIN - height),
    maxHeight: room,
    side,
  };
}

function sideOf(height: number, below: number, above: number): "below" | "above" {
  if (height <= below) return "below";
  if (height <= above) return "above";
  return above > below ? "above" : "below";
}

/** `value` held between `min` and `max`; `min` wins when the two cross (a window narrower than the panel). */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** Whether a button can carry a menu: in the document, laid out, and at least partly inside the window. */
export function isAnchorShown(el: Element | null, win: { width: number; height: number }): boolean {
  if (el === null || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return r.right > 0 && r.bottom > 0 && r.left < win.width && r.top < win.height;
}
