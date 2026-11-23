import { useSyncExternalStore } from "react";

// WHICH CHAT BLOCK THE BLOCK ACTIONS SHEET IS ABOUT, AND WHERE A BLOCK IS ON THE PAGE (M90 polish, 2026-11-06; the
// select mode left 2026-11-23, when Select text became a sheet, components/block-text-sheet.tsx).
//
// WHICH BLOCK THE SHEET IS ABOUT. While the sheet is open for a block, that block carries `data-active` and draws the
// hold's tint (index.css), so the person sees which message the sheet is about. The sheet sets it before paint, so the
// tint of the hold that opened it flows into this one with no frame between. It names at most one block by its item id,
// and it is a module store, the way the shown `⋯` is one, because the sheet and the block are far apart in the tree.
//
// WHERE A BLOCK IS. A block registers its element under its item id, so a copy that was started from the sheet can flash
// the block it copied (lib/copied-flash.ts) after the sheet is gone.

let current: string | null = null;
const listeners = new Set<() => void>();
const elements = new Map<string, HTMLElement>();

function set(next: string | null): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Mark the block that draws item `itemId` as the one the open sheet is about. */
export const activateBlock = (itemId: string): void => set(itemId);

/** The sheet closed: no block is its subject; with `itemId`, only when that block is. */
export function deactivateBlock(itemId?: string): void {
  if (itemId !== undefined && current !== itemId) return;
  set(null);
}

/** Whether the open sheet is about the block that draws item `itemId`. `null` (no item) never is. */
export const useActiveBlock = (itemId: string | null): boolean =>
  useSyncExternalStore(subscribe, () => itemId !== null && current === itemId);

/** A block that draws item `itemId` is on the page at `element`; the returned function takes it back off. */
export function registerBlock(itemId: string, element: HTMLElement): () => void {
  elements.set(itemId, element);
  return () => {
    if (elements.get(itemId) === element) elements.delete(itemId);
  };
}

/** The element of the block that draws item `itemId`, or `null` when none is on the page. */
export const blockElement = (itemId: string): HTMLElement | null => elements.get(itemId) ?? null;
