import { useSyncExternalStore } from "react";

import { asJsonString, parseJson } from "@/lib/json";

// "NOT NOW" ON A TRICK PROPOSAL IN ITS SESSION (package I, 2026-11-17). The card a proposal draws in the
// chat view of the session that proposed it (components/session-trick-card.tsx) closes on "Not now" and
// sends nothing: the proposal stays open, and Settings, Tricks keeps it under "Waiting for your yes",
// where the same card still offers its own "Not now" that declines it. So the session's "Not now" is a
// note on this device only: the decision ids closed here, kept in localStorage, at most LATER_MAX, newest
// last. A newer proposal of the same trick is a new decision id, so its card shows again.

const KEY = "collie:session-later";
/** The most decision ids kept: old ones fall off the front; their cards are long closed anyway. */
export const LATER_MAX = 50;

const listeners = new Set<() => void>();
let held: readonly string[] | null = null;

function read(): readonly string[] {
  if (held !== null) return held;
  let text: string | null = null;
  try {
    text = localStorage.getItem(KEY);
  } catch {
    // Blocked storage: no note survives a reload.
  }
  const raw = text === null ? undefined : parseJson(text);
  held = Array.isArray(raw) ? raw.flatMap((id) => asJsonString(id) ?? []).slice(-LATER_MAX) : [];
  return held;
}

/** Close the card of `decisionId` in its session on this device. Settings, Tricks still lists it. */
export function closeInSession(decisionId: string): void {
  const now = read();
  if (now.includes(decisionId)) return;
  held = [...now, decisionId].slice(-LATER_MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(held));
  } catch {
    // A full or blocked storage keeps the note for this page only.
  }
  for (const listener of listeners) listener();
}

/** For a test: forget every note, in memory and in storage. */
export function forgetSessionLater(): void {
  held = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const NONE: readonly string[] = [];

/** The decision ids closed in their session on this device. */
export function useSessionLater(): readonly string[] {
  return useSyncExternalStore(subscribe, read, () => NONE);
}
