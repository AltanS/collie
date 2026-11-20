// Whether the shortcut list's sheet is open (M108). One small external store, read with
// `useSyncExternalStore`, so the `help` action, the Settings row and the sheet itself need no prop and
// no shared ancestor. The sheet is mounted once at the root (components/shortcut-help-door.tsx).

import { useSyncExternalStore } from "react";

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

export function openShortcutHelp(): void {
  setOpen(true);
}

export function closeShortcutHelp(): void {
  setOpen(false);
}

export function useShortcutHelpOpen(): boolean {
  return useSyncExternalStore(subscribe, () => isOpen, () => false);
}

/** Test seam: closed, as before the first open. */
export function __resetShortcutHelp(): void {
  setOpen(false);
}
