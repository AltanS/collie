// The dashboard's Changes tab reads one number set per workspace (ADR 0066): how many files changed
// and the lines added and removed, summed over every repo the workspace's Changes list holds. The
// full list and the diffs stay on the workspace's own Changes route (ADR 0065); this is its count.
import type { ChangesResponse } from "./types";

/** One workspace's row, as the tab draws it. */
export type WorkspaceChangeCount =
  /** Not answered yet. The row keeps its box and waits. */
  | { kind: "loading" }
  | { kind: "changed"; files: number; added: number; removed: number }
  /** A git folder with nothing uncommitted. */
  | { kind: "clean" }
  /** The multiplexer keeps no folder for this workspace (zellij), so there is nothing to read. */
  | { kind: "no-folder" }
  /** The bridge answered with another reason, or the request failed. */
  | { kind: "unavailable" };

/** Sum a Changes answer into one row's numbers. */
export function summarizeChanges(res: ChangesResponse): WorkspaceChangeCount {
  if (!res.available) return res.reason === "no-folder" ? { kind: "no-folder" } : { kind: "unavailable" };
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const repo of res.repos) {
    for (const f of repo.files) {
      files++;
      added += f.added;
      removed += f.removed;
    }
  }
  return files === 0 ? { kind: "clean" } : { kind: "changed", files, added, removed };
}

/**
 * Run `tasks` with at most `limit` in flight at once, in list order, and settle when all are done.
 * A task's own failure is its own business: this never rejects.
 */
export async function runPool(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      try {
        await task();
      } catch {
        // The task records its own failure; one bad workspace must not stop the others.
      }
    }
  };
  const lanes = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: lanes }, worker));
}
