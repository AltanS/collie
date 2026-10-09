import { useSyncExternalStore } from "react";

import { DEFAULT_BOARD, parseBoard, serializeBoard, sameBoard, type KeyBoard } from "@/lib/key-board";

// The stored key board (M48 spec 03, ADR 0092). One localStorage key, one module-scope value, a
// listener set and a useSyncExternalStore hook, the shape of lib/design.ts and lib/zen.ts: the dock
// and the editor sheet read the same value without a provider, and an edit shows in the dock at once.
//
// THE VALUE IS VERSIONED AND NEVER TRUSTED. The stored text is `serializeBoard` (it carries `v: 2`);
// reading it goes through the same validator an imported code does. A value that is missing, cut
// off, hand-edited, written by a newer build with another schema number, or merely wrong in one chord
// is the DEFAULT board, never an exception and never half a board. The default is not stored: a
// browser that never edits keeps no key, so it follows the app if the Default ever changes.
//
// The key is a PREFERENCE, kept at unpair (lib/storage-keys.test.ts): it names chords, not content.

export const KEY_BOARD_STORAGE_KEY = "collie:key-board:v1";

function load(): KeyBoard {
  try {
    const raw = localStorage.getItem(KEY_BOARD_STORAGE_KEY);
    if (raw === null) return DEFAULT_BOARD;
    const read = parseBoard(raw);
    return read.ok ? read.board : DEFAULT_BOARD;
  } catch {
    return DEFAULT_BOARD; // private mode / SSR
  }
}

let board: KeyBoard = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    // The default is the absence of a choice: no key, nothing to migrate if it changes later.
    if (sameBoard(board, DEFAULT_BOARD)) localStorage.removeItem(KEY_BOARD_STORAGE_KEY);
    else localStorage.setItem(KEY_BOARD_STORAGE_KEY, serializeBoard(board));
  } catch {
    // Quota or private mode: the in-memory board still applies for this session.
  }
}

export function getKeyBoard(): KeyBoard {
  return board;
}

/** Replace the board. Saves at once; every reader re-renders. */
export function setKeyBoard(next: KeyBoard): void {
  board = next;
  persist();
  for (const fn of listeners) fn();
}

/** Back to today's pad, and the stored key goes away. */
export function resetKeyBoard(): void {
  setKeyBoard(DEFAULT_BOARD);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The board, live. */
export function useKeyBoard(): KeyBoard {
  return useSyncExternalStore(subscribe, getKeyBoard, getKeyBoard);
}

/** Test seam: re-read storage, as a fresh page load would. */
export function __reloadKeyBoard(): void {
  board = load();
  for (const fn of listeners) fn();
}
