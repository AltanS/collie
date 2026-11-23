import { useSyncExternalStore } from "react";

// WHAT A SEND TOLD THE PHONE ABOUT ONE ASK (Asks build 2, 2026-11-23): an ask the bridge found closed when the Send
// reached it (`gone`), or an ask a refused Send named (`bad_answer`, `not_an_ask`). The words belong on that ask's own
// screen, so they wait here by ask id, in memory, until the person leaves the page or the ask is Sent again. Nothing
// here is stored on disk: a note is a fact about the last tap, and a reload has the list's own state to say the rest.

const notes = new Map<string, string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, string> = new Map();

function publish(): void {
  snapshot = new Map(notes);
  for (const listener of listeners) listener();
}

/** Remember what a Send said about one ask. */
export function noteAskSend(id: string, words: string): void {
  notes.set(id, words);
  publish();
}

/** Forget what was said about these asks: they are being sent again, or they are answered. */
export function clearAskNotes(ids: readonly string[]): void {
  let changed = false;
  for (const id of ids) changed = notes.delete(id) || changed;
  if (changed) publish();
}

/** For a test: forget everything. */
export function __resetAskNotes(): void {
  notes.clear();
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The words a Send left on one ask, or null. */
export function useAskNote(id: string): string | null {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return all.get(id) ?? null;
}
