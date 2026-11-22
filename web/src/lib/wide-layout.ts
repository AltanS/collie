// The large-screen layout of the pane screen (ADR 0120): pure functions, no React, no storage.
//
// The model copies the niri window manager. The VERTICAL axis is spaces (a multiplexer workspace on
// one machine and session). The HORIZONTAL axis is one space's strip of columns: the panes the
// person brought into view there, each with its own width preset. Each space keeps its own columns
// and the pane it last had in focus.
//
// THE URL IS THE TRUTH. The focused column is always the route's pane, so nothing here holds a focus
// index for the screen: `arrive` is what a navigation does to a space's strip, and every other step
// is a change to the stored columns that the caller follows with a sideways navigation (`nav.side`)
// when it moves the focus.
//
// THE KEY IS THE PANE'S FULL ADDRESS (`paneScopeKey` of the pane's own scope, lib/scope.ts), never a
// bare pane id: `w1:p1` is a different terminal on every machine and in every session.
//
// Ported from the playground's approved prototype (playground/sections/wide-layout-model.ts); the
// phone gestures of its cards 4 to 6 are not part of this slice. Cards 5 and 6 (two fingers, the
// joystick) are lib/pane-nav-gesture.ts, ADR 0121.

import { paneScope } from "@/lib/hosts";
import { groupPanesByWorkspace, type GroupOptions, type WorkspaceGroup } from "@/lib/pane-groups";
import { nestPanes } from "@/lib/pane-tree";
import { paneScopeKey, scopeKey, type Scope } from "@/lib/scope";
import type { AgentView, ServerSummary, SessionSummary } from "@/lib/types";

// ── Width classes ───────────────────────────────────────────────────────────────────────────────

/** From the WINDOW width, never from posture or the fold APIs (ADR 0120): a flat-open Fold reports
 *  one viewport segment and posture `continuous`, so those APIs cannot say "unfolded". */
export type WidthClass = "compact" | "medium" | "expanded";

/** Below this is compact: phones and a Fold's cover screen. The app is unchanged there. */
export const MEDIUM_MIN_PX = 600;
/** From this is expanded: tablet landscape and desktop. */
export const EXPANDED_MIN_PX = 900;

/** A phone held sideways is 600 to 1000px wide and under 480px tall. Below this height every width is
 *  compact, so the sidebar and the strip never take a landscape phone. */
export const WIDE_MIN_HEIGHT_PX = 480;

export const MEDIUM_QUERY = `(min-width: ${MEDIUM_MIN_PX}px) and (min-height: ${WIDE_MIN_HEIGHT_PX}px)`;
export const EXPANDED_QUERY = `(min-width: ${EXPANDED_MIN_PX}px) and (min-height: ${WIDE_MIN_HEIGHT_PX}px)`;

/** The same two cuts by width alone, with no height test. Read while a field that types has focus
 *  (see {@link heldWidthClass}). */
export const MEDIUM_WIDTH_QUERY = `(min-width: ${MEDIUM_MIN_PX}px)`;
export const EXPANDED_WIDTH_QUERY = `(min-width: ${EXPANDED_MIN_PX}px)`;

/** Android closes the keyboard in about 300 ms. One second is far past it, and the only cost is a late drop to compact in a short window with no keyboard, which is rare. */
export const KEYBOARD_CLOSE_LINGER_MS = 1000;

/**
 * The width class to draw, given what the window says now and what was drawn last. The soft keyboard
 * shrinks the page height (`interactive-widget=resizes-content`), and under 480px tall the window
 * reads compact. A drop to compact would unmount the focused field and close the keyboard, then the
 * height returns and the layout flips back, so the person cannot type (issue 751). So while a typing
 * field has focus, a class that was wide stays as wide as the WIDTH alone allows. It never raises a
 * compact class: a phone held sideways starts compact and stays compact when its composer takes focus.
 */
export function heldWidthClass(fromWindow: WidthClass, last: WidthClass, typing: boolean, byWidth: WidthClass): WidthClass {
  if (fromWindow !== "compact") return fromWindow;
  if (!typing || last === "compact" || byWidth === "compact") return "compact";
  return byWidth;
}

