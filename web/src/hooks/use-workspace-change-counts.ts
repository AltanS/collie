import { useEffect, useRef, useState } from "react";

import { fetchChanges, type ChangesLookup } from "@/lib/api";
import { scopeKey, type Scope } from "@/lib/scope";
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
/** The pause between two rounds, counted from the end of one to the start of the next. */
export const CHANGE_COUNT_REFRESH_MS = 5_000;

const LOADING: WorkspaceChangeCount = { kind: "loading" };

/**
 * The Changes tab's numbers, per workspace (ADR 0066). While `active`, it reads every target at
 * once (up to {@link CHANGE_COUNT_CONCURRENCY} in flight), then waits
 * {@link CHANGE_COUNT_REFRESH_MS} and reads again. Rounds never overlap: the next wait starts when
 * the last answer of this round is in. A hidden page skips its round and reads again the moment it
 * is visible. Leaving the tab (`active` false) or unmounting aborts what is in flight and stops.
 *
 * A row keeps its last answer through a refresh, so the numbers repaint and never blink back to
 * loading. A failed read keeps a row's last good answer too; a row that never had one says it is
 * unavailable.
 */
export function useWorkspaceChangeCounts(
  targets: readonly WorkspaceChangeTarget[],
  lookup: ChangesLookup,
  active: boolean,
): ReadonlyMap<string, WorkspaceChangeCount> {
  const [counts, setCounts] = useState<ReadonlyMap<string, WorkspaceChangeCount>>(() => new Map());
  // The targets are rebuilt on every poll of the snapshot; only their identity decides a restart.
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const identity = targets.map((t) => `${t.key}\u0001${t.workspaceId}\u0001${scopeKey(t.scope)}`).join("\u0002");
  const { depth, nested } = lookup;

  useEffect(() => {
    if (!active) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    const record = (key: string, next: WorkspaceChangeCount) =>
      setCounts((prev) => {
        const m = new Map(prev);
        m.set(key, next);
        return m;
      });

    const round = async (): Promise<void> => {
      timer = undefined;
      if (running || ctl.signal.aborted) return;
      if (document.visibilityState !== "visible") return; // `onVisible` starts the next one.
      running = true;
      const tasks = targetsRef.current.map((t) => async () => {
        try {
          const res = await fetchChanges({ kind: "space", spaceId: t.workspaceId }, { depth, nested }, t.scope, ctl.signal);
          if (!ctl.signal.aborted) record(t.key, summarizeChanges(res));
        } catch {
          if (ctl.signal.aborted) return;
          setCounts((prev) => {
            const had = prev.get(t.key);
            if (had !== undefined && had.kind !== "loading") return prev;
            const m = new Map(prev);
            m.set(t.key, { kind: "unavailable" });
            return m;
          });
        }
      });
      await runPool(tasks, CHANGE_COUNT_CONCURRENCY);
      running = false;
      if (!ctl.signal.aborted) timer = setTimeout(() => void round(), CHANGE_COUNT_REFRESH_MS);
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || running) return;
      if (timer !== undefined) clearTimeout(timer);
      void round();
    };

    document.addEventListener("visibilitychange", onVisible);
    void round();
    return () => {
      ctl.abort();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, identity, depth, nested]);

  return counts;
}

/** A row's count, or loading when the tab has not heard about it yet. */
export function countFor(counts: ReadonlyMap<string, WorkspaceChangeCount>, key: string): WorkspaceChangeCount {
  return counts.get(key) ?? LOADING;
}
