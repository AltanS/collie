// The runtime half of the desktop shortcuts (M108 spec 03): who answers an action, and where the
// literal prefix goes. The keymap core (resolve.ts) decides WHICH action a key is; this file holds
// the handlers the app already has for it, so a handler that lives inside a component is reached
// without lifting that component's state.
//
// A component registers a handler for an action while it is mounted (`useShortcutHandler`). An
// action with no handler is a no-op: "remove from view" on the dashboard has no pane to remove,
// and that is not an error. The newest registration of an id wins, and a registration only removes
// itself, so a remount that registers before the old mount cleans up loses nothing.
//
// No React and no DOM here, so the dispatch is testable on its own.

import { ACTIONS, type ActionId, type ModeId } from "./actions";

/** What an action does. `index` is the digit of an indexed action (`switch_tab`), else absent. */
export type ShortcutHandler = (index?: number) => void;

/**
 * A sticky mode's key may run the handler of a global action it mirrors, so one registration serves
 * both. None does now: the Navigate keys move the sidebar's focus ring, a different act from the
 * `prefix` moves, so each registers on its own.
 */
const MIRRORS: ReadonlyMap<ActionId, ActionId> = new Map<ActionId, ActionId>();

const handlers = new Map<ActionId, ShortcutHandler>();
const availabilityListeners = new Set<() => void>();

function ownerOf(id: ActionId): ActionId {
  return MIRRORS.get(id) ?? id;
}

function notifyAvailability(): void {
  for (const listener of availabilityListeners) listener();
}

/** Answer `id` until the returned function is called. The newest answer wins. */
export function registerShortcutHandler(id: ActionId, handler: ShortcutHandler): () => void {
  const wasAnswered = handlers.has(id);
  handlers.set(id, handler);
  if (!wasAnswered) notifyAvailability();
  return () => {
    if (handlers.get(id) !== handler) return;
    handlers.delete(id);
    notifyAvailability();
  };
}

/** Run the handler of `id`. True when one was there, false for an action with no target on this screen. */
export function runShortcutAction(id: ActionId, index?: number): boolean {
  const handler = handlers.get(ownerOf(id));
  if (handler === undefined) return false;
  handler(index);
  return true;
}

/** Whether any key of the sticky mode has a handler now. A mode with none would only swallow keys. */
export function hasShortcutTarget(mode: ModeId): boolean {
  return ACTIONS.some((action) => "scope" in action && action.scope === mode && handlers.has(ownerOf(action.id)));
}

/**
 * Whether the action would do something on this screen now: a handler answers it, or, for the action
 * that opens a sticky mode, the mode has a key with a target. A list of actions on a screen with no
 * keyboard (the phone's actions sheet) hides the rows for which this is false.
 */
export function isShortcutActionAvailable(id: ActionId): boolean {
  const def = ACTIONS.find((action) => action.id === id);
  if (def === undefined) throw new Error(`No shortcut action ${id}`);
  if ("opensMode" in def) return hasShortcutTarget(def.opensMode);
  return handlers.has(ownerOf(id));
}

/** Every action of the table that would do something on this screen now, in table order. */
export function availableShortcutActions(): ActionId[] {
  return ACTIONS.filter((action) => isShortcutActionAvailable(action.id)).map((action) => action.id);
}

/**
 * Call `listener` when an action gains or loses its handler, so an answer from
 * {@link isShortcutActionAvailable} may have changed. A handler replaced by a newer one is no change.
 */
export function subscribeShortcutAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}

/**
 * The focused pane's keyboard as the shortcuts see it: the same write a Keys-tray tap makes, and
 * whether the composer is typing straight into the pane (Type mode), where only the prefix is ours.
 */
export interface PaneKeySink {
  send(keys: string[]): Promise<boolean>;
  isDirectTyping(): boolean;
}

let sink: PaneKeySink | null = null;

export function registerPaneKeySink(next: PaneKeySink): () => void {
  sink = next;
  return () => {
    if (sink === next) sink = null;
  };
}

/** The focused pane's keyboard, or null when no composer is mounted (the dashboard, zen mode). */
export function paneKeySink(): PaneKeySink | null {
  return sink;
}

/** Test seam: nothing registered. */
export function __resetShortcutRegistry(): void {
  const wasAnswered = handlers.size > 0;
  handlers.clear();
  sink = null;
  if (wasAnswered) notifyAvailability();
}
