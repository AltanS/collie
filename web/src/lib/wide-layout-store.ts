import { useSyncExternalStore } from "react";

import { asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "@/lib/json";
import { EMPTY_STRIP, presetOf, type Column, type SpaceStrip } from "@/lib/wide-layout";

// The large-screen layout this DEVICE keeps (ADR 0120): which panes each space shows as columns,
// at which width, and which one it last had in focus; and whether the sidebar is open or a rail.
//
// Per device and nothing else, the way lib/strips-collapsed.ts and lib/zen.ts are: it is "how this
// screen arranges what it shows", so it is never written to a bridge, carries no request id, and
// another phone or tablet keeps its own. Keyed on the pane's full address (lib/wide-layout.ts
// `columnKeyOf`), never a bare pane id.
//
// A key here outlives its pane: a closed pane's column is pruned from the view by the caller while
// the herd on screen is a live answer, and the next write stores what is left. The number of spaces
// kept is capped, oldest write first out, so a long-lived device does not grow the entry forever.

const LAYOUT_KEY = "collie:wide-layout:v1";
const SIDEBAR_KEY = "collie:wide-sidebar:v1";
const MODE_KEY = "collie:wide-layout-mode:v1";
/** The most spaces one device remembers. */
export const MAX_SPACES = 64;
/** The most columns one space keeps. Far more than any screen shows at once. */
export const MAX_COLUMNS = 24;

type Spaces = ReadonlyMap<string, SpaceStrip>;

/** Whether this device may use the large-screen layout. Auto follows the window; Off keeps the phone
 *  layout at every width. A per-device choice, like the sidebar's, and never written to a bridge. */
export type WideLayoutMode = "auto" | "off";
export const WIDE_LAYOUT_MODES: readonly WideLayoutMode[] = ["auto", "off"];

let spaces: Spaces = loadSpaces();
let sidebarOpen = loadSidebar();
let mode = loadMode();
const listeners = new Set<() => void>();

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null; // private mode
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Quota or private mode: the in-memory value still applies for this session.
  }
}

/** One stored strip, or null when the value is not one. Bad columns are dropped, not the strip. */
function parseStrip(raw: JsonValue | undefined): SpaceStrip | null {
  const obj = asJsonObject(raw);
  const cols = obj?.cols;
  if (obj === undefined || !Array.isArray(cols)) return null;
  const seen = new Set<string>();
  const kept: Column[] = [];
  for (const c of cols) {
    const col = asJsonObject(c);
    const key = asJsonString(col?.key);
    const preset = presetOf(asJsonString(col?.preset));
    if (key === undefined || key === "" || seen.has(key) || preset === undefined) continue;
    seen.add(key);
    kept.push({ key, preset });
  }
  const focus = asJsonString(obj.focus);
  return { cols: kept.slice(0, MAX_COLUMNS), focus: focus !== undefined && seen.has(focus) ? focus : null };
}

function loadSpaces(): Spaces {
  const raw = readStorage(LAYOUT_KEY);
  const parsed = raw === null ? undefined : parseJsonObject(raw);
  const out = new Map<string, SpaceStrip>();
  if (parsed === undefined) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const strip = parseStrip(value);
    if (strip !== null) out.set(key, strip);
  }
  return out;
}

function loadSidebar(): boolean {
  return readStorage(SIDEBAR_KEY) !== "0";
}

/** Anything but a stored "off" is auto, so an unknown or missing value never turns the layout off. */
function loadMode(): WideLayoutMode {
  return readStorage(MODE_KEY) === "off" ? "off" : "auto";
}

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** One space's strip as this device keeps it. */
export function spaceStrip(spaceKey: string): SpaceStrip {
  return spaces.get(spaceKey) ?? EMPTY_STRIP;
}

/** Store one space's strip. The space moves to the newest end; the oldest past the cap leave. */
export function setSpaceStrip(spaceKey: string, strip: SpaceStrip): void {
  if (spaces.get(spaceKey) === strip) return;
  const entries = [...spaces].filter(([key]) => key !== spaceKey);
  const kept = entries.slice(Math.max(0, entries.length - (MAX_SPACES - 1)));
  const stored: SpaceStrip = { cols: strip.cols.slice(0, MAX_COLUMNS), focus: strip.focus };
  spaces = new Map([...kept, [spaceKey, stored]]);
  writeStorage(LAYOUT_KEY, JSON.stringify(Object.fromEntries(spaces)));
  emit();
}

function allSpaces(): Spaces {
  return spaces;
}

/** Every space's strip, reactive. The object changes identity on every write and only then. */
export function useSpaceStrips(): Spaces {
  return useSyncExternalStore(subscribe, allSpaces, allSpaces);
}

export function isSidebarOpen(): boolean {
  return sidebarOpen;
}

export function setSidebarOpen(open: boolean): void {
  if (sidebarOpen === open) return;
  sidebarOpen = open;
  writeStorage(SIDEBAR_KEY, open ? "1" : "0");
  emit();
}

/** Whether the sidebar is open (true, the default) or collapsed to the rail. */
export function useSidebarOpen(): boolean {
  return useSyncExternalStore(subscribe, isSidebarOpen, () => true);
}

export function wideLayoutMode(): WideLayoutMode {
  return mode;
}

export function setWideLayoutMode(next: WideLayoutMode): void {
  if (mode === next) return;
  mode = next;
  writeStorage(MODE_KEY, next);
  emit();
}

/** The layout mode of this device, reactive. */
export function useWideLayoutMode(): WideLayoutMode {
  return useSyncExternalStore(subscribe, wideLayoutMode, () => "auto");
}

/** Test seam: back to a device that never stored a layout. */
export function __resetWideLayoutStore(): void {
  spaces = new Map();
  sidebarOpen = true;
  mode = "auto";
  writeStorage(LAYOUT_KEY, null);
  writeStorage(SIDEBAR_KEY, null);
  writeStorage(MODE_KEY, null);
  emit();
}

/** Test seam: read storage again, as a reload would. */
export function __reloadWideLayoutStore(): void {
  spaces = loadSpaces();
  sidebarOpen = loadSidebar();
  mode = loadMode();
  emit();
}
