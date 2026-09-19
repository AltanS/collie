import { useCallback, useEffect, useRef, useState } from "react";

import { fetchHistory } from "@/lib/api";
import { internScope, paneScopeKey, type Scope } from "@/lib/scope";
import type { TranscriptEntry } from "@/lib/types";

// The Conversation-mode transcript source: a bounded recent window of the pane's persisted journal
// entries, refreshed on a coalesced set of triggers rather than on every pane poll.
//
// WHAT IT IS NOT. The journal has no completion marker (bridge/journal/types.ts), so nothing here
// promises token streaming or a settled assistant turn — "entries" are persisted turns, nothing
// more. And the fetches are BOUNDED: a recent page (TURNS), not the whole journal, so a long
// session still opens cheap.
//
// WHEN IT FETCHES (the coalesced trigger set, per the Conversation refresh contract):
//   1. immediately on pane entry (the hook mounting with `enabled`),
//   2. after the mirror text SETTLES (unchanged for SETTLE_MS),
//   3. after a successful send (`bump()`, called from the send path),
//   4. on foreground resume (the tab becoming visible again),
//   5. on an explicit user refresh (`refresh()`).
// Triggers are COALESCED into one scheduled fetch, so a send landing inside a settle never asks
// twice. A trigger while a fetch is in flight supersedes it — one pass, not a loop.
//
// THE BOUNDED RETRY. Every pass that was started by a TRIGGER (not by the retry itself) arms
// exactly ONE delayed retry, to cover journal-flush lag (the log may be written after the screen
// shows it). RETRY EXECUTION IS SEPARATE FROM TRIGGER REARMING: the retry marks itself as a retry
// before bumping the trigger, and the arming effect consumes that mark instead of arming again —
// so an idle pane stops after entry plus one retry, and a slow/in-flight fetch is superseded by
// that one retry and then goes quiet. A fresh trigger (send, settle, refresh) rearms normally.
//
// MERGE BY UUID. Later tool results can be attached to an earlier turn, so an entry whose parts
// changed REPLACES the copy on screen rather than duplicating it (PRD story 16).
//
// STALE DISCARD. The pane address and observable crew/harness identity invalidate pending reads.
// Observed eligibility loss also clears cached entries. Invisible journal replacement inside an
// otherwise unchanged pane is unsupported: the wire exposes no resolved agent-journal identity.

/** Turns requested. Newest-anchored, bounded. */
const TURNS = 30;

/** How long the mirror must hold still before its content counts as settled output. */
const SETTLE_MS = 1500;

/** One bounded delayed retry after send/settle, to cover journal-flush lag. */
const RETRY_MS = 1200;

export type ConversationState =
  | "loading"
  | "ok"
  | "no-session"
  | "no-log"
  | "disabled"
  | "error";

export interface Conversation {
  /** Oldest-first persisted entries, merged by uuid. Empty until the first page lands. */
  entries: TranscriptEntry[];
  /** Distinguishable load state — see the PRD's "retain distinguishable feedback" story. */
  state: ConversationState;
  /** Explicit refresh, for the view's own affordance. */
  refresh: () => void;
  /** Send-path trigger — called after a successful reply. */
  bump: () => void;
}

