// The dashboard's three views, one per footer tab (ADR 0085): Dashboard (every pane, grouped by
// workspace), Crew (the machines, drawn only when a crew is configured) and Changes (each workspace's
// uncommitted changes). Each tab names what its list holds. The old Focus tab (ADR 0066, 0068) is now
// a switch in the summary line, `DashPrefs.needsYouOnly`, and filters the Dashboard list.
//
// The needs-you filter is a FILTER, never a sort (issue 270, ADR 0063): it removes rows and moves
// nothing.
//
// Pinned panes lead all of them under the summary line (ADR 0070), in place order, and leave their
// workspace group on the Dashboard so each pane is listed once.
//
// A hidden machine (lib/hidden-machines.ts, issue #288) leaves the lists too, and its workspace chips
// give way to one stand-in chip in the strip (`stripEntries`).
import { hostKey } from "./hosts";
import type { JsonValue } from "./json";
import type { WorkspaceGroup } from "./pane-groups";
import { needsYou } from "./triage";
import type { AgentView } from "./types";

export const DASH_VIEWS = ["dashboard", "crew", "changes"] as const;
export type DashView = (typeof DASH_VIEWS)[number];

/**
 * The values a device stored before ADR 0085 turned the Focus tab into a switch. `"panes"` is the old
 * first tab; `"focus"` is the old second tab, with `"needs"` and `"attention"` its earlier names
 * (ADR 0066, 0068). All four read as the Dashboard now.
 */
const LEGACY_VIEWS = ["panes", "focus", "needs", "attention"] as const;
const LEGACY_FOCUS_VIEWS = ["focus", "needs", "attention"] as const;

/** Whether a stored value is one of the retired tab names, so the blob wants rewriting. */
export function isLegacyDashView(raw: JsonValue | undefined): boolean {
  return LEGACY_VIEWS.some((v) => v === raw);
}

/** Whether a stored value is the retired Focus tab, which a migration turns into the needs-you switch. */
export function wasFocusView(raw: JsonValue | undefined): boolean {
  return LEGACY_FOCUS_VIEWS.some((v) => v === raw);
}

/**
 * A stored value as a view; anything unknown is the default, Dashboard. A retired name reads as the
 * Dashboard (see {@link isLegacyDashView}). `"crew"` is kept as stored even where no crew is
 * configured: the route shows the Dashboard then and never overwrites the stored value.
 */
export function coerceDashView(raw: JsonValue | undefined): DashView {
  return DASH_VIEWS.find((v) => v === raw) ?? "dashboard";
}

/** One workspace as a view draws it: the whole group (its heading counts it all) and the rows shown. */
export interface ShownGroup {
  group: WorkspaceGroup;
  rows: readonly AgentView[];
}

const NOT_PINNED: (pane: AgentView) => boolean = () => false;

/**
 * The rows a view shows under each workspace. `needsOnly` keeps a group's panes whose bucket is in
 * `ATTENTION`; `pinned` takes out the panes the Pinned group already lists (ADR 0070), so each pane
 * is listed once. A group left with no rows is dropped. Order is untouched: the groups keep theirs,
 * and the rows inside keep theirs. The group itself is passed through whole, so a heading still
 * counts every pane in its workspace, pinned or not, and neither filter can understate the herd.
 */
export function shownGroups(
  groups: readonly WorkspaceGroup[],
  needsOnly: boolean,
  pinned: (pane: AgentView) => boolean = NOT_PINNED,
): ShownGroup[] {
  if (!needsOnly && pinned === NOT_PINNED) return groups.map((group) => ({ group, rows: group.panes }));
  const out: ShownGroup[] = [];
  for (const group of groups) {
    const rows = group.panes.filter((p) => !pinned(p) && (!needsOnly || needsYou(p)));
    if (rows.length > 0) out.push({ group, rows });
  }
  return out;
}

/**
 * The Pinned group's rows (ADR 0070), in PLACE ORDER: the groups flattened as they run (machine,
 * workspace number, tab number, position in the tab), keeping the pinned panes. Hand it every group,
 * BEFORE isolate and hide apply, because a pin means "always show me this one". It never reads
 * status, so no state change moves a pinned row, and the dashboard and the switcher agree by
 * construction. The time of the pin is not an order: the screen never shows it.
 */
export function pinnedRows(
  groups: readonly WorkspaceGroup[],
  pinned: (pane: AgentView) => boolean,
): AgentView[] {
  return groups.flatMap((g) => g.panes).filter(pinned);
}

/** The machine a workspace group sits on: its panes' `hostKey`, `""` when solo. A group is never empty. */
export function groupHost(group: WorkspaceGroup): string {
  return hostKey(group.panes[0]);
}

/** One chip of the workspace strip: a workspace, or the one stand-in for a hidden machine. */
export type StripEntry =
  | { kind: "space"; group: WorkspaceGroup }
  | { kind: "machine"; host: string; panes: AgentView[] };

/**
 * The workspace strip's chips, in the list's own order (issue #288). A workspace on a shown machine
 * keeps its chip. A hidden machine's workspace chips give way to ONE stand-in entry, at the place its
 * first workspace held, carrying every pane of that machine so the chip can show the worst dot:
 * hiding a machine never silences it. A workspace that is isolated keeps its chip right after its
 * machine's stand-in, because isolate wins over the machine filter. A hidden machine with no
 * workspace has no stand-in: there is nothing to hide. Nothing here reads status for ORDER.
 */
export function stripEntries(
  groups: readonly WorkspaceGroup[],
  hiddenMachines: ReadonlySet<string>,
  isolatedKey: string | undefined,
): StripEntry[] {
  if (hiddenMachines.size === 0) return groups.map((group) => ({ kind: "space", group }));
  const out: StripEntry[] = [];
  const standIns = new Map<string, AgentView[]>();
  for (const group of groups) {
    const host = groupHost(group);
    if (!hiddenMachines.has(host)) {
      out.push({ kind: "space", group });
      continue;
    }
    let panes = standIns.get(host);
    if (panes === undefined) {
      panes = [];
      standIns.set(host, panes);
      out.push({ kind: "machine", host, panes });
    }
    panes.push(...group.panes);
    if (group.key === isolatedKey) out.push({ kind: "space", group });
  }
  return out;
}
