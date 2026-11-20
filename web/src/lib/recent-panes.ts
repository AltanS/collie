// THE PANES THIS DEVICE OPENED LAST, newest first, for the Actions palette's Recent rows (ADR 0165).
//
// WRITTEN WHEN A PANE IS SHOWN (routes/detail.tsx), like lib/tab-pane-memory.ts: a pane opened by a
// push, a link, a strip or a row counts the same way, and the list never disagrees with what was on
// screen. Never written on a poll or a render.
//
// KEYED BY THE ROW AND THE WORKSPACE NAME, the guard lib/pins.ts trusts: a pane id is unique only for
// one bridge process and is reused, so a record applies to the live pane with that row key only while
// that pane sits in a workspace of that name. A record whose pane is not in the list draws nothing.
//
// Per device, in localStorage, so a reload and a restart keep it. It holds pane addresses and a
// workspace name, the same as a slot (lib/slots.ts), so the wipe of a pairing clears it (lib/wipe.ts).
// Every storage access is behind a try/catch: a private-mode browser keeps the memory copy only.

import { useSyncExternalStore } from "react";

import { paneRowKey } from "./hosts";
import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "./json";
import { panePlaceParts } from "./pane-name";
import type { AgentView } from "./types";

const STORAGE_KEY = "collie:recent-panes:v1";

/** How many records are kept: more than the palette shows, so a closed pane leaves room for the next. */
export const MAX_RECENT = 12;

export interface RecentPane {
  /** The pane's `paneRowKey`: host, session and pane id. */
  row: string;
  /** The name of the workspace it sat in when it was shown. */
  space: string;
  at: number;
}

const NONE: readonly RecentPane[] = [];

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored list; a bad record is skipped, never repaired, and nothing is written back on a read. */
function decode(raw: string | null): readonly RecentPane[] {
  if (raw === null) return NONE;
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return NONE;
  const out: RecentPane[] = [];
  for (const item of doc) {
    const rec = asJsonObject(item);
    const row = asJsonString(rec?.row);
    const space = asJsonString(rec?.space);
    const at = asJsonNumber(rec?.at);
    if (row === undefined || space === undefined || at === undefined) continue;
    if (out.some((r) => r.row === row)) continue;
    out.push({ row, space, at });
  }
  return out;
}

function load(): readonly RecentPane[] {
  try {
    return decode(storage()?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return NONE;
  }
}

let recent: readonly RecentPane[] = load();
const listeners = new Set<() => void>();

function save(next: readonly RecentPane[]): void {
  recent = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private mode: the memory copy still holds for this page.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentRecentPanes(): readonly RecentPane[] {
  return recent;
}

export function useRecentPanes(): readonly RecentPane[] {
  return useSyncExternalStore(subscribe, currentRecentPanes, () => NONE);
}

/** The pane view showed this pane: it moves to the front. Showing the front pane again writes nothing. */
export function rememberRecentPane(pane: AgentView, now: number = Date.now()): void {
  const row = paneRowKey(pane);
  const space = panePlaceParts(pane).space;
  const front = recent[0];
  if (front !== undefined && front.row === row && front.space === space) return;
  save([{ row, space, at: now }, ...recent.filter((r) => r.row !== row)].slice(0, MAX_RECENT));
}

/**
 * The live panes of the list, newest first: at most `limit`, the pane open now (`hereKey`) left out, and
 * a record whose row now sits in another workspace skipped (its id was reused).
 */
export function recentLivePanes(input: {
  recent: readonly RecentPane[];
  panes: readonly AgentView[];
  hereKey: string | null;
  limit: number;
}): AgentView[] {
  const byRow = new Map(input.panes.map((pane) => [paneRowKey(pane), pane]));
  const out: AgentView[] = [];
  for (const record of input.recent) {
    if (out.length >= input.limit) break;
    if (record.row === input.hereKey) continue;
    const pane = byRow.get(record.row);
    if (pane === undefined || panePlaceParts(pane).space !== record.space) continue;
    out.push(pane);
  }
  return out;
}

/** The wipe's cleaner (lib/wipe.ts): the list is pane addresses of the ended pairing. */
export function forgetRecentPanes(): void {
  recent = NONE;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear in a storage that cannot be reached.
  }
  for (const fn of listeners) fn();
}

/** Test seam: the stored list read again, as at page load. */
export function __reloadRecentPanes(): void {
  recent = load();
  for (const fn of listeners) fn();
}
