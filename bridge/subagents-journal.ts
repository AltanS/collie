// THE BELT'S AGENTS PILL, FOR A HARNESS WITH NO SUBAGENT FILES.
//
// Claude Code writes one meta file per subagent, and `SubagentTracker` (bridge/subagents.ts) reads
// those. Oh My Pi and Gentle Shell write none: their subagents live in the session's own log, as a
// `task` call whose start result says the work runs on (OMP's `details.async`, Gentle's
// `gentleAgents`) and a later row that ends it. The pi reducer (bridge/journal/pi.ts) already turns
// that into a task card with `ongoing: true` until the end arrives (ADR 0119 and its 2026-10-25
// addendum). This file lists those cards for the pill.
//
// MEMORY ONLY. The cards are read from the live window a Chat poll keeps for the session
// (bridge/journal/live.ts, `LiveWindows.held`), never from disk: nothing here resolves a path, stats
// a file or reads a line. The price is that the pill fills only while a reader polls the session's
// Chat (the default view of an agent pane, ADR 0082), and empties {@link HELD_FRESH_MS} after the
// last poll. A window holds the newest turns only, so a card that left its front leaves the pill too.
//
// STALE CARDS. An ongoing card whose end never arrives (the harness was killed) would stay forever,
// so a card counts only while the session's log was written in the last `QUIET_RUNNING_MS`, the
// bound the Claude list uses for an unfinished meta (bridge/subagents.ts, point 2).
//
// A Claude pane never reaches this list: a source with `subagentDirs` is the meta files' to answer.
//
// The rows carry `transcript: false`: `GET /api/pane/<id>/subagent/<agentId>` serves Claude logs
// only, so the phone draws them without a tap target.

import type { LiveWindows } from "./journal/live.ts";
import { adapterFor } from "./journal/registry.ts";
import type { JournalAdapter, TranscriptEntry } from "./journal/types.ts";
import { clipLine, MAX_SUBAGENTS, type PaneSubagent, QUIET_RUNNING_MS, SUBAGENT_DESCRIPTION_MAX } from "./subagents.ts";
import { journalAgentOf, type AgentView } from "./types.ts";

/** How long after the last Chat poll a window still answers for the pill. Chat polls every 6 s at the slowest. */
export const HELD_FRESH_MS = 30_000;

/** The ongoing task cards of a session's turns, as pill rows, oldest first. Pure. */
export function ongoingSubagents(entries: readonly TranscriptEntry[]): PaneSubagent[] {
  const rows: PaneSubagent[] = [];
  for (const entry of entries) {
    if (entry.abandoned === true) continue;
    entry.parts.forEach((part, index) => {
      if (part.kind !== "tool") return;
      const call = part.call;
      if (call?.kind !== "task" || call.ongoing !== true) return;
      const row: PaneSubagent = {
        agentId: call.jobId ?? part.id ?? `${entry.uuid}:${index}`,
        description: clipLine(call.summary, SUBAGENT_DESCRIPTION_MAX),
        transcript: false,
      };
      if (call.agent !== undefined) row.agentType = clipLine(call.agent, 80);
      const started = Date.parse(entry.ts);
      if (Number.isFinite(started)) row.startedAt = new Date(started).toISOString();
      rows.push(row);
    });
  }
  return rows
    .toSorted((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.agentId.localeCompare(b.agentId))
    .slice(0, MAX_SUBAGENTS);
}

/** The pill's second source, consulted where the Claude list answers nothing. Synchronous. */
export class JournalSubagents {
  /** Per window stamp, what was derived, so a quiet session costs a map lookup. */
  private readonly memo = new Map<string, { stamp: string; list: PaneSubagent[] }>();

  constructor(
    private readonly registry: Record<string, JournalAdapter>,
    private readonly live: Pick<LiveWindows, "held">,
    private readonly now: () => number,
  ) {}

  /** The pane's ongoing journal subagents, or undefined when none. Never a `[]`. */
  get(pane: AgentView): PaneSubagent[] | undefined {
    const ref = pane.agentSession;
    if (ref === undefined) return undefined;
    const adapter = adapterFor(this.registry, journalAgentOf(pane));
    if (adapter === undefined || adapter.source.subagentDirs !== undefined) return undefined;
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
      found = { stamp: held.stamp, list: ongoingSubagents(held.entries()) };
      this.memo.set(ref.value, found);
      // Bounded like the windows it mirrors: a stale key is the oldest, and goes first.
      while (this.memo.size > 32) {
        const oldest = this.memo.keys().next().value;
        if (oldest === undefined) break;
        this.memo.delete(oldest);
      }
    }
    return found.list.length > 0 ? found.list : undefined;
  }
}
