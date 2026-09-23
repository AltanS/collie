import { useEffect, useRef, useState } from "react";

import { CHANGES_POLL_MS, useVisibleInterval } from "@/hooks/use-visible-interval";
import { fetchChanges, type ChangesLookup } from "@/lib/api";
import { scopeKey, type Scope } from "@/lib/scope";
import { shareEqual } from "@/lib/share-equal";
import { runPool, summarizeChanges, type WorkspaceChangeCount } from "@/lib/workspace-changes";

/** One workspace the Changes tab asks about. `key` is the dashboard group's own key. */
export interface WorkspaceChangeTarget {
  key: string;
  workspaceId: string;
  /** The machine and session the workspace lives on, so a crew member's is asked with `?host=`. */
  scope: Scope;
}

/** At most this many workspaces are read at once: a git status per workspace is not free. */
export const CHANGE_COUNT_CONCURRENCY = 3;

const LOADING: WorkspaceChangeCount = { kind: "loading" };
const UNAVAILABLE: WorkspaceChangeCount = { kind: "unavailable" };

/**
 * The last answer per workspace, kept for the whole page session, so a return to the Changes tab
 * shows the numbers it last had at once and the refresh updates them quietly. Only a workspace this
 * page has never heard about starts on the skeleton. Keyed by the machine and session, the workspace
 * and the two Changes settings that shape the answer, so a settings change never shows another
 * setting's numbers.
 */
const lastCounts = new Map<string, WorkspaceChangeCount>();

function cacheKey(t: Pick<WorkspaceChangeTarget, "scope" | "workspaceId">, lookup: ChangesLookup): string {
  return `${scopeKey(t.scope)}\u0001${t.workspaceId}\u0001${lookup.nested ? 1 : 0}\u0001${lookup.depth}`;
}

/**
 * The answer this page last kept for one workspace, if any. The Changes screen seeds its header
 * with it, so a tap on a tab row shows the row's own numbers on the screen's first frame.
 */
export function keptChangeCount(
  t: Pick<WorkspaceChangeTarget, "scope" | "workspaceId">,
  lookup: ChangesLookup,
): WorkspaceChangeCount | undefined {
  return lastCounts.get(cacheKey(t, lookup));
}

/**
 * Keep a workspace's count from outside the tab: the Changes screen writes what its own list read
 * sums to, so the tab shows that number at once on the way back.
 */
export function keepChangeCount(
  t: Pick<WorkspaceChangeTarget, "scope" | "workspaceId">,
  lookup: ChangesLookup,
  count: WorkspaceChangeCount,
): void {
  if (count.kind !== "loading") lastCounts.set(cacheKey(t, lookup), count);
}

/** Tests only: forget every kept answer. */
export function resetChangeCountCache(): void {
  lastCounts.clear();
}

/** The kept answers for these targets that `prev` does not hold yet, merged over it; `prev` itself when none. */
function seeded(
  prev: ReadonlyMap<string, WorkspaceChangeCount>,
  targets: readonly WorkspaceChangeTarget[],
  lookup: ChangesLookup,
): ReadonlyMap<string, WorkspaceChangeCount> {
  let m: Map<string, WorkspaceChangeCount> | null = null;
  for (const t of targets) {
    if (prev.has(t.key)) continue;
    const kept = lastCounts.get(cacheKey(t, lookup));
    if (kept === undefined) continue;
    m ??= new Map(prev);
    m.set(t.key, kept);
  }
  return m ?? prev;
}

/**
 * The Changes tab's numbers, per workspace (ADR 0066). While `active`, it reads every target at
 * once (up to {@link CHANGE_COUNT_CONCURRENCY} in flight), then again on every
 * {@link CHANGES_POLL_MS} beat of `useVisibleInterval`, the loop the Changes screen uses
 * too. Entering the tab reads at once, never waiting for the first beat. Rounds never overlap: a
 * beat that finds a round still out skips it. A hidden page stops the beat and reads again the
 * moment it is visible, replacing a round still out from before it was hidden. Leaving the tab (`active` false) or unmounting
 * aborts what is in flight and stops.
 *
 * A workspace answered before in this page session starts on its kept answer (see `lastCounts`), so
 * re-entering the tab shows numbers at once and only a never-read workspace starts on loading.
 *
 * An answer equal to a row's last one changes no state at all. A row keeps its last answer through
 * a refresh, so the numbers repaint and never blink back to loading. A failed read keeps a row's last good answer too; a row that never had one says it is
 * unavailable.
 */
