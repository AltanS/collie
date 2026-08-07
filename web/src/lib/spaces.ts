// Helpers for the space/tab navigator: shape the flat snapshot (agents + shell panes + tabs) into
// the per-space, per-tab tree the home space view renders.
//
// ── EVERY SPACE KEY IS (host, workspaceId) ───────────────────────────────────
// A Herdr workspace id is unique only WITHIN one machine, and a merged pack snapshot carries panes
// from several. Keying on the bare id would silently fold two machines' `w1` into one space row:
// one triage dot for two projects, one last-seen time, one tab group. The fix is the key, not a
// filter — see lib/hosts.ts `spaceKey`, which degrades to a pure prefix (`"\0w1"`) on a solo
// snapshot where no pane is host-tagged at all.
import { paneSpaceKey, spaceKey } from "./hosts";
import { bucketOf, TRIAGE_ORDER, type TriageKey } from "./triage";
import type { AgentView, TabView, WorkspaceView } from "./types";

export interface TabGroup {
  tabId: string;
  label: string;
  panes: AgentView[];
}

/**
 * Group a workspace's panes (agents + shells) by tab, in tab order. Panes whose tab isn't in the
 * tab list yet (a brief poll race after a create) fall into a trailing group so they're never lost.
 *
 * `host` is the machine the workspace belongs to (undefined on a solo snapshot, and on the lead-local
 * navigator before the pack tags anything). Panes from any OTHER machine are not in this space, even
 * when they report the same workspace id.
 */
export function groupPanesByTab(
  workspaceId: string,
  tabs: TabView[],
  agents: AgentView[],
  shellPanes: AgentView[],
  host?: string,
): TabGroup[] {
  const key = spaceKey(host, workspaceId);
  const panes = [...agents, ...shellPanes].filter((p) => paneSpaceKey(p) === key);
  const wsTabs = tabs.filter((t) => t.workspaceId === workspaceId);

  const groups: TabGroup[] = wsTabs.map((t) => ({
    tabId: t.tabId,
    label: t.label,
    panes: panes.filter((p) => p.tabId === t.tabId),
  }));

  const known = new Set(wsTabs.map((t) => t.tabId));
  const orphans = panes.filter((p) => !known.has(p.tabId));
  // The orphan group's id is host-qualified too — it is a React key in a list that can hold two
  // machines' spaces, and `w1:other` twice over would collide.
  if (orphans.length) groups.push({ tabId: `${key}:other`, label: "…", panes: orphans });

  return groups;
}

/**
 * The most urgent bucket in each workspace, in ONE pass over the agents.
 *
 * Routes through {@link bucketOf}, the same classifier the herd list and the tab/space chips use —
 * this replaces a pair of helpers that ranked by STATUS_RANK instead, so a space row and its chip
 * could disagree about what a colour meant (a space holding one `working` agent and one unseen
 * `done` one showed "working" on the dashboard and "ready" on the chip). One classifier, one answer.
 *
 * A missing entry means the space holds no agent at all, which is deliberately NOT the same as
 * idle: an empty space has nothing to report, and a resting dot would claim otherwise.
 *
 * One pass rather than per-space filtering because the dashboard re-renders on every poll and used
 * to derive this per space AND again per row — spaces x agents, three times over (45 x 59 on a real
 * herd).
 */
export function spaceTriageMap(agents: readonly AgentView[]): Map<string, TriageKey> {
  const worst = new Map<string, TriageKey>();
  for (const a of agents) {
    const bucket = bucketOf(a);
    const key = paneSpaceKey(a);
    const held = worst.get(key);
    if (held === undefined || TRIAGE_ORDER.indexOf(bucket) < TRIAGE_ORDER.indexOf(held)) {
      worst.set(key, bucket);
    }
  }
  return worst;
}

/**
 * Last-used time for EVERY space in one pass over the panes. The dashboard needs this per space and
 * again per rendered row, and it re-renders on every poll; deriving it per space would be
 * spaces × panes each time (45 × 59 on a real herd, three times over). One pass, then map lookups.
 */
export function spaceLastSeenMap(panes: readonly AgentView[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const p of panes) {
    const at = p.lastSeenAt ?? 0;
    const key = paneSpaceKey(p);
    if (at > (seen.get(key) ?? 0)) seen.set(key, at);
  }
  return seen;
}

/**
 * Most-recently-used spaces first. Never-used spaces (and every space on an older bridge) tie at 0
 * and therefore keep Herdr's own workspace order behind the ones you actually touch — `sort` is
 * stable, so no timestamps means no reordering at all.
 *
 * Pass a prebuilt {@link spaceLastSeenMap} when the caller already has one.
 */
export function sortSpacesByRecency(
  workspaces: readonly WorkspaceView[],
  panes: readonly AgentView[],
  seen: Map<string, number> = spaceLastSeenMap(panes),
  host?: string,
): WorkspaceView[] {
  return [...workspaces].sort(
    (a, b) =>
      (seen.get(spaceKey(host, b.workspaceId)) ?? 0) - (seen.get(spaceKey(host, a.workspaceId)) ?? 0),
  );
}

/**
 * Case-insensitive substring match on the space label. An empty/whitespace query returns the input
 * untouched, so the filter box costs nothing until you type in it.
 */
export function filterSpaces(
  workspaces: readonly WorkspaceView[],
  query: string,
): WorkspaceView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...workspaces];
  return workspaces.filter((w) => w.label.toLowerCase().includes(q));
}
