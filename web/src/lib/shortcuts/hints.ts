// KEY HINTS: where the key of an action is drawn on the control that its key would press (M108). While
// the prefix waits, the hint layer (components/shortcut-hint-layer.tsx) asks `collectHints` once per
// frame for the caps to draw and where. A control names its action with `shortcutTarget` (target.ts);
// nothing here knows a control.
//
// The pieces, each testable on its own: `hintKeyCaps` says which key an action shows (the live keymap's
// first prefix key, or its stand-in's while a setting has switched the action off), `placeHint` says where
// a cap goes (pure numbers in, a position or "none" out), and `collectHints` is the one DOM-reading
// function, which joins them and asks the browser the one question only it can answer: is the control
// the thing a person would hit at its centre.
//
// This file reads the DOM only inside `collectHints`, through the document it is given.

import { ACTIONS, type ActionId } from "./actions";
import { chordKeycaps } from "./parse";
import { isShortcutActionAvailable } from "./registry";
import { TARGET_ATTRIBUTE, TARGET_CORNER_ATTRIBUTE, TARGET_ICON_ATTRIBUTE, TARGET_INDEX_ATTRIBUTE, type HintCorner } from "./target";
import type { Keymap } from "./types";

/** A rectangle by its four edges, in viewport pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The room a cap keeps from the window's edge. */
export const HINT_MARGIN_PX = 4;
/** A key cap's height (`Keycap` in components/shortcut-list.tsx: `h-5`). */
const CAP_HEIGHT_PX = 20;
/** A key cap's least width (`min-w-5`), its side padding and border, and one mono glyph at 11px. */
const CAP_MIN_WIDTH_PX = 20;
const CAP_CHROME_PX = 10;
const CAP_GLYPH_PX = 6.6;
/** The gap between two caps of one chord (`gap-0.5`). */
const CAP_GAP_PX = 2;

/** What the caps of one chord measure, close enough to clamp them inside the window. */
export function capSize(caps: readonly string[]): Size {
  const widths = caps.map((cap) => Math.max(CAP_MIN_WIDTH_PX, CAP_CHROME_PX + Math.ceil(cap.length * CAP_GLYPH_PX)));
  const gaps = Math.max(0, caps.length - 1) * CAP_GAP_PX;
  return { width: widths.reduce((sum, width) => sum + width, 0) + gaps, height: CAP_HEIGHT_PX };
}

