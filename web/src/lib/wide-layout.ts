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

export function widthClassOf(px: number): WidthClass {
  if (px >= EXPANDED_MIN_PX) return "expanded";
  if (px >= MEDIUM_MIN_PX) return "medium";
  return "compact";
}

/** The sidebar's width by width class, and the rail it collapses to. Compact has neither. */
export const SIDEBAR_WIDTH = { medium: 280, expanded: 320 } as const satisfies Record<Exclude<WidthClass, "compact">, number>;
export const RAIL_WIDTH = 56;

// ── Column widths ───────────────────────────────────────────────────────────────────────────────

/** A pane is never narrower than this many CSS px. */
export const MIN_PANE_WIDTH = 360;

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
  return all.map((g, i) => ({ g, i })).toSorted((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g);
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
