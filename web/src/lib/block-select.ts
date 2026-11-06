import { useSyncExternalStore } from "react";

// WHICH CHAT BLOCK TAKES A TEXT SELECTION ON A TOUCH SCREEN (M90 polish, 2026-11-06).
//
// On a touch screen a pinnable block takes no selection at rest (index.css, `[data-pinnable]` under
// `pointer: coarse`), so a hold on it opens the block actions sheet every time. The sheet's Select text row hands the
// selection back to ONE block, named here by its item id: the block marks itself `data-selectable`, its own hold and
// tap stand down, and the native selection owns the press. The mode ends on a press outside that block, when the
// sheet opens again, or when the block leaves the stream (components/stream-block.tsx). A module store, the way the
// shown `⋯` is one, because the sheet and the block are far apart in the tree and only one block is ever selectable.

let selectable: string | null = null;
const listeners = new Set<() => void>();

function set(next: string | null) {
  if (selectable === next) return;
  selectable = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Let the block that draws item `itemId` take a text selection, and no other block. */
export function selectTextIn(itemId: string): void {
  set(itemId);
}

/** End the select mode, whichever block holds it; with `itemId`, only when that block holds it. */
export function endSelectText(itemId?: string): void {
  if (itemId !== undefined && selectable !== itemId) return;
  set(null);
}

/** Whether the block that draws item `itemId` takes a text selection now. `null` (no item) never does. */
export function useSelectable(itemId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => itemId !== null && selectable === itemId);
}