export function useWorkspaceChangeCounts(
  targets: readonly WorkspaceChangeTarget[],
  lookup: ChangesLookup,
  active: boolean,
): ReadonlyMap<string, WorkspaceChangeCount> {
  const [counts, setCounts] = useState<ReadonlyMap<string, WorkspaceChangeCount>>(() => seeded(new Map(), targets, lookup));
  // The targets are rebuilt on every poll of the snapshot; only their identity decides a restart.
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const identity = targets.map((t) => `${t.key}\u0001${t.workspaceId}\u0001${scopeKey(t.scope)}`).join("\u0002");
  const { depth, nested } = lookup;
  // The latest round, for the beat; each effect run below installs its own.
  const roundNow = useRef<() => void>(() => {});
  // A round still out when the beat comes skips it, so none overlap.
  useVisibleInterval(() => roundNow.current(), CHANGES_POLL_MS, active);

  useEffect(() => {
    if (!active) return;
    const ctl = new AbortController();
    const at = { depth, nested };
    // A workspace that joined since the first paint may still have a kept answer.
    setCounts((prev) => seeded(prev, targetsRef.current, at));

    // An answer equal to the row's last one keeps the map as it is, so the dashboard does not
    // render again on a beat that changed nothing.
    const record = (t: WorkspaceChangeTarget, next: WorkspaceChangeCount) => {
      lastCounts.set(cacheKey(t, at), next);
      setCounts((prev) => {
        const had = prev.get(t.key);
        if (had !== undefined && shareEqual(had, next) === had) return prev;
        const m = new Map(prev);
        m.set(t.key, next);
        return m;
      });
    };

    // The round in flight, with its own abort, so a read "now" can replace it (see `onVisible`).
    let current: AbortController | null = null;
    const round = async (replace = false): Promise<void> => {
      if (ctl.signal.aborted) return;
      if (current !== null) {
        if (!replace) return;
        current.abort();
      }
      const mine = new AbortController();
      current = mine;
      const stop = () => mine.abort();
      ctl.signal.addEventListener("abort", stop, { once: true });
      const tasks = targetsRef.current.map((t) => async () => {
        try {
          const res = await fetchChanges({ kind: "space", spaceId: t.workspaceId }, { depth, nested }, t.scope, mine.signal);
          if (!mine.signal.aborted) record(t, summarizeChanges(res));
        } catch {
          if (mine.signal.aborted) return;
          setCounts((prev) => {
            const had = prev.get(t.key);
            if (had !== undefined && had.kind !== "loading") return prev;
            const m = new Map(prev);
            m.set(t.key, UNAVAILABLE);
            return m;
          });
        }
      });
      await runPool(tasks, CHANGE_COUNT_CONCURRENCY);
      ctl.signal.removeEventListener("abort", stop);
      if (current === mine) current = null;
    };

    // Back on screen: read now, and replace a round still out from before the page was hidden. A
    // phone that sleeps can leave a request hanging, and the beat alone would skip behind it. A
    // round started since (the beat's own visible read) is left alone.
    let outWhenHidden: AbortController | null = null;
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        outWhenHidden = current;
        return;
      }
      const stale = current !== null && current === outWhenHidden;
      outWhenHidden = null;
      void round(stale);
    };

    roundNow.current = () => void round();
    // Entering the tab reads at once, not on the first beat.
    if (document.visibilityState === "visible") void round();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ctl.abort();
      document.removeEventListener("visibilitychange", onVisible);
      roundNow.current = () => {};
    };
  }, [active, identity, depth, nested]);

  return counts;
}

/** A row's count, or loading when the tab has not heard about it yet. */
export function countFor(counts: ReadonlyMap<string, WorkspaceChangeCount>, key: string): WorkspaceChangeCount {
  return counts.get(key) ?? LOADING;
}
