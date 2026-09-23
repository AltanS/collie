// Helpers for the space/tab navigator: shape the flat snapshot (agents + shell panes + tabs) into
// the per-space, per-tab tree the home space view renders.
//
// ── EVERY SPACE KEY IS (host, workspaceId) ───────────────────────────────────
// A Herdr workspace id is unique only WITHIN one machine, and a merged crew snapshot carries panes
// from several. Keying on the bare id would silently fold two machines' `w1` into one space row:
// one triage dot for two projects, one last-seen time, one tab group. The fix is the key, not a
// filter — see lib/hosts.ts `spaceKey`, which degrades to a pure prefix (`"\0w1"`) on a solo
// snapshot where no pane is host-tagged at all.
import { paneSpaceKey, spaceKey } from "./hosts";
import { byPlaceInTab } from "./pane-groups";
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
 * Inside a tab: its agents, then its shells, each by their position in the tab ({@link byPlaceInTab}).
 * This used to keep the order the lists arrived in, and the bridge sent agents status-first, so a
 * pane that blocked jumped to the head of its tab and back when it resumed (ADR 0063). The order is
 * recomputed here so no arrival order can move a row.
 *
 * `host` is the machine the workspace belongs to (undefined on a solo snapshot, and on the lead-local
 * navigator before the crew tags anything). Panes from any OTHER machine are not in this space, even
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
  const here = (p: AgentView) => paneSpaceKey(p) === key;
  const panes = [
    ...agents.filter(here).toSorted(byPlaceInTab),
    ...shellPanes.filter(here).toSorted(byPlaceInTab),
  ];
  // Same "untagged is ambient" rule as ambientPanes/findPane (lib/hosts.ts): a tab addressed on this
  // host matches when it carries that host's own tag OR no tag at all, so a solo snapshot — where no
  // tab is host-tagged — keeps grouping exactly as it always did.
  const wsTabs = tabs.filter(
    (t) => t.workspaceId === workspaceId && (t.host === undefined || t.host === host),
  );

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
 * Last-used time for EVERY space in one pass over the panes. The dashboard SHOWS this on each row
 * (it no longer sorts by it — lib/../components/space-overview.tsx) and re-renders on every poll;
 * deriving it per space would be spaces × panes each time (45 × 59 on a real herd). One pass, then
 * map lookups.
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

/**
 * One row of the spaces list: a space, plus how deep it sits.
 *
 * `depth: 1` is a worktree shown under the space that holds its repo. It is a VIEW fact, computed
 * per render, and deliberately not a field on the space: whether a worktree has a parent to sit
 * under depends on what is open right now, which is not something a space can know about itself.
 */
export interface SpaceRow {
  readonly space: WorkspaceView;
  readonly depth: 0 | 1;
}

/**
 * Nest each worktree under the space showing its repo, keeping the list's incoming order.
 *
 * THREE RULES, and each answers a case the flat list never had:
 *
 *  • **A group takes the position of its first member.** A worktree that sorts ahead of its parent
 *    pulls the whole group up to where it sits, so no row is ever moved past a row it was sent
 *    ahead of.
 *  • **A worktree whose repo is not open stays at depth 0.** There is no row to indent under, and
 *    indenting under nothing reads as a rendering bug.
 *  • **Order within a group is the incoming order**: the parent first, then its worktrees as they
 *    arrived.
 *
 * `ordered` must already be in the order the caller wants — the bridge's own space-number order, on
 * every caller today; this function only regroups, never re-sorts.
 */
export function nestWorktrees(ordered: readonly WorkspaceView[]): SpaceRow[] {
  // Only a space that IS the repo's own checkout can be a parent (`isWorktree === false`).
  const parentByRepo = new Map<string, WorkspaceView>();
  for (const space of ordered) {
    if (space.repoRoot !== undefined && space.isWorktree === false) {
      parentByRepo.set(space.repoRoot, space);
    }
  }

  const childrenByParent = new Map<string, WorkspaceView[]>();
  for (const space of ordered) {
    if (space.repoRoot === undefined || space.isWorktree !== true) continue;
    const parent = parentByRepo.get(space.repoRoot);
    if (parent === undefined) continue; // orphan — rendered flat, below
    const kin = childrenByParent.get(parent.workspaceId) ?? [];
    kin.push(space);
    childrenByParent.set(parent.workspaceId, kin);
  }

  const rows: SpaceRow[] = [];
  const placed = new Set<string>();
  for (const space of ordered) {
    if (placed.has(space.workspaceId)) continue;
    const kin = childrenByParent.get(space.workspaceId);
    // A parent reached through its own position, or dragged up here by a child that came first.
    if (kin !== undefined) {
      rows.push({ space, depth: 0 });
      placed.add(space.workspaceId);
      for (const child of kin) {
        rows.push({ space: child, depth: 1 });
        placed.add(child.workspaceId);
      }
      continue;
    }
    // A child met before its parent: emit the whole group HERE, at the child's (fresher) position.
    if (space.repoRoot !== undefined && space.isWorktree === true) {
      const parent = parentByRepo.get(space.repoRoot);
      if (parent !== undefined && !placed.has(parent.workspaceId)) {
        rows.push({ space: parent, depth: 0 });
        placed.add(parent.workspaceId);
        for (const child of childrenByParent.get(parent.workspaceId) ?? []) {
          rows.push({ space: child, depth: 1 });
          placed.add(child.workspaceId);
        }
        continue;
      }
    }
    rows.push({ space, depth: 0 });
    placed.add(space.workspaceId);
  }
  return rows;
}
