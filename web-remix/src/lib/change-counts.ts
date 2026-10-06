// The Files tab's numbers, per workspace (ADR 0066): web/src/hooks/use-workspace-change-counts.ts
// without React. While the tab is mounted it reads every shown workspace's `GET
// /api/workspace/:id/changes` at once (at most CHANGE_COUNT_CONCURRENCY in flight), then again every
// CHANGES_POLL_MS while the page is visible. Rounds never overlap; a page that comes back visible
// reads at once and replaces a round still out from before it hid. Leaving the tab aborts it all.
//
// NO ROW BLINKS. A workspace this page answered before starts on its kept answer (`lastCounts`, for
// the page's life, keyed by machine, session, workspace and the two Changes settings); a failed read
// keeps a row's last good answer; an answer equal to the last one changes nothing at all, so the
// owner is not woken. Only a never-read workspace starts on the skeleton.
import { fetchChanges, type ChangesLookup } from "@web/lib/api";
import { scopeKey, type Scope } from "@web/lib/scope";
import { countSignature, runPool, summarizeChanges, type WorkspaceChangeCount } from "@web/lib/workspace-changes";

export type { ChangesLookup, WorkspaceChangeCount };
export { countArrival, countSignature } from "@web/lib/workspace-changes";

export const CHANGES_POLL_MS = 5000;
export const CHANGE_COUNT_CONCURRENCY = 3;

/** One workspace the tab asks about. `key` is the dashboard group's own key. */
export interface WorkspaceChangeTarget {
  key: string;
  workspaceId: string;
  /** The machine and session the workspace lives on, so a crew member's is asked with `?host=`. */
  scope: Scope;
}

export type ChangeCounts = ReadonlyMap<string, WorkspaceChangeCount>;

const LOADING: WorkspaceChangeCount = { kind: "loading" };
const UNAVAILABLE: WorkspaceChangeCount = { kind: "unavailable" };

const lastCounts = new Map<string, WorkspaceChangeCount>();

function cacheKey(t: Pick<WorkspaceChangeTarget, "scope" | "workspaceId">, lookup: ChangesLookup): string {
  return `${scopeKey(t.scope)}\u0001${t.workspaceId}\u0001${lookup.nested ? 1 : 0}\u0001${String(lookup.depth)}`;
}

/** The answer this page last kept for one workspace (the Changes screen seeds its header with it). */
export function keptChangeCount(t: Pick<WorkspaceChangeTarget, "scope" | "workspaceId">, lookup: ChangesLookup): WorkspaceChangeCount | undefined {
  return lastCounts.get(cacheKey(t, lookup));
}

/** Keep a count from outside the tab: the Changes screen writes what its own list read sums to. */
export function keepChangeCount(t: Pick<WorkspaceChangeTarget, "scope" | "workspaceId">, lookup: ChangesLookup, count: WorkspaceChangeCount): void {
  if (count.kind !== "loading") lastCounts.set(cacheKey(t, lookup), count);
}

/** Tests only. */
export function resetChangeCountCache(): void {
  lastCounts.clear();
}

/** A row's count, or loading when nothing is known yet. */
export function countFor(counts: ChangeCounts, key: string): WorkspaceChangeCount {
  return counts.get(key) ?? LOADING;
}

/** `prev` with the kept answers it lacks for these targets merged in; `prev` itself when none. */
export function seededCounts(prev: ChangeCounts, targets: readonly WorkspaceChangeTarget[], lookup: ChangesLookup): ChangeCounts {
  let out: Map<string, WorkspaceChangeCount> | null = null;
  for (const t of targets) {
    if (prev.has(t.key)) continue;
    const kept = lastCounts.get(cacheKey(t, lookup));
    if (kept === undefined) continue;
    out ??= new Map(prev);
    out.set(t.key, kept);
  }
  return out ?? prev;
}

/** `prev` with `next` recorded for `key`; `prev` itself when the row already reads the same. */
export function recordCount(prev: ChangeCounts, key: string, next: WorkspaceChangeCount): ChangeCounts {
  const had = prev.get(key);
  if (had !== undefined && countSignature(had) === countSignature(next)) return prev;
  const out = new Map(prev);
  out.set(key, next);
  return out;
}

/** A failed read: a row that never had a good answer says unavailable; one that had keeps it. */
export function failCount(prev: ChangeCounts, key: string): ChangeCounts {
  const had = prev.get(key);
  if (had !== undefined && had.kind !== "loading") return prev;
  const out = new Map(prev);
  out.set(key, UNAVAILABLE);
  return out;
}

/** A stable string for a target list: a change means a new round. */
export function targetsIdentity(targets: readonly WorkspaceChangeTarget[]): string {
  return targets.map((t) => `${t.key}\u0001${t.workspaceId}\u0001${scopeKey(t.scope)}`).join("\u0002");
}

export interface ChangeCountWatch {
  /** The counts now. A new Map only on a real change. */
  counts(): ChangeCounts;
  /** The targets changed (new identity): seed what is kept and read at once. */
  retarget(): void;
}

/**
 * Watch the counts for the targets `targets()` names, until `signal` aborts. `onChange` runs after
 * every real change; the owner wakes through `scheduleUpdate` from it (rule 1). `fetch` is injectable
 * for the tests.
 */
const visible = (): boolean => document.visibilityState === "visible";

export function watchChangeCounts(
  targets: () => readonly WorkspaceChangeTarget[],
  lookup: () => ChangesLookup,
  onChange: () => void,
  signal: AbortSignal,
  read: typeof fetchChanges = fetchChanges,
): ChangeCountWatch {
  let counts: ChangeCounts = seededCounts(new Map(), targets(), lookup());
  let current: AbortController | null = null;
  let outWhenHidden: AbortController | null = null;
  const set = (next: ChangeCounts): void => {
    if (next === counts || signal.aborted) return;
    counts = next;
    onChange();
  };
  const round = async (replace = false): Promise<void> => {
    if (signal.aborted) return;
    if (current !== null) {
      if (!replace) return;
      current.abort();
    }
    const mine = new AbortController();
    current = mine;
    const stop = (): void => mine.abort();
    signal.addEventListener("abort", stop, { once: true });
    const at = lookup();
    const tasks = targets().map((t) => async () => {
      try {
        const res = await read({ kind: "space", spaceId: t.workspaceId }, at, t.scope, mine.signal);
        if (mine.signal.aborted) return;
        const next = summarizeChanges(res);
        lastCounts.set(cacheKey(t, at), next);
        set(recordCount(counts, t.key, next));
      } catch {
        if (!mine.signal.aborted) set(failCount(counts, t.key));
      }
    });
    await runPool(tasks, CHANGE_COUNT_CONCURRENCY);
    signal.removeEventListener("abort", stop);
    if (current === mine) current = null;
  };
  const timer = setInterval(() => {
    if (visible()) void round();
  }, CHANGES_POLL_MS);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!visible()) {
        outWhenHidden = current;
        return;
      }
      const stale = current !== null && current === outWhenHidden;
      outWhenHidden = null;
      void round(stale);
    },
    { signal },
  );
  if (visible()) void round();
  return {
    counts: () => counts,
    retarget: () => {
      set(seededCounts(counts, targets(), lookup()));
      void round(true);
    },
  };
}
