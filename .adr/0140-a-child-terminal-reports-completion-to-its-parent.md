# 0140 — A child terminal reports completion to its parent

- **Status:** Proposed
- **Date:** 2026-11-12
- **Shipped in:** pending
- **Trail:** Herdr App built-in `agents` mod (`mods/agents/main.js`, `kidStatus`) and `AGENTS.md` §
  *Sub-agents* · `bridge/mux/herdr-core/client.ts` · `bridge/mux/herdr-core/layout.ts` ·
  `bridge/state-engine.ts` · `bridge/notifications.ts` · `web/src/lib/triage.ts` ·
  `web/src/lib/pane-tree.ts` · `web/src/lib/pane-ordinal.ts`

## Context

On `herdr-core`, an agent inside terminal `t1` can start background sub-agent workers with
`hc run --bg --parent t1`. The core records `"parent": "t1"` on each child terminal, and Herdr App
treats those terminals as sub-agents belonging to their parent's tab without a split pane of their
own (`AGENTS.md` § *Sub-agents*).

When Collie carries `parentPaneId` onto `MuxPane` and `AgentView` and nests live children under their
parent in the dashboard, space view and pane switcher, two ways exist to classify a child worker that
finishes its turn:

1. **Treat every child terminal as an independent completion** — light the filled unseen square
   (`isUnseen`), keep the green `done` disc, count the child in the header's unseen tally, and send a
   `done` Web Push notification before the parent has reviewed the child's output.
2. **Follow Herdr App's sub-agent rule** — in Herdr App's `agents` sidebar (`mods/agents/main.js`),
   `kidStatus` maps `s === "done" ? "idle" : s` with the rationale: *"It's never done: it reports to
   its parent, and the parent's done is the news."* Only `blocked` (and `error`) count as urgent.

Under option 1, a parent session that dispatches three workers fires three intermediate "is done"
pushes and leaves three unread squares in the list while each worker is merely waiting for the parent
session to review and finish. The human's turn arrives when the parent itself settles, or earlier
only if a child blocks on a permission or question prompt.

## Decision

**While a child pane's parent is live on the same machine and session (`parentPaneId !== undefined`),
its completion reports to its parent rather than to the phone; a blocked child still alerts.**

1. **Live local parent only (`bridge/mux/herdr-core/layout.ts`).** `parentPaneId` is emitted only
   when `terminal.parent` names another live local terminal in the same snapshot with no cycle. If
   the parent exits, is missing or sits on another machine, `parentPaneId` is omitted and the orphan
   behaves like any top-level pane, including unread marks and completion pushes.
2. **Shared place without crowding the in-pane strip (`unpaned`).** An unlabelled child terminal
   inherits its nearest labelled live ancestor's `spaceId` and `tabId` instead of falling into the
   implicit `herdr-core` space, and carries `unpaned: true` so it neither strips its parent's
   `soleTabName` (`bridge/state-engine.ts`) nor crowds `PaneStrip` while viewing the parent
   (`web/src/lib/pane-ordinal.ts`). Opening the child itself shows the parent beside it in
   `PaneStrip` for one-tap return.
3. **No unread mark and no `done` push while the parent lives (`web/src/lib/triage.ts`,
   `bridge/notifications.ts`).** `isUnseen` returns `false` when `parentPaneId !== undefined`, which
   also rests `shownStatus("done")` and `StatusCounts` as `idle`. `NotificationCoordinator.onTransition`
   suppresses `done` (including `working → idle`) pushes when `parentPaneId !== undefined` while
   still resolving any prior `blocked` alert on that child. `blocked` transitions on a child still
   push, count as `needs`, and surface on the parent's fold badge when collapsed.
4. **Expanded by default, foldable per device (`web/src/lib/pane-tree.ts`).** Matching Herdr App,
   parent rows start expanded with `├` / `└` / `│` guides and offer a sibling disclosure button that
   remembers folded parents in `collie:folded-parents:v1` and shows the most urgent descendant state
   while collapsed.

## Consequences

- **Opening a finished child worker is optional.** You do not have to tap each sub-agent merely to
  clear unread squares; the parent's own completion carries the unread square and push.
- **A child whose parent was killed first is never silenced.** Once the parent leaves `live`,
  `parentPaneId` disappears on the next snapshot and the surviving worker notifies on its own.
- **Revisit if `hc` gains detached background jobs that never report back to their starter**, where
  an explicit label or `no_parent` flag does not already distinguish them.
