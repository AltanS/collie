import { useSyncExternalStore } from "react";

// THE MASKED-TEXT HINT: whether this device still needs to be told what the dots on a pane are.
//
// The bridge masks known secret shapes before text leaves the machine (bridge/redact.ts), and an
// operator who meets `sk-o••••••••` for the first time reads it as a rendering bug. The pane says
// once, in one quiet line (`components/masked-hint.tsx`), that the dots are on purpose and where to
// read the real value. This module holds the one fact that line needs: has this device retired it.
//
// ── RETIRED ON THE OPERATOR'S OWN ACT, NEVER ON A READ ───────────────────────
// Only the line's own X writes. A render, a poll or a pane switch writes nothing, so a device that
// has never met a mask never stores anything. Once retired it stays gone on this device for good: a
// notice that came back each time a key scrolled past would be a nag about a thing already understood.
//
// Its own key and the same shape as `pin-hint.ts`, per device, kept across an unpair (it records
// that a hint was read, not what any session said; lib/storage-keys.test.ts holds the decision).

const STORAGE_KEY = "collie:masked-hint:v1";
/** The stored value of a retired hint. Anything else, or nothing, reads as "still to show". */
const RETIRED = "1";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

function load(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === RETIRED;
  } catch {
    return false;
  }
}

let retired = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether this device has retired the line, as it stands. */
export function maskedHintRetired(): boolean {
  return retired;
}

/** Reactive read for the pane. */
export function useMaskedHintRetired(): boolean {
  return useSyncExternalStore(subscribe, maskedHintRetired, maskedHintRetired);
}

/** The operator dismissed the line: retire it on this device for good. Writes once. */
export function retireMaskedHint(): void {
  if (retired) return;
  retired = true;
  try {
    storage()?.setItem(STORAGE_KEY, RETIRED);
  } catch {
    // Quota or private mode. The in-memory flag still holds for this session.
  }
  for (const fn of listeners) fn();
}

/** Test seam: forget the flag, in memory and in storage. */
export function __resetMaskedHint(): void {
  retired = false;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}

/** Test seam: read the flag again from storage, as a fresh page load would. */
export function __reloadMaskedHint(): void {
  retired = load();
  for (const fn of listeners) fn();
}
