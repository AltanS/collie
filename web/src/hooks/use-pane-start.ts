import { useCallback, useEffect, useState } from "react";

import { LAST_RESORT_NO_JOURNAL_MS, type PaneActivity, type PaneHistory } from "@/lib/chat-gate";
import { mayBeNewWithNothingToRead } from "@/lib/journal-agents";
import type { AgentStatus } from "@/lib/types";

// What this view has seen of how the open pane's agent began, for lib/chat-gate.ts.
//
// Memory of THIS view, never a fact the bridge holds:
//
//   history   `fresh` when this view watched the pane turn from a shell into the agent, or first saw
//             an agent idle that has an excuse for having nothing to read yet (Codex with no session,
//             pi with a session and no log: lib/journal-agents.ts `mayBeNewWithNothingToRead`).
//             `unknown` otherwise: first sight already busy, done or unknown, or idle with nothing
//             to read and no such excuse, which may be a long conversation Chat cannot show.
//   activity  the EVENTS seen since the agent began: it worked, it asked for input, its first turn
//             ended. Each is read off a snapshot, in the render that brings it.
//   settled   whether the journal read started AFTER the turn-end snapshot has answered.
//
// ── HOW THE TURN-END READ IS SEQUENCED ───────────────────────────────────────
// The chat feed numbers its reads (hooks/use-chat-window.ts: `asked` is the number of the last read
// started, `answered` the number of the last read that came back with an answer). The render that
// first sees the turn end records `asked` as it stands in that render. A read started before that
// render has a number at or below the mark; the read the turn-end poll starts runs in the effect
// AFTER that render, so it gets the next number. `settled` is `answered > mark`: only an answer to a
// read that began after the turn ended can say "still no log". A failed read settles nothing; the
// next poll's read is the next chance, and the poll is what the operator's turn already made hot.
//
// ── A NEW AGENT IS A NEW RECORD ──────────────────────────────────────────────
// Every reading belongs to one agent in one pane. A pane switch, an agent that exits to a shell and
// a different harness in the same pane all start a new record, so a prompt typed into the shell
// (`codex`, sent from the phone) never counts as the new agent's first turn.
//
// ── ONE LAST-RESORT TIMER, AND ONLY WHILE NO EVENT CAN COME ─────────────────
// Armed only while the agent works with nothing to read (lib/chat-gate.ts § LAST_RESORT_NO_JOURNAL_MS)
// and gone the moment anything moves: the log becomes readable, the turn ends, the pane asks, or the
// record resets. It reads nothing and fetches nothing. The poll cadence is untouched.

interface Seen {
  paneId: string;
  harness: string;
  kind: "shell" | "agent";
  history: PaneHistory;
}

/**
 * The next identity record, given the last one and this render's reading of the pane. Returns `prev`
 * itself when nothing that starts a new record moved, so the caller can compare by identity.
 */
export function nextSeen(
  prev: Seen | null,
  paneId: string,
  harness: string | undefined,
  isShell: boolean,
  status: AgentStatus | undefined,
  hasSession: boolean,
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
    history: watchedStart || (status === "idle" && mayBeNewWithNothingToRead(harness, hasSession)) ? "fresh" : "unknown",
  };
}

/** Everything this view remembers about one agent's start. The latches only ever go one way. */
export interface StartRecord {
  seen: Seen | null;
  /** A snapshot showed the agent working, blocked or done. */
  worked: boolean;
  /** A snapshot showed the agent blocked: it asked for input. */
  blocked: boolean;
  /** The chat feed's `asked` in the render that first saw the first turn end; null until then. */
  endMark: number | null;
  /** A prompt was sent from this device. Arms the last resort on a harness whose status never moves. */
  sent: boolean;
  /** The last resort fired. */
  stalled: boolean;
}

export const NO_RECORD: StartRecord = {
  seen: null,
  worked: false,
  blocked: false,
  endMark: null,
  sent: false,
  stalled: false,
};

/**
 * The next record for this render's snapshot. Pure, and returns `prev` itself when nothing moved, so
 * the hook can take it in render without looping.
 *
 * The first turn has ended when a snapshot reads `done`, or reads `idle` after one read the agent
 * working. `idle` alone is not an end: a fresh agent is idle before its first prompt.
 */
export function nextRecord(
  prev: StartRecord,
  paneId: string,
  harness: string | undefined,
  isShell: boolean,
  status: AgentStatus | undefined,
  asked: number,
  hasSession: boolean,
): StartRecord {
  const seen = nextSeen(prev.seen, paneId, harness, isShell, status, hasSession);
  const base = seen === prev.seen ? prev : { ...NO_RECORD, seen };
  if (seen === null || seen.kind !== "agent" || harness === undefined) return base;
  const worked = base.worked || status === "working" || status === "blocked" || status === "done";
  const blocked = base.blocked || status === "blocked";
  const ended = status === "done" || (base.worked && status === "idle");
  const endMark = base.endMark ?? (ended ? asked : null);
  if (worked === base.worked && blocked === base.blocked && endMark === base.endMark) return base;
  return { ...base, worked, blocked, endMark };
}

/** The gate's activity reading of a record. A question or the last resort outranks an ended turn. */
export function activityOf(record: StartRecord): PaneActivity {
  if (record.blocked) return "blocked";
  if (record.stalled) return "stalled";
  if (record.endMark !== null) return "ended";
  if (record.worked || record.sent) return "working";
  return "none";
}

export interface PaneStart {
  history: PaneHistory;
  activity: PaneActivity;
  /** A read started after the turn-end snapshot has answered (see the header). */
  settled: boolean;
  /** The operator sent a prompt to this pane from this device. */
  markSent: () => void;
}

export interface JournalReads {
  /** The number of the last chat read started. */
  asked: number;
  /** The number of the last chat read that came back with an answer. */
  answered: number;
}

/**
 * @param readable the pane has a session and its log is not known to be missing. While it is, the
 *   last resort is never armed.
 * @param hasSession the pane reported a session. Read at first sight only, with the harness.
 */
export function usePaneStart(
  paneId: string,
  harness: string | undefined,
  isShell: boolean,
  status: AgentStatus | undefined,
  reads: JournalReads,
  readable: boolean,
  hasSession: boolean,
): PaneStart {
  const [record, setRecord] = useState<StartRecord>(NO_RECORD);

  // Taken in the render that sees it (the adjust-state-in-render pattern), so the first frame of a
  // new agent already has its record, and the render that brings the turn's end is the one whose
  // `asked` becomes the mark.
  const next = nextRecord(record, paneId, harness, isShell, status, reads.asked, hasSession);
  if (next !== record) setRecord(next);

  const activity = activityOf(next);
  // THE LAST RESORT. Armed only while the agent works with nothing to read; every event above
  // disarms it by moving `activity` or `readable`.
  const armed = activity === "working" && !readable;
  const seen = next.seen;
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(
      () => setRecord((r) => (r.seen === seen ? { ...r, stalled: true } : r)),
      LAST_RESORT_NO_JOURNAL_MS,
    );
    return () => clearTimeout(id);
  }, [armed, seen]);

  const isAgent = seen !== null && seen.kind === "agent";
  const markSent = useCallback(() => {
    if (isAgent) setRecord((r) => (r.seen === seen && !r.sent ? { ...r, sent: true } : r));
  }, [isAgent, seen]);

  return {
    // A pane this view has no record of yet reads as fresh: rule 3 of the gate must not fire on a
    // beat where the snapshot simply has not named the pane.
    history: seen?.history ?? "fresh",
    activity,
    settled: next.endMark !== null && reads.answered > next.endMark,
    markSent,
  };
}
