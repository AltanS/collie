// The one ordering the whole app agrees on: what needs you, then what's newly ready, then what's
// running, then everything else by when you last touched it. Used by the dashboard, the in-pane
// sidebar and the command palette — kept in one place so those three can't drift apart (which is
// the job the module this replaces, agent-groups.ts, was written to do).
//
// It runs on the two timestamps the bridge keeps per pane (bridge/activity.ts):
//   lastActiveAt — when the agent last changed status
//   lastSeenAt   — when you last opened or drove it through Collie
import type { AgentStatus, AgentView } from "./types";

/** Which way the Recent section runs. Attention sections never invert. */
export type RecentDir = "newest" | "oldest";

export type TriageKey = "needs" | "ready" | "working" | "recent";

export interface TriageSection {
  key: TriageKey;
  label: string;
  /** Render the heading in the alert colour (the "needs you" group). */
  accent?: boolean;
  /** Section bullet class — the same status palette the badges use, so a section's colour can't
   *  drift from the status it collects. */
  dot: string;
  /** Whether the user may fold this section away. Attention sections may not: collapsing an alert
   *  defeats the alert. */
  collapsible?: boolean;
  agents: AgentView[];
}

/**
 * An agent that finished while you weren't looking. NOT a stored flag — it's this comparison, which
 * is why opening the pane clears it with no bookkeeping: the read bumps `lastSeenAt` past
 * `lastActiveAt` and the agent falls into Recent on the next poll.
 *
 * Both timestamps absent (an older bridge) yields `false`, so the section is simply empty there.
 */
export function isUnseen(a: AgentView): boolean {
  return a.status === "done" && (a.lastActiveAt ?? 0) > (a.lastSeenAt ?? 0);
}

/** Descending comparator over an optional timestamp; absent sorts last but ties, never throws. */
function byDesc(key: (a: AgentView) => number | undefined) {
  return (x: AgentView, y: AgentView) => (key(y) ?? 0) - (key(x) ?? 0);
}

const SECTION_META: Record<TriageKey, Omit<TriageSection, "agents">> = {
  needs: { key: "needs", label: "Needs you", accent: true, dot: "bg-status-blocked" },
  ready: { key: "ready", label: "Ready · unseen", dot: "bg-status-done" },
  working: { key: "working", label: "Working", dot: "bg-status-working" },
  recent: { key: "recent", label: "Recent", dot: "bg-status-idle", collapsible: true },
};

/**
 * Bucket and order a herd. Returns every section (including empty ones) in fixed display order —
 * callers drop the empties, which keeps "which sections exist" a property of this module rather
 * than something each view re-derives.
 *
 * The first three sections are pinned: they never move and never invert. `dir` reaches Recent only.
 *
 * **The old-bridge path is free.** With no timestamps every comparator returns 0, and
 * `Array.prototype.sort` is stable, so each section preserves the order the bridge already sent
 * (`STATUS_RANK → workspaceNumber → paneId`). Ready·unseen is empty because `isUnseen` is false.
 * No feature detection, no branch.
 */
export function triage(agents: readonly AgentView[], dir: RecentDir = "newest"): TriageSection[] {
  const needs: AgentView[] = [];
  const ready: AgentView[] = [];
  const working: AgentView[] = [];
  const recent: AgentView[] = [];

  for (const a of agents) {
    if (a.status === "blocked") needs.push(a);
    else if (isUnseen(a)) ready.push(a);
    else if (a.status === "working") working.push(a);
    else recent.push(a);
  }

  needs.sort(byDesc((a) => a.lastActiveAt));
  ready.sort(byDesc((a) => a.lastActiveAt));
  working.sort(byDesc((a) => a.lastActiveAt));
  recent.sort(byDesc((a) => a.lastSeenAt));
  if (dir === "oldest") recent.reverse();

  return [
    { ...SECTION_META.needs, agents: needs },
    { ...SECTION_META.ready, agents: ready },
    { ...SECTION_META.working, agents: working },
    { ...SECTION_META.recent, agents: recent },
  ];
}

/** The other direction — for the toggle. */
export function flipDir(dir: RecentDir): RecentDir {
  return dir === "newest" ? "oldest" : "newest";
}

/** Statuses that put an agent in an attention section (so a caller can tint a row without
 *  re-deriving the rule). */
export function isAttention(status: AgentStatus): boolean {
  return status === "blocked";
}
