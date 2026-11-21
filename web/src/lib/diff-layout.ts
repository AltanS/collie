import { useSyncExternalStore } from "react";

// How a diff stands on a large screen (ADR 0173): one column (`unified`, the phone's) or the old
// lines beside the new (`split`). Until a person chooses, the width decides: side by side once the file's column is
// {@link SPLIT_MIN_COLUMN_PX} wide or wider, one column below it. A choice is this DEVICE's, like the large-screen
// layout's own (lib/wide-layout-store.ts): never written to a bridge, kept until the person chooses again. The phone and
// a tablet never read it: their diff is always one column.

const STORAGE_KEY = "collie:diff-layout:v1";

export type DiffLayout = "unified" | "split";

/** The narrowest column of the file, in CSS px, that opens a diff side by side when no choice is kept. At 1440 the
 *  column is about 1080px, where two halves wrapped two lines in six (2026-11-21); at 1920 it is about 1560px. */
export const SPLIT_MIN_COLUMN_PX = 1200;

let chosen: DiffLayout | null = load();
const listeners = new Set<() => void>();

function load(): DiffLayout | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
    return raw === "unified" || raw === "split" ? raw : null;
  } catch {
    return null; // private mode
  }
}

/** The kept choice, or null while the person has not chosen. */
export function diffLayoutChoice(): DiffLayout | null {
  return chosen;
}

/** Keep `layout` as this device's choice. */
export function setDiffLayout(layout: DiffLayout): void {
  chosen = layout;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, layout);
  } catch {
    // Quota or private mode: the choice still holds for this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The kept choice, live across components and tabs of this page. */
export function useDiffLayoutChoice(): DiffLayout | null {
  return useSyncExternalStore(subscribe, diffLayoutChoice, () => null);
}

/** The layout a diff takes: the kept choice, else side by side from {@link SPLIT_MIN_COLUMN_PX} of column width. */
export function diffLayoutFor(choice: DiffLayout | null, columnWidth: number): DiffLayout {
  if (choice !== null) return choice;
  return columnWidth >= SPLIT_MIN_COLUMN_PX ? "split" : "unified";
}

/** For tests: forget the choice in memory (the test clears localStorage itself). */
export function __resetDiffLayout(): void {
  chosen = load();
  for (const listener of listeners) listener();
}
