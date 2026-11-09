import { useSyncExternalStore } from "react";

// TWO FACTS ABOUT ONE CHAT BLOCK THAT THE BLOCK ACTIONS SHEET SETS AND THE BLOCK DRAWS (M90 polish, 2026-11-06). Each
// names at most one block by its item id, and each is a module store, the way the shown `⋯` is one, because the sheet
// and the block are far apart in the tree.
//
// WHICH BLOCK THE SHEET IS ABOUT. While the sheet is open for a block, that block carries `data-active` and draws the
// hold's tint (index.css), so the person sees which message the sheet is for. The sheet sets it before paint, so the
// tint of the hold that opened it flows into this one with no frame between.
//
// WHICH BLOCK TAKES A TEXT SELECTION ON A TOUCH SCREEN. On a touch screen a pinnable block takes no selection at rest
// (index.css, `[data-pinnable]` under `pointer: coarse`), so a hold on it opens the sheet every time. The sheet's
// Select text row hands the selection back to ONE block: it marks itself `data-selectable`, its own hold and tap stand
// down, and the native selection owns the press. The mode ends on a press outside that block, when the sheet opens
// again, or when the block leaves the stream (components/stream-block.tsx).

function idStore() {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  const set = (next: string | null) => {
    if (current === next) return;
    current = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return {
    set,
    /** Clear, whichever block holds it; with `itemId`, only when that block holds it. */
    end: (itemId?: string) => {
      if (itemId !== undefined && current !== itemId) return;
      set(null);
    },
    use: (itemId: string | null) => useSyncExternalStore(subscribe, () => itemId !== null && current === itemId),
  };
}

const selectable = idStore();
const active = idStore();

/** Let the block that draws item `itemId` take a text selection, and no other block. */
export const selectTextIn = (itemId: string): void => selectable.set(itemId);

/** End the select mode, whichever block holds it; with `itemId`, only when that block holds it. */
export const endSelectText = (itemId?: string): void => selectable.end(itemId);

/** Whether the block that draws item `itemId` takes a text selection now. `null` (no item) never does. */
export const useSelectable = (itemId: string | null): boolean => selectable.use(itemId);

/** Mark the block that draws item `itemId` as the one the open sheet is about. */
export const activateBlock = (itemId: string): void => active.set(itemId);

/** The sheet closed: no block is its subject; with `itemId`, only when that block is. */
export const deactivateBlock = (itemId?: string): void => active.end(itemId);

/** Whether the open sheet is about the block that draws item `itemId`. */
export const useActiveBlock = (itemId: string | null): boolean => active.use(itemId);
