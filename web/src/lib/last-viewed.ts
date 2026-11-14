import { useEffect, useState } from "react";

import { paneRowKey } from "./hosts";
import { asJsonObject, asJsonString, parseJson } from "./json";
import { panePlaceParts } from "./pane-name";
import { isTrickPane } from "./tricks/places";
import type { AgentView } from "./types";

// The last few panes opened on this device, newest first, so the Switch pane sheet can offer a
// single one-tap "Last viewed" row at the top when the operator opts in via Settings -> Appearance
// (excluding the pane currently open when the sheet is pulled up from inside a pane).
//
// Keyed by `{ row: paneRowKey(pane), space: panePlaceParts(pane).space }` for the same reason
// `lib/pins.ts` (ADR 0070) and `lib/slots.ts` carry the workspace name: multiplexer pane ids are
// reused across workspaces and restarts, and an id now belonging to another workspace must not read
// as the pane the operator was just looking at.
//
// Read directly from `localStorage` on each access (like `lib/slots.ts` and `lib/pairing.ts`) so a
// wipe in another tab cannot be resurrected from a stale module cache, and a quota error on write
// never leaves an in-memory copy diverging from storage.

const STORAGE_KEY = "collie:last-viewed:v1";

/** Keep a short tail behind the top slot so excluding the open pane, a pinned pane, or a closed pane still finds the previous one. */
export const MAX_LAST_VIEWED = 4;

export interface LastViewed {
  readonly row: string;
  readonly space: string;
}

const NONE: readonly LastViewed[] = [];

function deviceStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined; // locked-down storage
  }
}

function decode(raw: string | null): readonly LastViewed[] {
  if (raw === null) return NONE;
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return NONE;
  const out: LastViewed[] = [];
  for (const item of doc) {
    const rec = asJsonObject(item);
    const row = asJsonString(rec?.row);
    const space = asJsonString(rec?.space);
    if (row === undefined || space === undefined || row === "") continue;
    if (out.some((entry) => entry.row === row)) continue;
    out.push({ row, space });
    if (out.length >= MAX_LAST_VIEWED) break;
  }
  return out;
}

/** The device's recent-viewed trail, newest first. */
export function currentLastViewed(): readonly LastViewed[] {
  try {
    return decode(deviceStorage()?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return NONE;
  }
}

function save(next: readonly LastViewed[]): void {
  try {
    deviceStorage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode: keep the previous persisted trail untouched.
  }
}

/** Record that the operator opened `(row, space)` on this device. */
export function recordLastViewed(row: string, space: string): void {
  if (row === "") return;
  const entries = currentLastViewed();
  if (entries[0]?.row === row && entries[0]?.space === space) return;
  const next: LastViewed[] = [{ row, space }];
  for (const prev of entries) {
    if (prev.row === row) continue;
    next.push(prev);
    if (next.length >= MAX_LAST_VIEWED) break;
  }
  save(next);
}

/**
 * The pane was closed from Collie, so its recent-viewed record goes with it (ADR 0070 §6): an id
 * later reused inside the same workspace must not read as the pane the operator just closed.
 */
export function dropLastViewed(pane: AgentView): void {
  const row = paneRowKey(pane);
  const entries = currentLastViewed();
  const next = entries.filter((entry) => entry.row !== row);
  if (next.length === entries.length) return;
  save(next);
}

/**
 * Pick the single most recently viewed live pane from `panes`, skipping `currentPaneKey` (when the
 * Switch pane sheet was opened from inside a pane), trick sessions, panes matched by `exclude` (such
 * as pinned panes, which already lead in `Pinned`), and any record whose id was reused in another
 * workspace (ADR 0070).
 */
export function resolveLastViewed(
  records: readonly LastViewed[],
  panes: readonly AgentView[],
  currentPaneKey: string,
  exclude?: (pane: AgentView) => boolean,
): AgentView | undefined {
  if (records.length === 0 || panes.length === 0) return undefined;
  const byRow = new Map<string, AgentView>();
  for (const pane of panes) {
    if (!isTrickPane(pane)) byRow.set(paneRowKey(pane), pane);
  }
  for (const rec of records) {
    if (rec.row === currentPaneKey) continue;
    const live = byRow.get(rec.row);
    if (live === undefined || panePlaceParts(live).space !== rec.space) continue;
    if (exclude?.(live) === true) continue;
    return live;
  }
  return undefined;
}

/** Remember each live pane route visited on this device while enabled (`routes/root.tsx`). */
export function useLastViewedMemory(pane: AgentView | undefined, enabled = true): void {
  const realPane = enabled && pane !== undefined && !isTrickPane(pane) ? pane : undefined;
  const row = realPane === undefined ? "" : paneRowKey(realPane);
  const space = realPane === undefined ? "" : panePlaceParts(realPane).space;
  useEffect(() => {
    if (row !== "") recordLastViewed(row, space);
  }, [row, space]);
}

interface FrozenShortcut {
  readonly enabled: boolean;
  readonly settled: boolean;
  readonly target: LastViewed | null;
}

function freezeShortcut(
  enabled: boolean,
  panes: readonly AgentView[],
  currentPaneKey: string,
  exclude: ((pane: AgentView) => boolean) | undefined,
): FrozenShortcut {
  if (!enabled) return { enabled: false, settled: false, target: null };
  if (panes.length === 0) return { enabled: true, settled: false, target: null };
  const hit = resolveLastViewed(currentLastViewed(), panes, currentPaneKey, exclude);
  return {
    enabled: true,
    settled: true,
    target: hit === undefined ? null : { row: paneRowKey(hit), space: panePlaceParts(hit).space },
  };
}

/**
 * Lock onto at most ONE target `{ row, space }` when the Switch pane sheet opens (or when a cold
 * boot's empty herd first fills, like `hooks/use-frozen-ranks.ts`, ADR 0063 & ADR 0071 §4).
 *
 * Locking the single resolved target rather than the trail array guarantees that if that pane closes
 * on a background poll while the sheet is open, `Last viewed` simply disappears instead of pulling a
 * runner-up row out of its workspace under a moving thumb, and a pane arriving on a later poll never
 * claims the top slot.
 */
export function useLastViewedShortcut(
  enabled: boolean,
  panes: readonly AgentView[],
  currentPaneKey: string,
  exclude?: (pane: AgentView) => boolean,
): AgentView | undefined {
  const [frozen, setFrozen] = useState<FrozenShortcut>(() =>
    freezeShortcut(enabled, panes, currentPaneKey, exclude),
  );
  if (frozen.enabled !== enabled || (enabled && !frozen.settled && panes.length > 0)) {
    setFrozen(freezeShortcut(enabled, panes, currentPaneKey, exclude));
  }
  if (!enabled || frozen.target === null) return undefined;
  return resolveLastViewed([frozen.target], panes, currentPaneKey, exclude);
}

/** Forget every remembered pane on unpair/revoke/expiry or when turning the setting off. */
export function forgetLastViewed(): void {
  try {
    deviceStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Locked-down storage: nothing persisted to remove.
  }
}