export function widthClassOf(px: number): WidthClass {
  if (px >= EXPANDED_MIN_PX) return "expanded";
  if (px >= MEDIUM_MIN_PX) return "medium";
  return "compact";
}

/** The sidebar's width by width class, and the rail it collapses to. Compact has neither.
 *  MEDIUM IS 264, down from 280: on a 705px two-screen phone 280 was 40% of the screen. 264 is the
 *  floor where the summary line's commonest English word still fits ("12 unseen", 77px of an 83px
 *  slot); at 256 it fell back to a dot and a number. "1 needs you" wants 88px and drops its word
 *  below 269 (status-counts.tsx's ladder: the dot and the number stay, nothing is cut). */
export const SIDEBAR_WIDTH = { medium: 264, expanded: 320 } as const satisfies Record<Exclude<WidthClass, "compact">, number>;
export const RAIL_WIDTH = 56;

// ── Column widths ───────────────────────────────────────────────────────────────────────────────

/** A pane is never narrower than this many CSS px. It is 440, not the 360 of the first cut: at 360
 *  wide mode began at a 720px strip, so a lone column stood at 1/2 beside an empty add column on a
 *  1114 or 1180px tablet in landscape (392 and 425px of chat), and closing the sidebar on an 820px
 *  tablet in portrait made the chat NARROWER, 535 to 377px. From 440 wide mode begins at an 880px
 *  strip, and those three screens draw one full column (ADR 0120, addendum 2026-11-07). */
export const MIN_PANE_WIDTH = 440;

/** A column's width as a share of the strip, in wide mode only. Niri's preset column widths. */
export type Preset = "half" | "fourfifths" | "full";

export const PRESETS: readonly Preset[] = ["half", "fourfifths", "full"];

/** A newly opened column's width. */
export const NEW_COLUMN_PRESET: Preset = "half";

export const PRESET_FRACTION = {
  half: 1 / 2,
  fourfifths: 4 / 5,
  full: 1,
} as const satisfies Record<Preset, number>;

/** A stored word read back as a preset, or undefined when it names none. */
export function presetOf(word: string | undefined): Preset | undefined {
  return PRESETS.find((p) => p === word);
}

/**
 * WIDE MODE: the strip, at its CURRENT width (right of the sidebar or the rail), holds two panes at
 * the minimum width side by side. Not wide: every column is the strip's full width and there is no
 * width control. Wide: each column has a preset of 1/2, 4/5 or Full of the strip.
 */
export function isWideMode(stripWidth: number, minPane: number = MIN_PANE_WIDTH): boolean {
  return stripWidth >= 2 * minPane;
}

/** The presets that keep a column at or above the minimum width, in cycle order. Full always stays. */
export function allowedPresets(stripWidth: number, minPane: number = MIN_PANE_WIDTH): readonly Preset[] {
  return PRESETS.filter((p) => p === "full" || PRESET_FRACTION[p] * stripWidth >= minPane);
}

/** There is a width to choose: wide mode, and more than Full left. The button hides otherwise. */
export function hasWidthChoice(stripWidth: number, minPane: number = MIN_PANE_WIDTH): boolean {
  return isWideMode(stripWidth, minPane) && allowedPresets(stripWidth, minPane).length > 1;
}

/** The next preset in the cycle 1/2, 4/5, Full, skipping any `allowed` leaves out. */
export function nextPreset(p: Preset, allowed: readonly Preset[] = PRESETS): Preset {
  const from = PRESETS.indexOf(p);
  for (let k = 1; k <= PRESETS.length; k += 1) {
    const candidate = PRESETS[(from + k) % PRESETS.length];
    if (candidate !== undefined && allowed.includes(candidate)) return candidate;
  }
  return "full";
}

/** The preset a column is drawn at: its own when allowed, else the next wider one that is. */
export function shownPreset(p: Preset, allowed: readonly Preset[]): Preset {
  if (allowed.includes(p)) return p;
  const from = PRESETS.indexOf(p);
  return PRESETS.slice(from + 1).find((q) => allowed.includes(q)) ?? "full";
}

// ── Keys ────────────────────────────────────────────────────────────────────────────────────────

