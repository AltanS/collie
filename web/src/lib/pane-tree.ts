import { useSyncExternalStore } from "react";

import { hostKey, paneRowKey } from "./hosts";
import { asJsonString, parseJson } from "./json";
import { shownStatus } from "./triage";
import type { AgentStatus, AgentView } from "./types";

export type TreeGuide = "│" | "├" | "└" | " ";

export interface PaneTreeRow {
  readonly pane: AgentView;
  readonly guides: readonly TreeGuide[];
  readonly childCount: number;
  readonly childStatus: AgentStatus | undefined;
  readonly folded: boolean;
}

const STORAGE_KEY = "collie:folded-parents:v1";
const MAX_FOLDED = 64;
const EMPTY_GUIDES: readonly TreeGuide[] = [];
const EMPTY_FOLDED: ReadonlySet<string> = new Set();

const CHILD_STATUS_RANK = {
  blocked: 4,
  done: 3,
  working: 2,
  idle: 1,
  unknown: 0,
} satisfies Record<AgentStatus, number>;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function loadFolded(): ReadonlySet<string> {
  const raw = storage()?.getItem(STORAGE_KEY) ?? null;
  if (raw === null) return EMPTY_FOLDED;
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return EMPTY_FOLDED;
  const keys: string[] = [];
  for (const item of parsed) {
    const key = asJsonString(item);
    if (key !== undefined && key !== "") keys.push(key);
  }
  return keys.length === 0 ? EMPTY_FOLDED : new Set(keys.slice(-MAX_FOLDED));
}

function saveFolded(next: ReadonlySet<string>): void {
  try {
    const store = storage();
    if (store === null) return;
    if (next.size === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify([...next].slice(-MAX_FOLDED)));
  } catch {
    // Ignore quota or private-mode errors; the in-memory set still holds for this session.
  }
}

let foldedSet: ReadonlySet<string> = loadFolded();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function foldedParents(): ReadonlySet<string> {
  return foldedSet;
}

export function toggleFoldedParent(key: string): void {
  const next = new Set(foldedSet);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  foldedSet = next.size === 0 ? EMPTY_FOLDED : next;
  saveFolded(foldedSet);
  for (const fn of listeners) fn();
}

export function useFoldedParents(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, foldedParents, () => EMPTY_FOLDED);
}

export function __resetFoldedParents(): void {
  foldedSet = EMPTY_FOLDED;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}

/** Row key of `pane`'s declared parent on the same machine and session, or `null` when absent. */
export function parentRowKeyOf(pane: AgentView): string | null {
  const parentId = pane.parentPaneId;
  if (parentId === undefined || parentId === "") return null;
  return `${hostKey(pane)}\u0000${pane.session ?? ""}\u0000${parentId}`;
}

function validParentKey(
  key: string,
  byKey: ReadonlyMap<string, AgentView>,
): string | null {
  const pane = byKey.get(key);
  if (pane === undefined) return null;
  const direct = parentRowKeyOf(pane);
  if (direct === null || direct === key || !byKey.has(direct)) return null;
  const seen = new Set<string>([key]);
  let cur: string | null = direct;
  while (cur !== null) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const node = byKey.get(cur);
    if (node === undefined) break;
    const next = parentRowKeyOf(node);
    cur = next !== null && byKey.has(next) ? next : null;
  }
  return direct;
}

function rootAncestorKey(
  key: string,
  parentByKey: ReadonlyMap<string, string>,
): string {
  let cur = key;
  for (let up = parentByKey.get(cur); up !== undefined; up = parentByKey.get(cur)) {
    cur = up;
  }
  return cur;
}

interface SubtreeSummary {
  readonly count: number;
  readonly status: AgentStatus | undefined;
}

/**
 * Arrange `ordered` panes so live children sit depth-first under their parent, mirroring
 * `nestWorktrees` (`lib/spaces.ts`): a child that precedes its root in an activity list pulls the
 * whole family forward, and an orphan whose parent is absent from `ordered` stays flat.
 */
export function nestPanes(
  ordered: readonly AgentView[],
  folded: ReadonlySet<string> = EMPTY_FOLDED,
): PaneTreeRow[] {
  if (ordered.length === 0) return [];
  const byKey = new Map<string, AgentView>();
  for (const pane of ordered) byKey.set(paneRowKey(pane), pane);

  const parentByKey = new Map<string, string>();
  const childrenByKey = new Map<string, string[]>();
  for (const pane of ordered) {
    const key = paneRowKey(pane);
    const parentKey = validParentKey(key, byKey);
    if (parentKey === null) continue;
    parentByKey.set(key, parentKey);
    const siblings = childrenByKey.get(parentKey);
    if (siblings === undefined) childrenByKey.set(parentKey, [key]);
    else siblings.push(key);
  }

  if (childrenByKey.size === 0) {
    return ordered.map((pane) => ({
      pane,
      guides: EMPTY_GUIDES,
      childCount: 0,
      childStatus: undefined,
      folded: false,
    }));
  }

  const summaries = new Map<string, SubtreeSummary>();
  const summarise = (key: string): SubtreeSummary => {
    const cached = summaries.get(key);
    if (cached !== undefined) return cached;
    const kids = childrenByKey.get(key) ?? [];
    let count = 0;
    let best: AgentStatus | undefined;
    for (const kidKey of kids) {
      const kid = byKey.get(kidKey);
      if (kid === undefined) continue;
      count += 1;
      const own = shownStatus(kid);
      if (best === undefined || CHILD_STATUS_RANK[own] > CHILD_STATUS_RANK[best]) best = own;
      const sub = summarise(kidKey);
      count += sub.count;
      if (sub.status !== undefined && (best === undefined || CHILD_STATUS_RANK[sub.status] > CHILD_STATUS_RANK[best])) {
        best = sub.status;
      }
    }
    const result: SubtreeSummary = { count, status: best };
    summaries.set(key, result);
    return result;
  };

  const rows: PaneTreeRow[] = [];
  const placed = new Set<string>();

  const markSubtreePlaced = (key: string): void => {
    placed.add(key);
    for (const kidKey of childrenByKey.get(key) ?? []) {
      if (!placed.has(kidKey)) markSubtreePlaced(kidKey);
    }
  };

  const emitTree = (key: string, guides: readonly TreeGuide[]): void => {
    if (placed.has(key)) return;
    const pane = byKey.get(key);
    if (pane === undefined) return;
    placed.add(key);
    const kids = childrenByKey.get(key) ?? [];
    const { count, status } = summarise(key);
    const isFolded = count > 0 && folded.has(key);
    rows.push({
      pane,
      guides,
      childCount: count,
      childStatus: status,
      folded: isFolded,
    });
    if (isFolded) {
      markSubtreePlaced(key);
      return;
    }
    kids.forEach((kidKey, index) => {
      const last = index === kids.length - 1;
      const prefix: TreeGuide[] = guides.map((g) => (g === "├" ? "│" : g === "└" ? " " : g));
      emitTree(kidKey, [...prefix, last ? "└" : "├"]);
    });
  };

  for (const pane of ordered) {
    const key = paneRowKey(pane);
    if (placed.has(key)) continue;
    const rootKey = rootAncestorKey(key, parentByKey);
    emitTree(rootKey, EMPTY_GUIDES);
  }

  return rows;
}
