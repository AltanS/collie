import { useSyncExternalStore } from "react";

import { asJsonNumber, asJsonObject, asJsonString, parseJson } from "./json";

// WHICH BRANCHES OF THE TREE ORDER THIS DEVICE HAS FOLDED (lib/pane-tree.ts `foldTree`).
//
// A branch is named by its starter's node id, the opaque word an orchestrator put on the pane, so a fold
// survives a reload and a pane id that moved. Only folded branches are stored: a branch nobody folded, and
// every new one, is open. Per device, like the pins: a phone and a desktop fold what their own screen needs.
// A preference with no session content in it (lib/storage-keys.test.ts), and nothing here reaches the bridge.
//
// It writes on the operator's own taps only, never on a render or a poll. A fold whose branch is gone is
// kept, dormant, because the branch may come back with its id; `MAX_FOLDS` bounds the list, oldest first.

const STORAGE_KEY = "collie:tree-fold:v1";

/** The store's bound: far more branches than a person folds at once. */
export const MAX_FOLDS = 128;

interface Fold {
  /** The folded branch's starter node id. */
  id: string;
  /** When it was folded. Only the bound's eviction reads it. */
  at: number;
}

const NONE: ReadonlySet<string> = new Set();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked / partitioned storage
  }
}

/** The stored folds, skipping any record it cannot read; nothing is written back on a read. */
function decode(raw: string | null): Fold[] {
  if (raw === null) return [];
  const doc = parseJson(raw);
  if (!Array.isArray(doc)) return [];
  const out: Fold[] = [];
  for (const item of doc) {
    const rec = asJsonObject(item);
    const id = asJsonString(rec?.id);
    const at = asJsonNumber(rec?.at);
    if (id === undefined || at === undefined || out.some((f) => f.id === id)) continue;
    out.push({ id, at });
  }
  return out;
}

function load(): Fold[] {
  try {
    return decode(storage()?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return [];
  }
}

let folds: Fold[] = load();
let folded: ReadonlySet<string> = new Set(folds.map((f) => f.id));
const listeners = new Set<() => void>();

function save(next: Fold[]): void {
  folds = next.toSorted((a, b) => b.at - a.at).slice(0, MAX_FOLDS);
  folded = new Set(folds.map((f) => f.id));
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(folds));
  } catch {
    // Quota or private mode. The in-memory folds still apply for this session.
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The folded branch ids as they stand. The same set until the next write. */
export function currentFolds(): ReadonlySet<string> {
  return folded;
}

/** Reactive read for every list that draws the tree order. */
export function useTreeFolds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, currentFolds, () => NONE);
}

/** Fold the branch `id`. */
export function foldBranch(id: string, now = Date.now()): void {
  if (folded.has(id)) return;
  save([...folds, { id, at: now }]);
}

/**
 * Open the branches in `ids` at once: the one tapped and, when it hides a session that waits on the operator,
 * every folded branch on the way down to it (`unfoldPath`), so the tap lands where the wait is.
 */
export function unfoldBranches(ids: readonly string[]): void {
  if (!ids.some((id) => folded.has(id))) return;
  const drop = new Set(ids);
  save(folds.filter((f) => !drop.has(f.id)));
}

/** Test hook: forget every fold, in memory and in storage. */
export function __resetTreeFolds(): void {
  save([]);
}
