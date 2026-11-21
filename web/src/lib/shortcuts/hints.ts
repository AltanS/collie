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
import { TARGET_ATTRIBUTE, TARGET_INDEX_ATTRIBUTE } from "./target";
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
}

/**
 * Where the cap goes: centred on the control's top right corner, half over it, and always inside the window
 * with a margin. "none" when a person cannot see the control: it has no box, or its centre is outside the
 * window or outside what a scrolling ancestor shows of it. A control seen only in part keeps its cap on the
 * part that shows.
 */
export function placeHint(input: PlaceInput): { left: number; top: number } | "none" {
  const { box, cap, viewport, clip } = input;
  const shown = clip === null ? box : intersect(box, clip);
  if (shown === null || box.right <= box.left || box.bottom <= box.top) return "none";
  const bounds: Box = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const room = clip === null ? bounds : intersect(bounds, clip);
  if (room === null || !holds(room, { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 })) return "none";
  const left = shown.right - cap.width / 2;
  const top = shown.top - cap.height / 2;
  return {
    left: Math.max(HINT_MARGIN_PX, Math.min(left, viewport.width - cap.width - HINT_MARGIN_PX)),
    top: Math.max(HINT_MARGIN_PX, Math.min(top, viewport.height - cap.height - HINT_MARGIN_PX)),
  };
}

function actionById(id: string): ActionId | undefined {
  return ACTIONS.find((action) => action.id === id)?.id;
}

/**
 * The action whose key a control of `id` shows: itself, or while a setting has switched it off (the Actions
 * palette), its stand-in, which answers its keys. Null when it is off and nothing stands in.
 */
export function hintAction(input: { keymap: Keymap; id: ActionId }): ActionId | null {
  const { keymap, id } = input;
  if (keymap.disabled?.has(id) !== true) return id;
  const def = ACTIONS.find((action) => action.id === id);
  return def !== undefined && "standIn" in def ? def.standIn : null;
}

/**
 * The caps an action shows: its first key behind the prefix in the keymap in force (a key a person set in
 * `shortcuts.toml` shows), or null when it has none. An indexed action (`switch_tab`) shows the key of the
 * digit `index`; a digit it has no key for shows nothing.
 */
export function hintKeyCaps(input: { keymap: Keymap; id: ActionId; index?: number | undefined }): string[] | null {
  const { keymap, id, index } = input;
  const action = hintAction({ keymap, id });
  if (action === null) return null;
  const bindings = keymap.bindings.get(action) ?? [];
  const binding = bindings.find((candidate) => candidate.prefix && (index === undefined || candidate.index === index));
  return binding === undefined ? null : chordKeycaps({ chord: binding.chord, mac: keymap.mac });
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
  for (const element of doc.querySelectorAll(`[${TARGET_ATTRIBUTE}]`)) {
    const id = actionById(element.getAttribute(TARGET_ATTRIBUTE) ?? "");
    if (id === undefined || isInUnfocusedColumn(element)) continue;
    const rawIndex = element.getAttribute(TARGET_INDEX_ATTRIBUTE);
    const index = rawIndex === null ? undefined : Number(rawIndex);
    const action = hintAction({ keymap, id });
    if (action === null || !isShortcutActionAvailable(action)) continue;
    const caps = hintKeyCaps({ keymap, id, index });
    if (caps === null) continue;
    const rect = element.getBoundingClientRect();
    const box: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    const place = placeHint({ box, cap: capSize(caps), viewport, clip: clipOf(element, view) });
    if (place === "none") continue;
    const hit = doc.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    if (hit === null || !element.contains(hit)) continue;
    const slot = `${id}:${index ?? ""}`;
    const ordinal = seen.get(slot) ?? 0;
    seen.set(slot, ordinal + 1);
    hints.push({ key: `${slot}:${ordinal}`, action: id, caps, left: place.left, top: place.top });
  }
  return hints;
}