/** The places a pane lives: the ambient scope of the screen and the snapshot's machines and sessions. */
export interface Places {
  readonly scope: Scope;
  readonly servers?: readonly ServerSummary[] | undefined;
  readonly sessions?: readonly SessionSummary[] | undefined;
}

/** A pane's own scope: its machine and session, resolved the way every pane link resolves them. */
export function scopeOfPane(pane: AgentView, places: Places): Scope {
  return paneScope(places.scope, pane, places.servers, places.sessions);
}

/** A column's key: the pane's full address. The route's pane keys the same way from its URL scope. */
export function columnKeyOf(pane: AgentView, places: Places): string {
  return paneScopeKey(scopeOfPane(pane, places), pane.paneId);
}

/** The separator inside a key, the same NUL lib/scope.ts uses, which no id can contain. */
const KEY_SEP = "\u0000";

/** A space's key: its machine and session, then the multiplexer's workspace id. */
export function spaceKeyOf(pane: AgentView, places: Places): string {
  return `${scopeKey(scopeOfPane(pane, places))}${KEY_SEP}${pane.workspaceId}`;
}

/**
 * Spaces in the sidebar's workspace order: the agents' sections first, as the sidebar draws them,
 * then a space that holds only shells. The space header moves along this order, and so does the
 * pane navigation gesture (lib/pane-nav-gesture.ts, ADR 0121), so the two can never disagree.
 */
