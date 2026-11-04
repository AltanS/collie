// THE BELT'S JOBS MARK: THE BACKGROUND COMMANDS A SESSION STARTED, FROM ITS JOURNAL (ADR 0128).
//
// An agent can end its turn while a command it started still runs: Gentle Shell's `bash_background`
// and `monitor` answer "started" at once and pi logs the end later as a notice row. The journal
// reducer already turns that into an `execute` call with `background: true`, `ongoing: true` until
// the end arrives, and then `exitCode` and `endedAt` (bridge/journal/pi.ts, `startWork` and `settle`).
// This file lists those calls for the Jobs mark and its sheet. It reads the `ToolCall` facts only, so
// any journal whose calls carry them gets the mark; no harness is named here.
//
// RUNNING AND ENDED. A running job is a background call still `ongoing`. An ended one is a background
// call with an `endedAt` in the last {@link RECENT_JOB_MS}, so the result of a job that ended while
// nobody looked is still there when the phone opens; an older one leaves the list. The window is
// applied at each read, because it moves with the clock while the log stays still.
//
// MEMORY ONLY, like `JournalSubagents` (bridge/subagents-journal.ts): the calls are read from the live
// window a Chat poll keeps for the session (bridge/journal/live.ts, `LiveWindows.held`), never from
// disk. The mark fills while a reader polls the session's Chat and empties {@link HELD_FRESH_MS} after
// the last poll. A window holds the newest turns only, so a job whose call left its front leaves the
// list too. The dashboard needs a journal tail for a count of its own (ADR 0128, point 4).
//
// STALE JOBS. A job whose end never arrives (the harness was killed) would run for ever, so the list
// answers only while the session's log was written in the last `QUIET_RUNNING_MS`, the bound the
// subagent lists use.
//
// The pane's `working` light is the multiplexer's fact and is not touched here.

import type { LiveWindows } from "./journal/live.ts";
import { adapterFor } from "./journal/registry.ts";
import type { JournalAdapter, TranscriptEntry } from "./journal/types.ts";
import { HELD_FRESH_MS } from "./subagents-journal.ts";
import { clipLine, QUIET_RUNNING_MS } from "./subagents.ts";
import { journalAgentOf, type AgentView } from "./types.ts";

/** One background job of a pane's session, running or ended a short while ago. Attached to `AgentView.jobs`. */
export interface PaneJob {
  /** The harness's name for the job (Gentle Shell's `job-1`), else the tool call's id. */
  id: string;
  /** The call's own label or description, on one line and clipped. Empty when the call named none. */
  label: string;
  /** The command it runs, on one line and clipped. */
  command: string;
  /** When it started, ISO 8601: the start result's time, else its turn's. */
  startedAt: string;
  /** The exit code the end notice gave. Absent while it runs and on an end that named none. */
  exitCode?: number;
  /** When it ended, ISO 8601. Absent while it runs. */
  endedAt?: string;
}

/** How long an ended job stays on the list. */
export const RECENT_JOB_MS = 10 * 60_000;
export const MAX_JOBS = 50;
export const JOB_LABEL_MAX = 200;
export const JOB_COMMAND_MAX = 300;

/**
 * The background jobs of a session's turns, as rows: every one still running and every ended one that
 * has an end time, the running first and oldest first, then the ended newest first. Pure; the recent
 * window is {@link recentJobs}'s.
 */
export function journalJobs(entries: readonly TranscriptEntry[]): PaneJob[] {
  const running: PaneJob[] = [];
  const ended: PaneJob[] = [];
  for (const entry of entries) {
    if (entry.abandoned === true) continue;
    entry.parts.forEach((part, index) => {
      if (part.kind !== "tool") return;
      const call = part.call;
      if (call?.kind !== "execute" || call.background !== true) return;
      if (call.ongoing !== true && call.endedAt === undefined) return;
      const started = call.startedAt ?? Date.parse(entry.ts);
      if (!Number.isFinite(started)) return;
      const row: PaneJob = {
        id: call.jobId ?? part.id ?? `${entry.uuid}:${index}`,
        label: clipLine(call.description ?? "", JOB_LABEL_MAX),
        command: clipLine(call.command, JOB_COMMAND_MAX),
        startedAt: new Date(started).toISOString(),
      };
      if (call.ongoing === true) {
        running.push(row);
        return;
      }
      if (call.exitCode !== undefined) row.exitCode = call.exitCode;
      if (call.endedAt !== undefined) row.endedAt = new Date(call.endedAt).toISOString();
      ended.push(row);
    });
  }
  return [...running.toSorted(byStart), ...ended.toSorted(byEndNewest)];
}

/** Oldest start first; the id breaks a tie, so the order never depends on the log's. */
function byStart(a: PaneJob, b: PaneJob): number {
  return a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);
}

/** Newest end first. */
function byEndNewest(a: PaneJob, b: PaneJob): number {
  return (b.endedAt ?? "").localeCompare(a.endedAt ?? "") || a.id.localeCompare(b.id);
}

/** The rows of {@link journalJobs} a reader sees at `now`: an ended one only within {@link RECENT_JOB_MS}. */
export function recentJobs(rows: readonly PaneJob[], now: number): PaneJob[] {
  return rows
    .filter((row) => row.endedAt === undefined || now - Date.parse(row.endedAt) <= RECENT_JOB_MS)
    .slice(0, MAX_JOBS);
}

/** The Jobs mark's one source. Synchronous. */
export class JournalJobs {
  /** Per session, what was derived at a window stamp, so a quiet session costs a map lookup. */
  private readonly memo = new Map<string, { stamp: string; rows: PaneJob[] }>();

  constructor(
    private readonly registry: Record<string, JournalAdapter>,
    private readonly live: Pick<LiveWindows, "held">,
    private readonly now: () => number,
  ) {}

  /** The pane's background jobs, running and recently ended, or undefined when none. Never a `[]`. */
  get(pane: AgentView): PaneJob[] | undefined {
    const ref = pane.agentSession;
    if (ref === undefined) return undefined;
    if (adapterFor(this.registry, journalAgentOf(pane)) === undefined) return undefined;
    const held = this.live.held(ref.value);
    if (held === null) {
      this.memo.delete(ref.value);
      return undefined;
    }
    const at = this.now();
    if (at - held.askedAt > HELD_FRESH_MS) return undefined;
    if (held.writtenAt !== undefined && at - held.writtenAt >= QUIET_RUNNING_MS) return undefined;
    let found = this.memo.get(ref.value);
    if (found?.stamp !== held.stamp) {
      found = { stamp: held.stamp, rows: journalJobs(held.entries()) };
      this.memo.set(ref.value, found);
      // Bounded like the windows it mirrors: a stale key is the oldest, and goes first.
      while (this.memo.size > 32) {
        const oldest = this.memo.keys().next().value;
        if (oldest === undefined) break;
        this.memo.delete(oldest);
      }
    }
    const list = recentJobs(found.rows, at);
    return list.length > 0 ? list : undefined;
  }
}
