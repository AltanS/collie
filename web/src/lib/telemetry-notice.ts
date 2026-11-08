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
// Two acts spend it: the notice's X, and its button (the Settings card for the first notice, the
// docs page for the update notice). A render, a poll or a reload writes nothing, so a person who has
// not yet read it meets it again. The Settings card is the permanent second surface (DESIGN.md §11,
// hard rule 2), which is why a dismissal can be final.
//
// ── THE STORED VALUE IS A REVISION (ADR 0134) ─────────────────────────────────
// "1" means the 1.27.0 notice was read, "2" means the update notice was read too. Nothing stored
// shows the 1.27.0 notice, and spending it writes "2": the docs it leads to already describe the
// later field. "1" shows the update notice once, "2" shows nothing. The key keeps its name.
//
// Its own key, per device, kept across an unpair (it records that a notice was read, not what any
// session said; lib/storage-keys.test.ts holds the decision). The spelling is the spec's.

const STORAGE_KEY = "collie.telemetryNotice.v1";
/** The revision a device that has read everything holds. */
const CURRENT = 2;
/** Which notice a device is owed, from what it has read. */
export type TelemetryNoticeKind = "first" | "update" | "none";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

function load(): number {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return 0;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? Math.min(n, CURRENT) : 0;
  } catch {
    return 0;
  }
}

/** The revision this device has read: 0 nothing, 1 the 1.27.0 notice, 2 the update notice too. */
let revision = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function kindOf(rev: number): TelemetryNoticeKind {
  if (rev <= 0) return "first";
  if (rev < CURRENT) return "update";
  return "none";
}

/** Which notice this device is owed, as it stands. */
export function telemetryNoticeKind(): TelemetryNoticeKind {
  return kindOf(revision);
}

/** Reactive read for the dashboard. */
export function useTelemetryNoticeKind(): TelemetryNoticeKind {
  return useSyncExternalStore(subscribe, telemetryNoticeKind, telemetryNoticeKind);
}

/** The X, or the button of either notice: everything is read on this device for good (revision 2). */
export function spendTelemetryNotice(): void {
  if (revision >= CURRENT) return;
  revision = CURRENT;
  try {
    storage()?.setItem(STORAGE_KEY, String(CURRENT));
  } catch {
    // Quota or private mode. The in-memory revision still holds for this page.
  }
  emit();
}

/**
 * Whether the dashboard draws a notice: one is owed, and the machine's count is on by default. A
 * read that has not arrived (`null`) draws nothing, so the notice never guesses.
 */
export function shouldShowTelemetryNotice(a: { readonly kind: TelemetryNoticeKind; readonly view: TelemetryView | null }): boolean {
  if (a.kind === "none") return false;
  if (a.view === null) return false;
  return a.view.on && a.view.decidedBy === "default";
}

/** Test seam: forget the revision, in memory and in storage. */
export function __resetTelemetryNotice(): void {
  revision = 0;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  emit();
}

/** Test seam: read the revision again from storage, as a fresh page load would. */
export function __reloadTelemetryNotice(): void {
  revision = load();
  emit();
}