export function spacesInOrder(agents: readonly AgentView[], shells: readonly AgentView[], options: GroupOptions): WorkspaceGroup[] {
  const sections = groupPanesByWorkspace(agents, [], options).map((g) => g.key);
  const all = groupPanesByWorkspace(agents, shells, options);
  const rank = (g: WorkspaceGroup) => {
    const at = sections.indexOf(g.key);
    return at < 0 ? sections.length : at;
  };
  return all
    .map((g, i) => ({ g, i }))
    .toSorted((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
    .map(({ g }) => Object.assign({}, g, { panes: nestPanes(g.panes).map((entry) => entry.pane) }));
}

// ── One space's strip ───────────────────────────────────────────────────────────────────────────

export interface Column {
  /** The pane's full address ({@link columnKeyOf}). */
  readonly key: string;
  readonly preset: Preset;
}

/** One space's strip: its columns, and the pane it last had in focus (null before the first). */
export interface SpaceStrip {
  readonly cols: readonly Column[];
  readonly focus: string | null;
}

export const EMPTY_STRIP: SpaceStrip = { cols: [], focus: null };

function indexOf(strip: SpaceStrip, key: string): number {
  return strip.cols.findIndex((c) => c.key === key);
}

/** The index of the focused column, or -1. */
export function focusIndex(strip: SpaceStrip): number {
  return strip.focus === null ? -1 : indexOf(strip, strip.focus);
}

/**
 * The route arrived on `key` in this space. A pane that is a column takes the focus; one that is not
 * replaces the focused column (keeping its width), or becomes the first column of an empty strip.
 * Returns the same object when nothing changes, so a caller can tell a write is not owed.
 */
export function arrive(strip: SpaceStrip, key: string): SpaceStrip {
  if (indexOf(strip, key) >= 0) return strip.focus === key ? strip : { ...strip, focus: key };
  const at = focusIndex(strip);
  if (at < 0) {
    // No focus to replace: an empty strip, or a focus that left. The pane goes first.
    return { cols: [{ key, preset: NEW_COLUMN_PRESET }, ...strip.cols], focus: key };
  }
  return {
    cols: strip.cols.map((c, i) => (i === at ? { key, preset: c.preset } : c)),
    focus: key,
  };
}

/** "Open here": the pane replaces the focused column. A pane that is a column elsewhere moves. */
export function openHere(strip: SpaceStrip, key: string): SpaceStrip {
  const at = focusIndex(strip);
  if (at < 0 || strip.focus === key) return arrive(strip, key);
  const preset = strip.cols[at]?.preset ?? NEW_COLUMN_PRESET;
  const cols = strip.cols
    .map((c, i) => (i === at ? { key, preset } : c))
    .filter((c, i) => i === at || c.key !== key);
  return { cols, focus: key };
}

/** "Open beside": a new column right of the focused one, focused. An open pane moves, never doubles. */
export function openBeside(strip: SpaceStrip, key: string): SpaceStrip {
  const rest = strip.cols.filter((c) => c.key !== key);
  const focusAt = strip.focus === null || strip.focus === key ? -1 : rest.findIndex((c) => c.key === strip.focus);
  const at = focusAt < 0 ? rest.length : focusAt + 1;
  return {
    cols: [...rest.slice(0, at), { key, preset: NEW_COLUMN_PRESET }, ...rest.slice(at)],
    focus: key,
  };
}

/** A dropped row: inserted at a boundary of the columns as they were before the drop, focused. */
export function insertAt(strip: SpaceStrip, key: string, index: number): SpaceStrip {
  const removedAt = indexOf(strip, key);
  const rest = strip.cols.filter((c) => c.key !== key);
  const at = Math.min(Math.max(removedAt >= 0 && removedAt < index ? index - 1 : index, 0), rest.length);
  const preset = removedAt >= 0 ? (strip.cols[removedAt]?.preset ?? NEW_COLUMN_PRESET) : NEW_COLUMN_PRESET;
  return { cols: [...rest.slice(0, at), { key, preset }, ...rest.slice(at)], focus: key };
}

/** The width button: the next allowed preset for one column. The focus stays where it is. */
export function cycleWidth(strip: SpaceStrip, key: string, allowed: readonly Preset[]): SpaceStrip {
  return {
    ...strip,
    cols: strip.cols.map((c) => (c.key === key ? { ...c, preset: nextPreset(shownPreset(c.preset, allowed), allowed) } : c)),
  };
}

/**
 * One step along the allowed widths, narrower (`by` -1) or wider (+1), for the keyboard. Unlike the
 * button it does not wrap: it stops at the narrowest and at Full, and gives back the same strip there.
 */
export function stepWidth(strip: SpaceStrip, key: string, allowed: readonly Preset[], by: -1 | 1): SpaceStrip {
  const ladder = PRESETS.filter((p) => allowed.includes(p));
  const column = strip.cols.find((c) => c.key === key);
  if (column === undefined) return strip;
  const next = ladder[ladder.indexOf(shownPreset(column.preset, allowed)) + by];
  if (next === undefined) return strip;
  return { ...strip, cols: strip.cols.map((c) => (c.key === key ? { ...c, preset: next } : c)) };
}

/**
 * "Remove from view": the column leaves this device's layout and the agent keeps running. The last
 * column stays. A removed focused column hands the focus to its right neighbour, or its left one
 * at the end, and the caller navigates there.
 */
export function removeColumn(strip: SpaceStrip, key: string): SpaceStrip {
  const at = indexOf(strip, key);
  if (at < 0 || strip.cols.length <= 1) return strip;
  const cols = strip.cols.filter((_, i) => i !== at);
  if (strip.focus !== key) return { ...strip, cols };
  const next = cols[Math.min(at, cols.length - 1)];
  return { cols, focus: next?.key ?? null };
}

/** Drop the columns whose pane is no longer in a LIVE herd. Same object when none went. */
export function prune(strip: SpaceStrip, live: ReadonlySet<string>): SpaceStrip {
  const cols = strip.cols.filter((c) => live.has(c.key));
  if (cols.length === strip.cols.length) return strip;
  return { cols, focus: strip.focus !== null && live.has(strip.focus) ? strip.focus : null };
}

/**
 * Where a move to another space lands: that space's remembered focus while it is still a pane there,
 * else its first column, else its first pane.
 */
export function landingOf(strip: SpaceStrip, paneKeys: readonly string[]): string | null {
  const live = new Set(paneKeys);
  if (strip.focus !== null && live.has(strip.focus)) return strip.focus;
  return strip.cols.find((c) => live.has(c.key))?.key ?? paneKeys[0] ?? null;
}

// ── Strip geometry ──────────────────────────────────────────────────────────────────────────────

/** The scroll position that shows column `index` fully, or null when it already is. Aligns the
 *  column's left edge, which is also its snap point, so a programmatic scroll and the snap agree. */
export function scrollTargetFor(index: number, lefts: readonly number[], widths: readonly number[], scrollLeft: number, viewport: number, contentWidth: number): number | null {
  const left = lefts[index];
  const width = widths[index];
  if (left === undefined || width === undefined) return null;
  const fullyVisible = left >= scrollLeft - 0.5 && left + width <= scrollLeft + viewport + 0.5;
  if (fullyVisible) return null;
  return Math.min(Math.max(left, 0), Math.max(contentWidth - viewport, 0));
}

/** The strip always begins with a whole column: the nearest column start when the left edge cuts
 *  one, else null. A column may only peek at the RIGHT edge. */
export function wholeColumnStart(lefts: readonly number[], scrollLeft: number): number | null {
  let best: number | null = null;
  for (const left of lefts) {
    if (best === null || Math.abs(left - scrollLeft) < Math.abs(best - scrollLeft)) best = left;
  }
  return best === null || Math.abs(best - scrollLeft) <= 0.5 ? null : best;
}

/**
 * Where the strip scrolls after its columns changed, given the boxes as they now are: to the focused
 * column when it is not whole in view ({@link scrollTargetFor}), else to the nearest column start when
 * the left edge cuts one and the focused column stays whole from there ({@link wholeColumnStart}), else
 * to the focused column's start. Null: the strip stays where it is.
 */
export function followTarget(focusAt: number, lefts: readonly number[], widths: readonly number[], scrollLeft: number, viewport: number, contentWidth: number): number | null {
  const to = scrollTargetFor(focusAt, lefts, widths, scrollLeft, viewport, contentWidth);
  if (to !== null) return to;
  const whole = wholeColumnStart(lefts, scrollLeft);
  const left = lefts[focusAt];
  const width = widths[focusAt];
  if (whole === null || left === undefined || width === undefined) return whole;
  const keepsFocus = left >= whole - 0.5 && left + width <= whole + viewport + 0.5;
  return keepsFocus ? whole : left;
}

/** The boxes of a flat strip in scroll coordinates: each column's start and width, the add column's
 *  width, and the scrolled content's width. */
export interface StripGeometry {
  readonly lefts: readonly number[];
  readonly widths: readonly number[];
  readonly addWidth: number;
  readonly contentWidth: number;
}

/**
 * The flat strip's geometry as the layout draws it, from the columns' fractions alone: a column is its
 * fraction of the strip, never under `minPane` in wide mode (its `min-width`), and the add column ends
 * the strip, at least a pane wide and as wide as the room the last column leaves.
 */
export function stripGeometry(fractions: readonly number[], stripWidth: number, wide: boolean, minPane: number = MIN_PANE_WIDTH): StripGeometry {
  const widths = fractions.map((f) => (wide ? Math.max(f * stripWidth, minPane) : f * stripWidth));
  const lefts: number[] = [];
  let at = 0;
  for (const w of widths) {
    lefts.push(at);
    at += w;
  }
  const addWidth = Math.max(minPane, (1 - (fractions.at(-1) ?? 1)) * stripWidth);
  return { lefts, widths, addWidth, contentWidth: at + addWidth };
}

/**
 * Where the strip comes to rest after a width change, with no glide: the browser first clamps the old
 * scroll position to the new scroll range, then the focus scroll ({@link followTarget}) runs, and
 * `scrollTo` clamps its target to the range. A glide travels to exactly this place.
 */
export function restingScroll(geometry: StripGeometry, focusAt: number, scrollLeft: number, viewport: number): number {
  const end = Math.max(0, geometry.contentWidth - viewport);
  const clamped = Math.min(Math.max(scrollLeft, 0), end);
  const to = followTarget(focusAt, geometry.lefts, geometry.widths, clamped, viewport, geometry.contentWidth);
  return to === null ? clamped : Math.min(Math.max(to, 0), end);
}

// ── The view's spring ───────────────────────────────────────────────────────────────────────────
//
// The strip moves the way niri moves its view and resizes its windows: a critically damped spring.
// niri's defaults for `window-resize` and `horizontal-view-movement` are
// `spring damping-ratio=1.0 stiffness=800 epsilon=0.0001` (niri wiki, "Configuration: Animations";
// `src/animation/spring.rs` fixes the mass at 1 and stops once the value is within `epsilon` of its end,
// in the value's own units). With mass 1 and damping ratio 1 the motion has one rate, ω = √stiffness:
//   x(t) = to + (A + B·t)·e^(−ω·t),  A = x0 − to,  B = v0 + ω·A.
// From rest it never passes its end; started with a velocity toward the end it may pass it a little.

/** niri's stiffness for a resize and a view movement. */
export const VIEW_STIFFNESS = 800;

/** A spring's place and speed (units per second) at a moment. */
export interface SpringState {
  readonly x: number;
  readonly v: number;
}

/** Where a critically damped spring of mass 1 stands `t` seconds after it left `x0` at speed `v0`. */
export function springAt(x0: number, to: number, v0: number, t: number, stiffness: number = VIEW_STIFFNESS): SpringState {
  const w = Math.sqrt(stiffness);
  const a = x0 - to;
  const b = v0 + w * a;
  const e = Math.exp(-w * t);
  return { x: to + (a + b * t) * e, v: (b - w * (a + b * t)) * e };
}

/** Half a CSS pixel: a spring this close to its end draws its end. */
export const REST_PX = 0.5;
/** Slower than this (CSS px a second) a spring moves under half a pixel in a 60 Hz frame. */
export const REST_SPEED = REST_PX * 60;

/**
 * The stop rule: niri's epsilon, read in CSS pixels. A spring rests once it is within half a pixel of its
 * end AND so slow that the next frame would not move it half a pixel; `unit` is a pixel's worth of the
 * value (1 for px, the strip's width for a fraction of it).
 */
export function springRests(state: SpringState, to: number, unit: number = 1): boolean {
  return Math.abs(state.x - to) * unit <= REST_PX && Math.abs(state.v) * unit < REST_SPEED;
}

/** How long a spring from rest over `distance` px takes to rest, in ms, by the rule above. */
export function springRestMs(distance: number, stiffness: number = VIEW_STIFFNESS): number {
  for (let ms = 0; ms <= 3000; ms += 1) if (springRests(springAt(distance, 0, 0, ms / 1000, stiffness), 0)) return ms;
  return 3000;
}

/**
 * A CSS `linear()` easing that draws the spring from rest over `durationMs`, sampled `steps` times: for
 * a CSS transition that must read like the spring (the position strip). The last point is exactly 1.
 */
export function springEasing(durationMs: number, steps: number = 24, stiffness: number = VIEW_STIFFNESS): string {
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (durationMs / 1000) * (i / steps);
    const p = i === steps ? 1 : 1 - springAt(1, 0, 0, t, stiffness).x;
    points.push(String(Math.round(p * 10000) / 10000));
  }
  return `linear(${points.join(", ")})`;
}

/** Where a dragged row at `x` would land: the insert index (0 = before the first column, n = after
 *  the last) and that boundary's x, over the columns' left edges and widths. */
export interface DropPoint {
  readonly index: number;
  readonly at: number;
}

export function dropIndexAt(x: number, lefts: readonly number[], widths: readonly number[]): DropPoint {
  for (let i = 0; i < lefts.length; i++) {
    const left = lefts[i] ?? 0;
    const width = widths[i] ?? 0;
    if (x < left + width / 2) return { index: i, at: left };
  }
  const last = lefts.length - 1;
  return { index: lefts.length, at: last < 0 ? 0 : (lefts[last] ?? 0) + (widths[last] ?? 0) };
}

/** Travel past this (CSS px) on the space header counts as a swipe. */
export const SWIPE_PX = 40;

/** A swipe on the space header: up is the next space (the content moves up), down the previous.
 *  Null when the vertical travel is short or the swipe is mostly sideways. */
export function spaceSwipe(dx: number, dy: number): -1 | 1 | null {
  if (Math.abs(dy) < SWIPE_PX || Math.abs(dy) <= Math.abs(dx)) return null;
  return dy < 0 ? 1 : -1;
}