function intersect(a: Box, b: Box): Box | null {
  const box = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

function holds(box: Box, point: { x: number; y: number }): boolean {
  return point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;
}

export interface PlaceInput {
  /** The control's box. */
  readonly box: Box;
  /** The cap's size. */
  readonly cap: Size;
  readonly viewport: Size;
  /** What the scrolling ancestors leave of the control, or null when nothing clips it. */
  readonly clip: Box | null;
  /** The first svg or img inside the control, when it has one. */
  readonly glyph?: Box | null;
  /** The control draws words of its own. Then the cap goes on its box, never on a glyph among its letters. */
  readonly hasText?: boolean;
  /** The control names its icon as the anchor, whatever the box around it measures (the mark). */
  readonly icon?: boolean;
  /** The side the cap goes on: the top right by default, the top left for a control with a label at its right. */
  readonly corner?: HintCorner;
  /** The boxes of texts that a cap must not cover: the control's own and its neighbours'. Used for the icon case. */
  readonly avoid?: readonly Box[];
  /** The caps already placed in this frame. A cap that would meet one tries its next place. */
  readonly placed?: readonly Box[];
}

/** How far a cap overlaps its icon's corner, and how far it keeps from the icon's side, so the two read as one. */
export const HINT_TOUCH_PX = 2;

/** How much larger than its glyph a control's box must be in one direction before the cap goes on the glyph. */
export const GLYPH_SLACK_PX = 12;

/**
 * What the cap anchors on. A control with no text whose box is clearly larger than its icon (more than 12px in
 * either direction) is looked at as its icon: a 44px button around a 20px glyph, a button spread over a whole
 * row. The cap goes on that glyph's corner, not on the invisible corner of the box. Any other control is its box.
 */
export function anchorOf(input: { box: Box; glyph?: Box | null; hasText?: boolean; icon?: boolean }): Box {
  const { box, glyph, hasText, icon } = input;
  if (hasText === true || glyph === null || glyph === undefined) return box;
  if (icon === true) return glyph;
  const wider = box.right - box.left - (glyph.right - glyph.left) > GLYPH_SLACK_PX;
  const taller = box.bottom - box.top - (glyph.bottom - glyph.top) > GLYPH_SLACK_PX;
  return wider || taller ? glyph : box;
}

function meets(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** The places, in order, for the cap of an icon: it lies outside the icon and touches it. */
function iconPlaces(input: { glyph: Box; cap: Size; corner: HintCorner }): { left: number; top: number }[] {
  const { glyph, cap, corner } = input;
  const touch = HINT_TOUCH_PX;
  const right = corner === "top-right";
  const side = right ? glyph.right + touch : glyph.left - touch - cap.width;
  const out = right ? glyph.right - touch : glyph.left - cap.width + touch;
  return [
    { left: out, top: glyph.top - cap.height + touch },
    { left: side, top: glyph.top },
    { left: out, top: glyph.bottom - touch },
    { left: right ? glyph.left - touch - cap.width : glyph.right + touch, top: glyph.top },
    // Straight below the icon, then straight above it, aligned to the side the cap belongs to: for an icon in a
    // corner of the window, where the four places above have no room.
    { left: right ? glyph.right - cap.width : glyph.left, top: glyph.bottom + touch },
    { left: right ? glyph.right - cap.width : glyph.left, top: glyph.top - cap.height - touch },
  ];
}

/**
 * Where the cap goes. For an icon (see `anchorOf`): outside the icon, touching it, in the first of four places
 * that lies inside the window, misses the icon, misses every text in `avoid` and every cap already `placed`: up
 * and aside, beside it (top aligned), below and aside, on its other side, straight below, straight above. When
 * none fits it takes the corner place, so a hint never goes for lack of room. For any other control: centred on its top right corner (top
 * left with `corner`), half over it. Always inside the window with a margin. "none" when a person cannot see
 * the control: it has no box, or its centre is outside the window or outside what a scrolling ancestor shows of
 * it. A control seen only in part keeps its cap on the part that shows.
 */
export function placeHint(input: PlaceInput): { left: number; top: number } | "none" {
  const { box, cap, viewport, clip, corner = "top-right" } = input;
  const anchor = anchorOf(input);
  const shown = clip === null ? anchor : (intersect(anchor, clip) ?? intersect(box, clip));
  if (shown === null || box.right <= box.left || box.bottom <= box.top) return "none";
  const bounds: Box = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const room = clip === null ? bounds : intersect(bounds, clip);
  if (room === null || !holds(room, { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 })) return "none";
  const keep = (left: number, top: number) => ({
    left: Math.max(HINT_MARGIN_PX, Math.min(left, viewport.width - cap.width - HINT_MARGIN_PX)),
    top: Math.max(HINT_MARGIN_PX, Math.min(top, viewport.height - cap.height - HINT_MARGIN_PX)),
  });
  if (anchor !== box) {
    // The icon may be overlapped by the touch distance, no more.
    const own: Box = { left: shown.left + HINT_TOUCH_PX, top: shown.top + HINT_TOUCH_PX, right: shown.right - HINT_TOUCH_PX, bottom: shown.bottom - HINT_TOUCH_PX };
    const free = [...(input.avoid ?? []), ...(input.placed ?? [])];
    for (const at of iconPlaces({ glyph: shown, cap, corner })) {
      const area: Box = { left: at.left, top: at.top, right: at.left + cap.width, bottom: at.top + cap.height };
      const inside = area.left >= HINT_MARGIN_PX && area.top >= HINT_MARGIN_PX && area.right <= viewport.width - HINT_MARGIN_PX && area.bottom <= viewport.height - HINT_MARGIN_PX;
      if (inside && !meets(area, own) && !free.some((other) => meets(area, other))) return at;
    }
  }
  return keep((corner === "top-left" ? shown.left : shown.right) - cap.width / 2, shown.top - cap.height / 2);
}

function actionById(id: string): ActionId | undefined {
  return ACTIONS.find((action) => action.id === id)?.id;
}

/**
 * The caps an action shows: its first key behind the prefix in the keymap in force (a key a person set in
 * `shortcuts.toml` shows), or null when it has none. An indexed action (`switch_tab`) shows the key of the
 * digit `index`; a digit it has no key for shows nothing.
 */
export function hintKeyCaps(input: { keymap: Keymap; id: ActionId; index?: number | undefined }): string[] | null {
  const { keymap, id, index } = input;
  const bindings = keymap.bindings.get(id) ?? [];
  const binding = bindings.find((candidate) => candidate.prefix && (index === undefined || candidate.index === index));
  if (binding === undefined) return null;
  return foldModifiers(chordKeycaps({ chord: binding.chord, mac: keymap.mac }));
}

const MODIFIER_SYMBOLS = new Map([
  ["Ctrl", "\u2303"],
  ["Alt", "\u2325"],
  ["Option", "\u2325"],
  ["Shift", "\u21e7"],
  ["Cmd", "\u2318"],
  ["Meta", "\u2318"],
]);

/**
 * A chord with a modifier as ONE cap with the modifier's symbol (`Shift`, `N` becomes `\u21e7N`). A hint hangs on a
 * corner of a control, and two bar-width caps side by side reach over the neighbour's label, as `Shift N` did
 * over the count beside the New space button. The bar keeps the long names; there is room for them.
 */
function foldModifiers(caps: string[]): string[] {
  const key = caps.at(-1);
  const modifiers = caps.slice(0, -1);
  if (key === undefined || modifiers.length === 0 || !modifiers.every((cap) => MODIFIER_SYMBOLS.has(cap))) return caps;
  return [`${modifiers.map((cap) => MODIFIER_SYMBOLS.get(cap)).join("")}${key}`];
}

/** One cap to draw: which action, the keys, and the top left of its box. */
export interface Hint {
  readonly key: string;
  readonly action: ActionId;
  readonly caps: readonly string[];
  readonly left: number;
  readonly top: number;
}

function hides(value: string): boolean {
  return value !== "" && value !== "visible";
}

function isScrolling(style: CSSStyleDeclaration): boolean {
  return hides(style.overflowX) || hides(style.overflowY);
}

/** What the scrolling ancestors of `element` leave of its box, or null when no ancestor clips it. */
function clipOf(element: Element, view: Window): Box | null {
  let clip: Box | null = null;
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (!isScrolling(view.getComputedStyle(ancestor))) continue;
    const rect = ancestor.getBoundingClientRect();
    const ancestorBox: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    clip = clip === null ? ancestorBox : (intersect(clip, ancestorBox) ?? { left: 0, top: 0, right: 0, bottom: 0 });
  }
  return clip;
}

/** Whether the control draws words of its own. The title of an icon is no word: it is not drawn. */
function drawsWords(element: Element): boolean {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? "").trim() !== "" && node.parentElement?.closest("svg") == null) return true;
  }
  return false;
}