export function useConversation({
  paneId,
  scope: requestedScope,
  sourceKey = "",
  enabled,
  active = enabled,
  mirrorText,
}: {
  paneId: string;
  scope?: Scope;
  /** Browser-visible crew membership and harness identity, never a journal path or inferred ID. */
  sourceKey?: string;
  /** Journal eligibility. Losing it clears the cache even while Terminal is showing. */
  enabled: boolean;
  /** Reading mode. Pausing cancels requests without discarding this pane's transcript. */
  active?: boolean;
  /** Live pane text, independent of the reader's scroll position. */
  mirrorText: string;
}): Conversation {
  const scope = internScope(requestedScope);
  const running = enabled && active;
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [state, setState] = useState<ConversationState>("loading");
  // The ONE trigger counter. Every coalesced trigger — settle, send, resume, refresh — lands here;
  // each committed change schedules exactly one fetch pass. The retry bumps it too, but marks
  // itself first so the arming effect below does NOT rearm it (the endless-poll fix).
  const [trigger, setTrigger] = useState(0);
  const settledRef = useRef(mirrorText);
  const retryingRef = useRef(false);

  // A short trailing debounce also coalesces events delivered in separate browser tasks.
  // React batching alone only joins calls from the same task.
  const triggerTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryTimer = useRef<number | null>(null);
  const fire = useCallback(() => {
    // A new trigger replaces an imminent retry too, not just another debounced trigger.
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    clearTimeout(triggerTimer.current);
    triggerTimer.current = setTimeout(() => {
      retryingRef.current = false;
      setTrigger((n) => n + 1);
    }, 50);
  }, []);

  // A disabled source may have lost its agent session without changing the pane address.
  // Clear on both edges of eligibility changes. Reading-mode changes retain the cache.
  const address = JSON.stringify([paneScopeKey(scope, paneId), sourceKey]);
  useEffect(() => () => clearTimeout(triggerTimer.current), [address, running]);
  useEffect(() => {
    setEntries([]);
    setState("loading");
    settledRef.current = mirrorText; // a fresh pane starts from its own current tail
    retryingRef.current = false;
  }, [address, enabled]); // eslint-disable-line react-hooks/exhaustive-deps -- seed current live text on source transitions

  // Settle trigger: the mirror going quiet. Only a CHANGE from the last settled text fires — an
  // unchanged mirror (the common case, every poll) triggers nothing.
  useEffect(() => {
    if (!running) return;
    if (mirrorText === settledRef.current) return;
    const timer = setTimeout(() => {
      if (mirrorText === settledRef.current) return;
      settledRef.current = mirrorText;
      fire();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [address, mirrorText, running]); // eslint-disable-line react-hooks/exhaustive-deps -- fire is stable

  // Foreground resume: a stale background thread must be replaced when the tab comes back.
  useEffect(() => {
    if (!running) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") fire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps -- fire is stable

  // The fetch pass. One counter, one pass per commit — overlapping triggers coalesce.
  const fetchSeq = useRef(0);

  useEffect(() => {
    if (!running) return;
    const seq = ++fetchSeq.current;
    const abort = new AbortController();
    let live = true;
    void (async () => {
      try {
        const page = await fetchHistory(paneId, { limit: TURNS }, scope, abort.signal);
        if (!live || seq !== fetchSeq.current) return; // stale response — discarded
        if (!page.available) {
          setState(page.reason ?? "error");
          if (page.reason === "no-session") setEntries([]);
          return;
        }
        setState("ok");
        // The bounded recent page REPLACES the thread, oldest-first as the API returns it. Because
        // both fetches ask for the same recent window, an entry whose later tool results changed
        // its parts arrives with the SAME uuid and replaces its on-screen copy (keyed by uuid in
        // the thread) rather than duplicating it; entries the window moved past drop out. This is
        // deliberately not a whole-journal merge — the window is the contract, not the history.
        setEntries(page.entries);
      } catch {
        if (!live || seq !== fetchSeq.current) return;
        // An aborted fetch (a trigger superseded it, or the pane changed) is not an error state.
        if (abort.signal.aborted) return;
        setState("error");
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
  }, [address, paneId, scope, running, trigger]);

  // The bounded retry: each TRIGGERED pass arms exactly one extra pass after RETRY_MS, to cover
  // the journal being flushed after the screen updated. A retry pass consumes its own mark and
  // arms nothing — so an idle pane stops after entry plus one retry, whatever the fetch latency.
  useEffect(() => {
    if (!running) return;
    if (retryingRef.current) {
      retryingRef.current = false; // THIS pass is the retry — do not rearm it.
      return;
    }
    if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      retryingRef.current = true; // mark the next pass as the retry itself
      setTrigger((n) => n + 1);
    }, RETRY_MS);
    return () => {
      if (retryTimer.current !== null) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [address, running, trigger]);

  return enabled ? { entries, state, refresh: fire, bump: fire } : { entries: [], state: "loading", refresh: fire, bump: fire };
}
