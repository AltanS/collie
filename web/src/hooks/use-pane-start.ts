import { useCallback, useEffect, useState } from "react";

import { CHAT_GRACE_MS, activityAt, type PaneActivity, type PaneHistory } from "@/lib/chat-gate";
import type { AgentStatus } from "@/lib/types";

// What this view has seen of how the open pane's agent began, for lib/chat-gate.ts.
//
// Two readings, and both are memory of THIS view, never a fact the bridge holds:
//
//   history   `fresh` when this view watched the pane turn from a shell into the agent, or first saw
//             the agent idle. `unknown` when the first sight was already busy, done or unknown.
//   activity  whether the agent has worked since it began (a status other than idle, or a prompt
//             sent from this device), and whether that began {@link CHAT_GRACE_MS} ago or more.
//
// ── A NEW AGENT IS A NEW RECORD ──────────────────────────────────────────────
// Both readings belong to one agent in one pane. A pane switch, an agent that exits to a shell and
// a different harness in the same pane all start a new record, so a prompt typed into the shell
// (`codex`, sent from the phone) never counts as the new agent's first turn.
//
// ── ONE TIMER, AND ONLY WHILE IT CAN MATTER ──────────────────────────────────
// The grace ends on a single timeout, armed when work begins and gone once it fires. It reads
// nothing and fetches nothing: it only moves `recent` to `long`. The poll cadence is untouched.

/** Which statuses count as "the agent has worked". `unknown` says nothing either way. */
function hasWorked(status: AgentStatus | undefined): boolean {
  return status === "working" || status === "blocked" || status === "done";
}

interface Seen {
  paneId: string;
  harness: string;
  kind: "shell" | "agent";
  history: PaneHistory;
}

/**
 * The next record, given the last one and this render's reading of the pane. Returns `prev` itself
 * when nothing that starts a new record moved, so the caller can compare by identity.
 */
export function nextSeen(
  prev: Seen | null,
  paneId: string,
  harness: string | undefined,
  isShell: boolean,
  status: AgentStatus | undefined,
): Seen | null {
  // The pane is not in the snapshot this beat. Not evidence of anything, so the record stands, unless
  // this is another pane, whose record we do not have.
  if (harness === undefined) return prev !== null && prev.paneId !== paneId ? null : prev;
  const kind = isShell ? "shell" : "agent";
  const samePane = prev !== null && prev.paneId === paneId;
  if (samePane && prev.kind === kind && prev.harness === harness) return prev;
  const watchedStart = samePane && prev.kind === "shell" && kind === "agent";
  return {
    paneId,
    harness,
    kind,
    history: watchedStart || status === "idle" ? "fresh" : "unknown",
  };
}

export interface PaneStart {
  history: PaneHistory;
  activity: PaneActivity;
  /** The operator sent a prompt to this pane from this device. */
  markSent: () => void;
}

export function usePaneStart(
  paneId: string,
  harness: string | undefined,
  isShell: boolean,
  status: AgentStatus | undefined,
): PaneStart {
  const [seen, setSeen] = useState<Seen | null>(null);
  // When this agent began to work (epoch ms), and whether the grace since then is over.
  const [since, setSince] = useState<number | null>(null);
  const [over, setOver] = useState(false);

  // Taken in the render that sees it (the adjust-state-in-render pattern), so the first frame of a
  // new agent already has its record and the body never draws one frame on the old one.
  const next = nextSeen(seen, paneId, harness, isShell, status);
  if (next !== seen) {
    setSeen(next);
    setSince(null);
    setOver(false);
  }

  const working = next !== null && next.kind === "agent" && hasWorked(status);
  useEffect(() => {
    if (working) setSince((s) => s ?? Date.now());
  }, [working, next]);

  // The grace's one timer. Armed while work has begun and the grace is not yet over.
  useEffect(() => {
    if (since === null || over) return;
    const now = Date.now();
    if (activityAt(since, now) === "long") {
      setOver(true);
      return;
    }
    const id = setTimeout(() => setOver(true), since + CHAT_GRACE_MS - now);
    return () => clearTimeout(id);
  }, [since, over]);

  const isAgent = next !== null && next.kind === "agent";
  const markSent = useCallback(() => {
    if (isAgent) setSince((s) => s ?? Date.now());
  }, [isAgent]);

  return {
    // A pane this view has no record of yet reads as fresh: rule 3 of the gate must not fire on a
    // beat where the snapshot simply has not named the pane.
    history: next?.history ?? "fresh",
    activity: since === null ? "none" : over ? "long" : "recent",
    markSent,
  };
}
