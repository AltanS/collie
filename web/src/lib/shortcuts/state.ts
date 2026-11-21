// What the running keymap shows the rest of the app (M108 spec 03): the mode it is in, the keymap
// it was built from, the short "Not on this screen" notice a key with no target raises, and the focus
// ring of Navigate mode over the sidebar's rows. Four small external stores, read with `useSyncExternalStore`, so the mode bar
// (components/shortcut-bar-host.tsx) and the shortcut list (components/shortcut-help-door.tsx) need no
// prop and no context.

import { useSyncExternalStore } from "react";

import type { Keymap, Mode } from "./types";

let mode: Mode = "normal";
let keymap: Keymap | null = null;
const modeListeners = new Set<() => void>();
const keymapListeners = new Set<() => void>();
const noticeListeners = new Set<() => void>();
const sidebarFocusListeners = new Set<() => void>();

/** How long the "Not on this screen" line stays up. */
export const SHORTCUT_NOTICE_MS = 2000;

let isNoticeShown = false;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

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
const subscribeNotice = subscribeTo(noticeListeners);
const subscribeSidebarFocus = subscribeTo(sidebarFocusListeners);

/**
 * The ring of Navigate mode: `index` counts the sidebar's focusable rows in the order the sidebar draws
 * them (lib/shortcuts/sidebar-focus.ts reads them from the DOM). Null while the mode is not on the sidebar.
 */
export interface SidebarFocus {
  readonly index: number;
}

let sidebarFocus: SidebarFocus | null = null;

/**
 * Whether the mode bar is up: a keymap is in force and a mode other than `normal` is active. THE ONE SOURCE
 * of that condition: the bar host (components/shortcut-bar-host.tsx) and the key hint layer
 * (components/shortcut-hint-layer.tsx) both read it, so the hints never show where the bar would not.
 */
export function isShortcutBarUp(current: Mode, built: Keymap | null): boolean {
  return built !== null && current !== "normal";
}

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

function setNotice(next: boolean): void {
  if (isNoticeShown === next) return;
  isNoticeShown = next;
  notify(noticeListeners);
}

function clearNoticeTimer(): void {
  if (noticeTimer === null) return;
  clearTimeout(noticeTimer);
  noticeTimer = null;
}

/**
 * A key of ours had no target on this screen: show the notice for {@link SHORTCUT_NOTICE_MS}. A second
 * such key while it shows starts the two seconds again, so the line never blinks off under a held key.
 */
export function publishShortcutNotice(): void {
  clearNoticeTimer();
  setNotice(true);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    setNotice(false);
  }, SHORTCUT_NOTICE_MS);
}

/** Whether the "Not on this screen" notice is up. */
export function getShortcutNotice(): boolean {
  return isNoticeShown;
}

export function useShortcutNotice(): boolean {
  return useSyncExternalStore(subscribeNotice, getShortcutNotice, getShortcutNotice);
}

export function getSidebarFocus(): SidebarFocus | null {
  return sidebarFocus;
}

export function publishSidebarFocus(next: SidebarFocus | null): void {
  if (sidebarFocus === next) return;
  if (sidebarFocus !== null && next !== null && sidebarFocus.index === next.index) return;
  sidebarFocus = next;
  notify(sidebarFocusListeners);
}

export function useSidebarFocus(): SidebarFocus | null {
  return useSyncExternalStore(subscribeSidebarFocus, getSidebarFocus, getSidebarFocus);
}

/** Test seam: the mode and keymap of a root that never mounted, no notice and no ring. */
export function __resetShortcutState(): void {
  mode = "normal";
  keymap = null;
  sidebarFocus = null;
  clearNoticeTimer();
  setNotice(false);
  notify(modeListeners);
  notify(keymapListeners);
  notify(sidebarFocusListeners);
}
