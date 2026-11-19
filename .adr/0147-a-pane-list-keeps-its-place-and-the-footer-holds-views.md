# 0147: A pane list keeps every pane in its place, and the dashboard's footer holds views

- **Status:** Accepted (2026-11-16). Amended in scope by [ADR 0158](./0158-the-large-screen-dashboard-repeats-what-needs-you-in-a-band.md): a band on the large-screen dashboard, and a grid there.
- **Date:** 2026-11-16
- **Supersedes:** ADR 0063, ADR 0066, ADR 0068, ADR 0070, ADR 0071, ADR 0085
- **Retires:** ADR 0069 (rule in `web/src/lib/glide.ts`)
- **Trail:** the old triage sort that led every list with status (commit a039e277, ADR 0063), issue
  270 (a needs-you view as a third state of the workspace strip), the `dashboard-nav` and
  `attention-icon` rounds, issue 286 (a pin as a field in the dashboard prefs), the operator's request
  for activity order (ADR 0071), the owner's calls of 2026-10-05 (Focus becomes a switch), 2026-10-07
  ("one control bar") and 2026-11-10 (the pick A5), issues 288 and 527. Files:
  `bridge/state-engine.ts`, `bridge/crew/merge.ts`, `web/src/components/agent-list.tsx`,
  `web/src/lib/dash-view.ts`, `web/src/lib/pins.ts`, `web/src/lib/pane-order.ts`,
  `web/src/hooks/use-frozen-ranks.ts`, `web/src/hooks/use-dashboard-bar.ts`

## Context

The dashboard and the pane switcher list every pane of the crew. The first list put blocked panes on
top and sorted again on every poll, while the thumb was already moving: a wrong tap opens another
terminal. Six records shaped the lists and the footer, and three titles name tabs that are gone.

## Decision

1. **No list is ordered by status.** A pane's place is its machine (the lead first, then members by
   id), its space number, its tab and its position in the tab. The bridge sends that order, and each
   surface computes it again, so an older peer that sends status order cannot move a row. `triage()`
   decides every mark and count, never a position.
2. **Urgency is a mark.** A row takes a wash, its workspace heading a dot and a count, and one summary
   line, the same on the dashboard and the switcher, counts the herd and jumps to the first urgent row.
3. **A list under a finger holds still.** While a finger is down on the dashboard list, and 300 ms
   after the last lift, a pane that arrives or leaves waits, and so does the needs-you answer. A row's
   status, name and counts still repaint at once.
4. **The operator may ask for Activity or Cache order, and the clock is read once.** Place is the
   default, and an unknown stored value reads as place. One value per device, written by the
   switcher's toggle, the dashboard's order select and Settings > Appearance. A reading is taken on
   mount, on a change of order, on the switcher's tap on the selected order, when the dashboard page
   becomes visible again, and once when the first reading saw no panes. Never on a poll. A pane the
   reading does not know ranks last. Activity reads the later of the agent's last transition and the
   operator's last open; Cache ranks the soonest expiry first and a pane with nothing to lose last. A
   ranked order is one flat list under one heading: the workspace headings and the Shells fold give
   way, and each row names its space and tab.
5. **Filters choose rows and never order them.** The workspace filter (several workspaces), hidden
   workspaces and machines, the needs-you switch and the session filter run first. A group with no row
   left is dropped; a heading that is drawn still counts its whole workspace.
