import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

import type { ActionId } from "@/lib/shortcuts/actions";
import {
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
