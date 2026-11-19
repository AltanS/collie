// The runtime half of the desktop shortcuts (M108 spec 03): who answers an action, and where the
// literal prefix goes. The keymap core (resolve.ts) decides WHICH action a key is; this file holds
// the handlers the app already has for it, so a handler that lives inside a component is reached
// without lifting that component's state.
//
// A component registers a handler for an action while it is mounted (`useShortcutHandler`). An
// action with no handler is a no-op: "close the column" on the dashboard has no column to close,
// and that is not an error. The newest registration of an id wins, and a registration only removes
// itself, so a remount that registers before the old mount cleans up loses nothing.
//
// No React and no DOM here, so the dispatch is testable on its own.

import { ACTIONS, type ActionId, type ModeId } from "./actions";

/** What an action does. `index` is the digit of an indexed action (`switch_tab`), else absent. */
export type ShortcutHandler = (index?: number) => void;

/**
 * A sticky mode's keys run the handler of the global action they mirror, so a column steps the same
 * way from `prefix+l` and from `l` inside the picker, and one registration serves both. Only the
 * mode rows with no global twin (the width steps) register on their own.
 */
const MIRRORS: ReadonlyMap<ActionId, ActionId> = new Map<ActionId, ActionId>([
  ["navigate_left", "focus_pane_left"],
  ["navigate_right", "focus_pane_right"],
  ["navigate_up", "focus_pane_up"],
  ["navigate_down", "focus_pane_down"],
  ["navigate_tab", "switch_tab"],
]);

const handlers = new Map<ActionId, ShortcutHandler>();

function ownerOf(id: ActionId): ActionId {
  return MIRRORS.get(id) ?? id;
}

/** Answer `id` until the returned function is called. The newest answer wins. */
export function registerShortcutHandler(id: ActionId, handler: ShortcutHandler): () => void {
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
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
  handlers.clear();
  sink = null;
}