/** The box of the first icon or picture inside the control, or null when it has none or it draws nothing. */
function glyphBox(element: Element): Box | null {
  const glyph = element.querySelector("svg, img");
  if (glyph === null) return null;
  const rect = glyph.getBoundingClientRect();
  return rect.right > rect.left && rect.bottom > rect.top ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null;
}

/** The most text nodes one frame reads, so a long transcript cannot slow the loop that follows a scroll. */
const TEXT_NODE_LIMIT = 4000;

/**
 * The boxes of the texts on screen, which a cap must not cover: every visible text node outside the hint layer,
 * and every labelled drawing of letters.
 * Read once per frame, and only when an icon needs a place.
 */
function textBoxes(doc: Document): Box[] {
  const view = doc.defaultView;
  const body = doc.body;
  if (view === null || body === null || !("createRange" in doc)) return [];
  const boxes: Box[] = [];
  const range = doc.createRange();
  // A test window lays nothing out and draws no range boxes.
  if (!("getClientRects" in range)) return boxes;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let read = 0;
  for (let node = walker.nextNode(); node !== null && read < TEXT_NODE_LIMIT; node = walker.nextNode()) {
    read += 1;
    const parent = node.parentElement;
    if (parent === null || (node.textContent ?? "").trim() === "") continue;
    if (parent.closest("script, style, noscript, [data-slot='shortcut-hint-layer']") !== null) continue;
    const style = view.getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width > 0 && rect.height > 0) boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }
  // A drawing of letters, such as the wordmark, is a labelled picture, and counts as a text.
  for (const drawing of doc.querySelectorAll("svg[role='img']")) {
    const rect = drawing.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) boxes.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return boxes;
}

