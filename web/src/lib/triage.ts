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

/** Which section an agent belongs to. The single classifier — {@link triage} and
 *  {@link worstTriage} both route through it, so a list and a chip can't disagree. */
export function bucketOf(a: AgentView): TriageKey {
  if (a.status === "blocked") return "needs";
  if (isUnseen(a)) return "ready";
  if (a.status === "working") return "working";
  return "recent";
}

/** Display order, most urgent first. */
export const TRIAGE_ORDER: readonly TriageKey[] = ["needs", "ready", "working", "recent"];

/**
 * The status one representative {@link StatusDot} should show for a bucket, so a tab chip, a space
 * chip and a list row all draw the same colour for the same meaning.
 */
export const TRIAGE_STATUS: Record<TriageKey, AgentStatus> = {
  needs: "blocked",
  ready: "done",
  working: "working",
  recent: "idle",
};

/**
 * The most urgent bucket among a set of panes — what a tab or space chip should advertise. Null when
 * the set holds no agent at all, which is deliberately NOT the same as "idle": an empty tab has
 * nothing to report, and showing it a resting dot would claim otherwise.
 */
export function worstTriage(agents: readonly AgentView[]): TriageKey | null {
  let best: number | null = null;
  for (const a of agents) {
    const rank = TRIAGE_ORDER.indexOf(bucketOf(a));
    if (best === null || rank < best) best = rank;
  }
  return best === null ? null : TRIAGE_ORDER[best]!;
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

  const into = { needs, ready, working, recent };
  for (const a of agents) into[bucketOf(a)].push(a);

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

/**
 * The presentation fields a section header needs, in one place. Both the dashboard and the pane
 * switcher spread this rather than picking fields by hand — that's how the dashboard silently ended
 * up without the status-colour bullet the switcher had, and a new field would have done it again.
 */
export function sectionHeaderProps(s: TriageSection) {
  return {
    label: s.label,
    count: s.agents.length,
    dot: s.dot,
    ...(s.accent ? { accent: s.accent } : {}),
  };
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

/** Which of the two timestamps a row's age should read from. */
export type AgeBasis = "seen" | "active";

/**
 * The timestamp a section is ORDERED by — and therefore the only one its rows may be dated with.
 *
 * This lives here, next to the sort, because the two drifting apart is not a cosmetic bug: the
 * switcher dated every row `lastActiveAt` while Recent sorts on `lastSeenAt`, so the age column ran
 * visibly out of order (13m, 13h, 41m, 15h, …) and disagreed with the dashboard by up to 13h about
 * the same pane at the same instant. An age that contradicts the order is worse than no age — it
 * makes a correct list read as broken.
 */
export function ageBasisFor(key: TriageKey): AgeBasis {
  return key === "recent" ? "seen" : "active";
}

/** A pane's age stamp on a given basis. Undefined on an older bridge, which renders no age. */
export function ageStampOf(pane: AgentView, basis: AgeBasis): number | undefined {
  return basis === "seen" ? pane.lastSeenAt : pane.lastActiveAt;
}
