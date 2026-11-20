// Whether the shortcut list's sheet is open (M108). One small external store, read with
// `useSyncExternalStore`, so the `help` action, the Settings row and the sheet itself need no prop and
// no shared ancestor. The sheet is mounted once at the root (components/shortcut-help-door.tsx).

import { useSyncExternalStore } from "react";

/**
 * What the list is about. `screen`: the actions that work on the screen under it first, the rest
 * after them, dimmed (the `help` action). `all`: every action, plain, grouped (the Settings row, where
 * the list is about the keys and not about a screen).
 */
export type ShortcutListContext = "screen" | "all";

let isOpen = false;
let context: ShortcutListContext = "screen";
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

/** Open the list. A door names its context, so a click handler cannot pass an event in its place. */
export function openShortcutHelp(next: ShortcutListContext): void {
  context = next;
  isOpen = true;
  for (const listener of listeners) listener();
}

export function closeShortcutHelp(): void {
  setOpen(false);
}

export function useShortcutHelpOpen(): boolean {
  return useSyncExternalStore(subscribe, () => isOpen, () => false);
}

/** The context the list was last opened with. It stays through the close, so the sheet does not change while it slides away. */
export function useShortcutHelpContext(): ShortcutListContext {
  return useSyncExternalStore(subscribe, () => context, () => "screen");
}

/** Test seam: closed, as before the first open. */
export function __resetShortcutHelp(): void {
  context = "screen";
  setOpen(false);
}