/**
 * A control in a column of the row that has no focus: the key acts on the focused column, so only that
 * one wears the hint. A control outside every column (the header, the sidebar) is the one control there is.
 */
function isInUnfocusedColumn(element: Element): boolean {
  const column = element.closest("[data-col-key]");
  return column !== null && !column.hasAttribute("data-focused");
}

/**
 * The hints to draw now. A control is hinted when its action does something on this screen (the registry's
 * answer), its key exists in the live keymap, a person can see it (placement), and it is the thing a person
 * would hit at its centre: one `elementFromPoint` probe, which a dialog, a sheet or the palette over the
 * page fails, while a control inside the top layer passes.
 */
export function collectHints(input: { doc: Document; keymap: Keymap; viewport: Size }): Hint[] {
  const { doc, keymap, viewport } = input;
  const view = doc.defaultView;
  if (view === null) return [];
  const hints: Hint[] = [];
  const seen = new Map<string, number>();
  const placed: Box[] = [];
  let texts: Box[] | null = null;
  for (const element of doc.querySelectorAll(`[${TARGET_ATTRIBUTE}]`)) {
    const id = actionById(element.getAttribute(TARGET_ATTRIBUTE) ?? "");
    if (id === undefined || isInUnfocusedColumn(element)) continue;
    const rawIndex = element.getAttribute(TARGET_INDEX_ATTRIBUTE);
    const index = rawIndex === null ? undefined : Number(rawIndex);
    if (!isShortcutActionAvailable(id)) continue;
    const caps = hintKeyCaps({ keymap, id, index });
    if (caps === null) continue;
    const rect = element.getBoundingClientRect();
    const box: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const glyph = glyphBox(element);
    const corner = element.getAttribute(TARGET_CORNER_ATTRIBUTE) === "top-left" ? "top-left" : "top-right";
    const hasText = drawsWords(element);
    const cap = capSize(caps);
    const icon = element.getAttribute(TARGET_ICON_ATTRIBUTE) === "true";
    const iconCase = anchorOf({ box, glyph, hasText, icon }) !== box;
    if (iconCase) texts ??= textBoxes(doc);
    const place = placeHint({ box, cap, viewport, clip: clipOf(element, view), glyph, hasText, icon, corner, avoid: iconCase ? (texts ?? []) : [], placed });
    if (place === "none") continue;
    const hit = doc.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    if (hit === null || !element.contains(hit)) continue;
    const slot = `${id}:${index ?? ""}`;
    const ordinal = seen.get(slot) ?? 0;
    seen.set(slot, ordinal + 1);
    placed.push({ left: place.left, top: place.top, right: place.left + cap.width, bottom: place.top + cap.height });
    hints.push({ key: `${slot}:${ordinal}`, action: id, caps, left: place.left, top: place.top });
  }
  return hints;
}
