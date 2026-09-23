// The dashboard's three views, one per footer tab (ADR 0066): Panes (every pane, grouped by
// workspace), Focus (only the panes that need you, same groups, same order) and Changes (each
// workspace's uncommitted changes). Each tab names what its list holds. Focus was named Attention
// until ADR 0068 renamed it and swapped its icon.
//
// Focus is a FILTER, never a sort (issue 270, ADR 0063): it removes rows and moves nothing.
import type { JsonValue } from "./json";
import type { WorkspaceGroup } from "./pane-groups";
import { needsYou } from "./triage";
import type { AgentView } from "./types";

export const DASH_VIEWS = ["panes", "focus", "changes"] as const;
export type DashView = (typeof DASH_VIEWS)[number];

/**
 * A stored value as a view; anything unknown is the default, Panes. `"needs"` is the value a
 * device stored before ADR 0068 renamed the tab (Attention → Focus); `"attention"` is handled the
 * same way in case any build ever wrote the label instead of the internal name. Both read back as
 * `"focus"`, and only `"focus"` is ever written from here on.
 */
export function coerceDashView(raw: JsonValue | undefined): DashView {
  if (raw === "needs" || raw === "attention") return "focus";
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
