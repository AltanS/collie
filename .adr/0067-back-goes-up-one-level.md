# 0067 — Back goes up one level

- **Status:** Accepted
- **Date:** 2026-09-23
- **Shipped in:** pending
- **Trail:** the operator's report from the installed app on an iPhone: the edge swipe often lands
  on the last screen instead of one level up · `web/src/lib/nav.ts` (`ancestorsOf`, `resolveUp`,
  `resolveUpTo`, `parentChain`) · `web/src/hooks/use-nav.ts` (`useNav`) ·
  `web/src/lib/nav-entry.ts` (`seedColdEntry`, `listenForInAppOpen`, `markInAppBack`) ·
  `web/src/lib/notification-open.ts` (`openInApp`, `askInApp`) ·
  `web/src/components/screen-transition.tsx` · `web/e2e/back-goes-up.spec.ts`

## Context

On iOS the edge swipe is browser history back, and there is no other back on the installed app.
The app wrote history in one way for every move: a push. Switching panes pushed, so a swipe
walked back through every pane you had looked at. The back arrows pushed the parent, so the child
stayed behind it and the next swipe went down into it again. Some arrows picked a fixed parent:
the pane's arrow always went to the dashboard, even from a space, and the workspace Changes arrow
always went to the space, even when the dashboard's Changes tab had opened it. A notification tap
on a cold app opened a history that held the pane alone, so the swipe did nothing. And the app's
own slide played on top of the swipe's animation.

One screen already did it right: the Changes file view steps back to its list when the list
opened it, and replaces otherwise.

## Decision

**The history stack is the level tree, and every navigation is one of three moves.**

The levels: L0 `/`; L1 `/space/:id`, `/settings`, `/crew`; L2 `/pane/:id`, `/space/:id/changes`,
`/settings/updates`; L3 `/pane/:id/history`, `/pane/:id/changes` (a file view adds `?repo=&path=`
and sits under its list). The dashboard's footer tabs are a device preference and write no history.

1. **Down is a push that records where it came from.** `state.from` holds the pathname and query
   the operator left. Opening a pane, a space, History, Changes, Settings, Crew or Updates is down.
2. **Sideways is a replace that carries `from` over.** Pane to pane (switcher, tab strip, closing
   the tab you are in), space chip to space chip, the machine and session switchers, a crew
   member's "go" button. Opening a NEW pane is down from a dashboard or a space and sideways from
   a pane (`useNav().open`).
3. **Up steps back when the entry behind is a legitimate parent, and replaces otherwise.** The
   parent is where you came from when that is an ancestor in the level tree (`ancestorsOf`): a pane
   opened from a space goes up to that space, from the dashboard to the dashboard, and Changes
   opened from the dashboard's Changes tab goes up to the dashboard. Otherwise it is the structural
   parent, as a replace, so the child never stays behind it. Up is never a push. Every back arrow,
   the Collie mark inside a level, History's close and every automatic exit (a pane or a space
   that closed under you) is an up. The pane's space breadcrumb is an up to one NAMED parent
   (`upTo`): it steps back only onto that space, and otherwise replaces, keeping the entry behind
   as the space's own way up when that entry is above the space too.
4. **A cold deep link is seeded once.** Before the router is built, an entry React Router has not
   stamped (no numeric `idx` in `history.state`) that is deeper than `/` gets its parent chain put
   behind it: the current entry is replaced with the root, and each level down to the target is
   pushed again, each stamped `{ usr: { from }, key, idx }` the way the router stamps its own. It
   runs only in the installed app (display-mode standalone or `navigator.standalone`) or in a
   window with nothing behind it (`history.length === 1`, which is what a notification's
   `openWindow` makes). The stamp is the robust test for "cold", because a reload and a
   back-forward keep it, and iOS can open a notification's URL inside an app window that already
   has a length above one. A sessionStorage flag names the URL seeded last, so a reload of it with
   the seed still behind it is never seeded twice.
5. **A notification tapped while the app is on screen opens in the app's own router.** The service
   worker posts `collie:open` to the visible window with a reply port and waits 600 ms. The app
   pushes the target as a down move from wherever it was and acknowledges. A window that does not
   answer (a bundle from before the listener) gets the old `client.navigate`.
6. **A POP draws no slide of ours.** The phone animates its own back. The one POP that keeps the
   slide is the app's back arrow stepping back, which marks the pathname it lands on.
7. **Sheets do not own history.** A swipe with a sheet open leaves the screen under it, sheet and
   all. That stays open: giving a sheet a history entry would make every sheet a level.

## Consequences

- **A swipe and the back arrow agree.** Both land on the level above. The arrow is a step back
  whenever it can be, so after it the child is forward, not behind.
- **A sideways move cannot be undone with back.** Pane B does not go back to pane A; it goes up.
  The switcher is how you return to A.
- **The stack may hold two dashboards** after an up that had to replace (a Settings opened from a
  pane, then its arrow). The swipe from the second one lands on the first, which looks like nothing
  happened. It is rare and it never lands on a child.
- **The seed writes React Router's internal history-state shape** (`usr`, `key`, `idx`). It has
  been stable since React Router 6.4's data routers; a router upgrade that changes it breaks the
  seed quietly, and `web/src/lib/nav-entry.test.ts` pins the shape it writes.
- **The Changes arrow's accessible name says where it actually goes**, computed by the same parent
  resolution as the move itself: "Back to the dashboard" when the dashboard's Changes tab opened it,
  "Back to the workspace" from a cold link or the space itself, "Back to the pane" from within a
  pane.
- **Revisit** if a sheet ever needs to close on the swipe: that is a history entry per sheet, and
  every close path would then have to step back.
