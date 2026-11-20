import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { ACTIONS, type ActionId } from "@/lib/shortcuts/actions";
import {
  availableShortcutActions,
  isShortcutActionAvailable,
  registerPaneKeySink,
  registerShortcutHandler,
  subscribeShortcutAvailability,
  type PaneKeySink,
  type ShortcutHandler,
} from "@/lib/shortcuts/registry";

/**
 * Answer a desktop shortcut while the calling component is mounted (M108 spec 03). `undefined` means
 * "no target here right now": nothing is registered and the key does nothing, which is what an action
 * with no visible control on this screen must do. The handler may change on every render; the
 * registration does not, so a render never drops or re-orders an answer.
 */
export function useShortcutHandler(id: ActionId, handler: ShortcutHandler | undefined): void {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  const isOffered = handler !== undefined;
  useEffect(() => {
    if (!isOffered) return undefined;
    return registerShortcutHandler(id, (index) => latest.current?.(index));
  }, [id, isOffered]);
}

/**
 * Whether the action does something on this screen now (lib/shortcuts/registry.ts,
 * `isShortcutActionAvailable`). It follows the handlers as they mount and unmount.
 */
export function useShortcutActionAvailable(id: ActionId): boolean {
  return useSyncExternalStore(
    subscribeShortcutAvailability,
    () => isShortcutActionAvailable(id),
    () => false,
  );
}

/**
 * The actions that do something on this screen now, as a set the mode bar and the shortcut list read.
 * It follows the handlers as they mount and unmount. The store's snapshot is one string, so a render
 * that finds the same answer keeps the same set.
 */
export function useAvailableShortcutActions(): ReadonlySet<ActionId> {
  const key = useSyncExternalStore(
    subscribeShortcutAvailability,
    () => availableShortcutActions().join(","),
    () => "",
  );
  return useMemo(() => new Set(key === "" ? [] : key.split(",").map(toActionId)), [key]);
}

/** A name from the snapshot string back to an id, checked against the table. */
function toActionId(name: string): ActionId {
  const known = ACTIONS.find((action) => action.id === name);
  if (known === undefined) throw new Error(`No shortcut action ${name}`);
  return known.id;
}

/**
 * Hand the focused pane's keyboard to the shortcuts while the composer is mounted: the literal prefix
 * (`ctrl+b` twice) goes through `send`, the same write a Keys-tray tap makes, and `isDirectTyping`
 * tells the keymap to keep every key but the prefix.
 */
export function usePaneKeySink(sink: PaneKeySink): void {
  const latest = useRef(sink);
  useLayoutEffect(() => {
    latest.current = sink;
  });
  useEffect(
    () =>
      registerPaneKeySink({
        send: (keys) => latest.current.send(keys),
        isDirectTyping: () => latest.current.isDirectTyping(),
      }),
    [],
  );
}
