// The dashboard's three views, one per footer tab (ADR 0066): Panes (every pane, grouped by
// workspace), Attention (only the panes that need you, same groups, same order) and Changes (each
// workspace's uncommitted changes). Each tab names what its list holds.
//
// Attention is a FILTER, never a sort (issue 270, ADR 0063): it removes rows and moves nothing.
import type { JsonValue } from "./json";
import type { WorkspaceGroup } from "./pane-groups";
import { needsYou } from "./triage";
import type { AgentView } from "./types";

export const DASH_VIEWS = ["panes", "needs", "changes"] as const;
export type DashView = (typeof DASH_VIEWS)[number];

/** A stored value as a view; anything unknown is the default, Panes. */
export function coerceDashView(raw: JsonValue | undefined): DashView {
  return DASH_VIEWS.find((v) => v === raw) ?? "panes";
}

/** One workspace as a view draws it: the whole group (its heading counts it all) and the rows shown. */
export interface ShownGroup {
  group: WorkspaceGroup;
  rows: readonly AgentView[];
}

/**
 * The rows a view shows under each workspace. `needsOnly` keeps a group's panes whose bucket is in
 * `ATTENTION` and drops a group left with none. Order is untouched: the groups keep theirs, and the
 * rows inside keep theirs. The group itself is passed through whole, so a heading still counts every
 * pane in its workspace, and the filter can never understate the herd.
 */
export function shownGroups(groups: readonly WorkspaceGroup[], needsOnly: boolean): ShownGroup[] {
  if (!needsOnly) return groups.map((group) => ({ group, rows: group.panes }));
  const out: ShownGroup[] = [];
  for (const group of groups) {
    const rows = group.panes.filter(needsYou);
    if (rows.length > 0) out.push({ group, rows });
  }
  return out;
}
