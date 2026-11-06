import { useSyncExternalStore } from "react";

import type { TelemetryView } from "@/lib/types";

// THE TELEMETRY NOTICE (M86 spec 02): whether this device still needs to be told that Collie
// sends anonymous telemetry once a day, and where to turn that off.
//
// ── WHEN IT STANDS ────────────────────────────────────────────────────────────
// Only while the machine's count is on by the DEFAULT, which is the one state where nobody chose
// anything. A count that is off (by Settings, an environment variable, the config file, DO_NOT_TRACK,
// CI, a mirror or a development build) needs no word, and a count somebody switched on themselves
// was a choice. {@link shouldShowTelemetryNotice} is that rule, pure.
//
// ── SPENT ON THE OPERATOR'S OWN ACT, NEVER ON A READ ──────────────────────────
// Two acts spend it: the notice's X, and the button that opens the Settings card. A render, a poll or
// a reload writes nothing, so a person who has not yet read it meets it again. The Settings card is
// the permanent second surface (DESIGN.md §11, hard rule 2), which is why a dismissal can be final.
//
// Its own key, per device, kept across an unpair (it records that a notice was read, not what any
// session said; lib/storage-keys.test.ts holds the decision). The spelling is the spec's.

const STORAGE_KEY = "collie.telemetryNotice.v1";
/** The stored value of a spent notice. Anything else, or nothing, reads as "still to show". */
const SPENT = "1";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

function load(): boolean {
  try {
    return storage()?.getItem(STORAGE_KEY) === SPENT;
  } catch {
    return false;
  }
}

let spent = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether this device has spent the notice, as it stands. */
export function telemetryNoticeSpent(): boolean {
  return spent;
}

/** Reactive read for the dashboard. */
export function useTelemetryNoticeSpent(): boolean {
  return useSyncExternalStore(subscribe, telemetryNoticeSpent, telemetryNoticeSpent);
}

/** The X, or the button that opened the card: the notice is spent on this device for good. */
export function spendTelemetryNotice(): void {
  if (spent) return;
  spent = true;
  try {
    storage()?.setItem(STORAGE_KEY, SPENT);
  } catch {
    // Quota or private mode. The in-memory flag still holds for this page.
  }
  emit();
}

/**
 * Whether the dashboard draws the notice: not spent, and the machine's count is on by default. A
 * read that has not arrived (`null`) draws nothing, so the notice never guesses.
 */
export function shouldShowTelemetryNotice(a: { readonly isSpent: boolean; readonly view: TelemetryView | null }): boolean {
  if (a.isSpent) return false;
  if (a.view === null) return false;
  return a.view.on && a.view.decidedBy === "default";
}

/** Test seam: forget the flag, in memory and in storage. */
export function __resetTelemetryNotice(): void {
  spent = false;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

/** Test seam: read the flag again from storage, as a fresh page load would. */
export function __reloadTelemetryNotice(): void {
  spent = load();
  emit();
}