6. **A pin is a place the operator chose.** One Pinned group leads the Dashboard, the Files tab and
   the switcher, in place order (ranked inside itself in a ranked order), drawn from every workspace
   before the workspace filter, hide and the needs-you switch. A pinned pane leaves its workspace
   group, its workspace still counts it, and the Pinned heading counts nothing. Pins live on this
   device in their own store, never in the dashboard prefs and never on the wire, keyed by the pane's
   row key and its workspace name. A pin whose pane is absent is dormant; only Unpin, Close from
   Collie, a key reused in another workspace and a bound of 32 records remove one. The Pin row is the
   last read row of the actions sheet (the first on a row's hold), outside the read-only gates,
   because a pin writes nothing to a machine. The list has no cap.
7. **The footer holds views, never a filter.** Crew (only while a crew is configured), Dashboard (the
   default), Files (only on a machine with a screen), then the Hill where the snapshot has a hill, then
   the tricks' `tabbar` items. The Hill opens its own route one level down and is never the selected
   tab. The footer is drawn when it holds more than the Dashboard tab. The tab is a per-device choice
   and writes no history; a stored Crew with no crew, or Files with no screen, shows the Dashboard and
   keeps the stored value. The dashboard is one centred column at every width.
8. **Needs you is a switch at the end of the summary line** (`needsYouOnly`, per device, off by
   default), a filter on rule 5's terms: a group keeps its panes in `ATTENTION`, and with nothing
   urgent the all-clear line is the whole answer. The launch strip, the Spaces navigator and the pin
   hint show only while it is off. On Files the switch and the order select are invisible slots, so a
   tab change moves nothing.
9. **The Dashboard tab's corner mark** is the red count of blocked panes, else a quiet dot for a
   finished pane nobody opened, else nothing, in one slot. A red count means something waits on the
   operator: the Hill's counts its open Decisions, and a trick's badge is never red.
10. **Crew lists machines, Files lists workspaces.** Crew draws no pane chrome (no summary line,
    controls or Pinned group) and mounts only while selected. Files shows each workspace's change
    counts, read every 5 s, at most three at once, only while the tab is on screen and visible.
11. **No one loses their view.** A stored `panes` reads as Dashboard; `focus`, `needs` or `attention`
    read as Dashboard with the switch on, and the blob is written back once.
12. **The footer stays on the Hill and on a trick's Session**, from the same reading, with no tab
    selected. A tab there stores its view and goes up to the Dashboard (ADR 0067); the Hill and trick
    items move sideways; the route's own item does nothing. It hides while the keyboard is up.

## Today in the code

- Rule 1: `byPlace` (`bridge/state-engine.ts`); `placeSorted`, `hostRank` (`bridge/crew/merge.ts`);
  `groupPanesByWorkspace` with `order: "fixed"` in `AgentList` and `components/agent-sidebar.tsx`.
- Rule 2: `StatusSummaryLine` (`components/status-counts.tsx`) in both lists; `jumpPlain` (`AgentList`).
- Rule 3: `useStillList`, `STILL_QUIET_MS` 300, `STILL_MAX_HOLD_MS` 5000 (`hooks/use-still-list.ts`);
  `frozenNeeds` in `AgentList`.
- Rule 4: `coercePaneOrder`, `activityAt`, `coldAt`, `activityRanks`, `cacheRanks`, `inRankOrder`
  (`lib/pane-order.ts`); `useFrozenRanks` with `rereadOnVisible` on the dashboard only;
  `DashPrefs.paneOrder`; `PaneOrderToggle`, `PaneOrderSelect`, `PaneOrderControl`.
- Rule 5: `shownGroups` (`lib/dash-view.ts`); `WorkspaceFilter` (`components/dash-selects.tsx`);
  `machinesHiddenFrom`; `matchPanes` (`lib/pane-filter.ts`), `PANE_FILTER.order` "place" (`AgentList`).
- Rule 6: `collie:pins:v1`, `MAX_PINS`, `pinMatcher`, `setPinned`, `dropPin` and the file header
  (`lib/pins.ts`); `pinnedRows`; `togglePin` and the Close path (`components/pane-actions-sheet.tsx`).
- Rules 7 and 9: `dashboardBarShown`, `useDashboardBar`; `DashboardTabBar` (`badge`, `dot`,
  `home.tabs.blocked`, `home.tabs.unseen`); `TabBarLink`, `TabBarExtraItem` (`ui/tab-bar.tsx`);
  `DASH_VIEWS`, `coerceDashView`.
- Rule 8: `NeedsYouSwitch`; `switchSlot`, `orderSlot` (`AgentList`); the `needsYouOnly` gates in
  `routes/home.tsx`; `e2e/dashboard-footer.spec.ts`.
- Rule 10: `CrewTab` under `view === "crew"` (`routes/home.tsx`); `CHANGES_POLL_MS`
  (`hooks/use-visible-interval.ts`), `CHANGE_COUNT_CONCURRENCY` (`use-workspace-change-counts.ts`).
- Rule 11: `isLegacyDashView`, `wasFocusView`, `loadPrefs`. Rule 12: `DashboardRouteBar`.

## Recorded, not found in the code

- The Revisit lines of 0063, 0070 (a drag order, a cap) and 0071, which no code can hold.

## Consequences

- A blocked pane at the foot of a long list stays there; the summary line, the wash, push and the
  badge carry the alarm. A list in Activity order can be a few seconds stale, by design.
- A restart that reuses pane ids can hand a pin to a new pane in a workspace of the same name; one
  Unpin fixes it. Renaming a workspace leaves its pins dormant. Two devices pin differently.
- The footer costs 56 px plus the safe area, and the Files tab a git status per workspace every 5 s.

## What we tried before

- 0063: the triage sort left every list; place order, and urgency as a mark. Its argument is rule 1.
- 0066, 0068: the footer read Panes, Attention (then Focus, with `CircleDot`), Changes; a bell read as
  a notification, and "Needs you" and "Attention" claimed that something always waited.
- 0085: Focus became a switch, Panes became Dashboard, Crew joined, Changes became Files, the controls
  became two selects, and the Hill took the right end.
- 0070: a pin as a field in the dashboard prefs lost writes between four mounted copies.
- 0071: an activity order read again on every poll would be 0063's fault; the reading is frozen.
