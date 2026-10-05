// The Files view's filter (ADR 0083): a name substring over one folder's rows, and whether the rows
// git ignores are listed. Pure, so the route, the playground and the unit suite read one arithmetic.

import type { FileEntry } from "@/lib/types";

export interface FolderView {
  /** What the list draws. */
  rows: FileEntry[];
  /** The rows that exist before the name filter: every row, less the ignored ones while they are hidden. */
  pool: number;
  /** Ignored rows kept out of the list that the name filter would otherwise show. 0 while they are shown. */
  hiddenIgnored: number;
}

/** Whether a name filter is on. Blank, or spaces alone, matches everything and is off. */
export function isNameFilterOn(query: string): boolean {
  return query.trim() !== "";
}

/** Case-insensitive substring of the name. */
export function matchesName(entry: FileEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.name.toLowerCase().includes(q);
}

/**
 * One folder as the filter shows it. The order the bridge gave is kept. A listing from a member
 * that predates `ignored` has no flagged row, so nothing is ever hidden for it.
 */
export function folderView(entries: readonly FileEntry[], query: string, showIgnored: boolean): FolderView {
  const pooled = showIgnored ? entries : entries.filter((e) => e.ignored !== true);
  const rows = pooled.filter((e) => matchesName(e, query));
  const hiddenIgnored = showIgnored ? 0 : entries.filter((e) => e.ignored === true && matchesName(e, query)).length;
  return { rows, pool: pooled.length, hiddenIgnored };
}
