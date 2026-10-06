// Which body the pane draws: Chat, the Chat start state, or the Terminal (ADR 0082).
//
// The rule table is web's pure `paneBody` (web/src/lib/chat-gate.ts), read-only. What feeds it is
// web/src/hooks/use-pane-start.ts, a React hook: its pure half (`nextSeen`, `nextRecord`,
// `activityOf`) is ported here unchanged, and its two effects (the 60 s last resort and the "sent"
// latch) become a small controller that wakes its owner through a callback.
import {
  journalReadingOf,
  LAST_RESORT_NO_JOURNAL_MS,
  paneBody,
  type JournalReading,
  type PaneActivity,
  type PaneBody,
  type PaneHistory,
} from "@web/lib/chat-gate";
import type { ChatStatus } from "@web/lib/chat-window";
import { hasJournalAdapter, mayBeNewWithNothingToRead } from "@web/lib/journal-agents";
import type { AgentStatus } from "@web/lib/types";

interface Seen {
  paneId: string;
  harness: string;
  kind: "shell" | "agent";
  history: PaneHistory;
}

/** use-pane-start.ts `nextSeen`: the first sighting of this pane decides fresh or unknown history. */
export function nextSeen(
  prev: Seen | null,
  paneId: string,
  harness: string | undefined,
  isShell: boolean,
  status: AgentStatus | undefined,
  hasSession: boolean,
): Seen | null {
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

export interface StartRecord {
  seen: Seen | null;
  worked: boolean;
  blocked: boolean;
  endMark: number | null;
  sent: boolean;
  stalled: boolean;
}

export const NO_RECORD: StartRecord = { seen: null, worked: false, blocked: false, endMark: null, sent: false, stalled: false };

/** use-pane-start.ts `nextRecord`. `asked` is the journal read counter at this moment. */
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

/** use-pane-start.ts `activityOf`. */
export function activityOf(record: StartRecord): PaneActivity {
  if (record.blocked) return "blocked";
  if (record.stalled) return "stalled";
  if (record.endMark !== null) return "ended";
  if (record.worked || record.sent) return "working";
  return "none";
}

/** Everything the gate reads about one pane at one moment. */
export interface GateInput {
  paneId: string;
  /** The pane's agent string, "" for a bare shell, undefined while the snapshot has no record. */
  harness: string | undefined;
  isShell: boolean;
  status: AgentStatus | undefined;
  hasSession: boolean;
  /** The device pref `paneView` is "chat" (ADR 0082: no per-pane override). */
  chatChosen: boolean;
  /** The multiplexer can name an agent's session (`agentSessionRef`). */
  sessionLog: boolean;
  chat: ChatStatus;
  /** Journal reads started and answered so far (chat-store counters). */
  asked: number;
  answered: number;
}

export interface GateReading {
  body: PaneBody;
  journal: JournalReading;
  /** The chat window should be polled: chosen and there is a session to read, or a start to watch. */
  fetch: boolean;
  /** Arm the 60 s last resort: working with no readable journal. */
  armed: boolean;
}

/** What one gate step yields: the next record and the reading. */
export interface GateStep {
  record: StartRecord;
  reading: GateReading;
}

/** The gate's pure step: the next record and the body it yields. */
export function readGate(record: StartRecord, input: GateInput): GateStep {
  const next = nextRecord(record, input.paneId, input.harness, input.isShell, input.status, input.asked, input.hasSession);
  const journal = journalReadingOf(input.chat);
  const readable = input.hasSession && journal !== "missing" && journal !== "off";
  const activity = activityOf(next);
  const chatHarness = !input.isShell && input.sessionLog && (input.hasSession || hasJournalAdapter(input.harness));
  const body = paneBody({
    chat: input.chatChosen && chatHarness,
    session: input.hasSession,
    journal,
    history: next.seen?.history ?? "fresh",
    activity,
    settled: next.endMark !== null && input.answered > next.endMark,
  });
  return {
    record: next,
    reading: {
      body,
      journal,
      fetch: input.chatChosen && chatHarness,
      armed: activity === "working" && !readable,
    },
  };
}

/**
 * The gate as a controller: holds the record, runs the last-resort timer, and latches "sent". The
 * owner calls `read(input)` from render and gets the body; `onChange` is how a timer wakes it.
 */
export function createGate(onChange: () => void, signal: AbortSignal, lastResortMs = LAST_RESORT_NO_JOURNAL_MS) {
  let record = NO_RECORD;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedFor: Seen | null = null;
  signal.addEventListener("abort", () => clearTimeout(timer));

  const arm = (armed: boolean): void => {
    if (!armed) {
      clearTimeout(timer);
      timer = undefined;
      timedFor = null;
      return;
    }
    if (timer !== undefined && timedFor === record.seen) return;
    clearTimeout(timer);
    const seen = record.seen;
    timedFor = seen;
    timer = setTimeout(() => {
      timer = undefined;
      if (record.seen === seen && !record.stalled) {
        record = { ...record, stalled: true };
        onChange();
      }
    }, lastResortMs);
  };

  return {
    read(input: GateInput): GateReading {
      const step = readGate(record, input);
      record = step.record;
      arm(step.reading.armed);
      return step.reading;
    },
    /** A send from this phone counts as the start of work (use-pane-start.ts `markSent`). */
    markSent(): void {
      if (record.seen?.kind === "agent" && !record.sent) {
        record = { ...record, sent: true };
        onChange();
      }
    },
    get record(): StartRecord {
      return record;
    },
  };
}
