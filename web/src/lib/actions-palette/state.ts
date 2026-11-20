// Whether the Actions palette is open (ADR 0165). One small external store, read with
// `useSyncExternalStore`, so the doors (the Belt's Actions button, the header buttons, the
// `open_actions` key) and the palette itself need no prop and no shared ancestor. The palette is
// mounted once at the root (components/actions-palette.tsx, `ActionsPaletteDoor`).

import { useSyncExternalStore } from "react";

import { isActionsPaletteOn } from "@/lib/actions-palette-store";

let isOpen = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean): void {
  if (isOpen === next) return;
  isOpen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Opens nothing while this device has the palette off (lib/actions-palette-store.ts): no door can open it then. */
export function openActionsPalette(): void {
  if (!isActionsPaletteOn()) return;
  setOpen(true);
}

export function closeActionsPalette(): void {
  setOpen(false);
}

export function isActionsPaletteOpen(): boolean {
  return isOpen;
}

export function useActionsPaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, () => isOpen, () => false);
}

/** Test seam: closed, as before the first open. */
export function __resetActionsPalette(): void {
  setOpen(false);
}
