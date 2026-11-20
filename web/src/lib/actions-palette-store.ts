import { useSyncExternalStore } from "react";

// Whether this DEVICE uses the Actions palette (ADR 0165). On by default. Off puts the pane list back
// where the palette stands: the Belt's pinned button is the Switch pane button again, the header
// buttons are gone, and the key that opened the palette runs Switch pane (the action table's
// `standIn`, lib/shortcuts/keymap.ts). Altan, 2026-11-20: "use the regular session switcher instead".
//
// Per device and nothing else, the way lib/wide-layout-store.ts is: it is how this screen behaves, so
// it is never written to a bridge, and another phone or desktop keeps its own.

const KEY = "collie:actions-palette:v1";

let on = load();
const listeners = new Set<() => void>();

function readStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null; // private mode
  }
}

function writeStorage(value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, value);
  } catch {
    // Quota or private mode: the in-memory value still applies for this session.
  }
}

/** Anything but a stored "off" is on, so an unknown or missing value never takes the palette away. */
function load(): boolean {
  return readStorage() !== "off";
}

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isActionsPaletteOn(): boolean {
  return on;
}

export function setActionsPaletteOn(next: boolean): void {
  if (on === next) return;
  on = next;
  writeStorage(next ? null : "off");
  emit();
}

/** Whether the palette is on for this device, reactive. */
export function useActionsPaletteOn(): boolean {
  return useSyncExternalStore(subscribe, isActionsPaletteOn, () => true);
}

/** Test seam: back to a device that never chose. */
export function __resetActionsPaletteStore(): void {
  on = true;
  writeStorage(null);
  emit();
}

/** Test seam: read storage again, as a reload would. */
export function __reloadActionsPaletteStore(): void {
  on = load();
  emit();
}
