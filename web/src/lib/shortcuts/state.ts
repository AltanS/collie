// What the running keymap shows the rest of the app (M108 spec 03): the mode it is in and the keymap
// it was built from. Two small external stores, read with `useSyncExternalStore`, so the mode bar
// (components/shortcut-bar-host.tsx) and the shortcut list (components/shortcut-help-door.tsx) need no
// prop and no context.

import { useSyncExternalStore } from "react";

import type { Keymap, Mode } from "./types";

let mode: Mode = "normal";
let keymap: Keymap | null = null;
const modeListeners = new Set<() => void>();
const keymapListeners = new Set<() => void>();

function notify(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) listener();
}

function subscribeTo(listeners: Set<() => void>): (listener: () => void) => () => void {
  return (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

const subscribeMode = subscribeTo(modeListeners);
const subscribeKeymap = subscribeTo(keymapListeners);

/** `normal`, `prefix` (one shot, waiting for the action key) or the id of a sticky mode. */
export function getShortcutMode(): Mode {
  return mode;
}

export function publishShortcutMode(next: Mode): void {
  if (mode === next) return;
  mode = next;
  notify(modeListeners);
}

export function useShortcutMode(): Mode {
  return useSyncExternalStore(subscribeMode, getShortcutMode, getShortcutMode);
}

/** The keymap in force, or null before the root mounted. Its `bindings` and `diagnostics` feed the help list. */
export function getShortcutKeymap(): Keymap | null {
  return keymap;
}

export function publishShortcutKeymap(next: Keymap | null): void {
  if (keymap === next) return;
  keymap = next;
  notify(keymapListeners);
}

export function useShortcutKeymap(): Keymap | null {
  return useSyncExternalStore(subscribeKeymap, getShortcutKeymap, getShortcutKeymap);
}

/** Test seam: the mode and keymap of a root that never mounted. */
export function __resetShortcutState(): void {
  mode = "normal";
  keymap = null;
  notify(modeListeners);
  notify(keymapListeners);
}
