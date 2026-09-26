# 0070: A pin is a place the operator chose

- **Status:** Accepted
- **Date:** 2026-09-26
- **Shipped in:** pending
- **Amends:** [ADR 0063](./0063-a-pane-keeps-its-place-when-its-state-changes.md) and
  [ADR 0066](./0066-the-dashboard-has-a-footer-panes-needs-you-changes.md), in scope. No list is
  ordered by status, and the footer, the strip and the summary line stand. A pane gains one more
  place, the one the operator pins it to, and Focus is no longer empty under its all-clear.
- **Trail:** GitHub issue 286 (@wwilson1017: pin a pane to the top of every tab, stored in
  `collie:dash-prefs:v1` as `pinnedPanes` keyed by `paneRowKey`, with a Pinned group on Changes and
  a one-row hold sheet; open questions: key by label too, and a cap) · options A2 (same order), B1,
  C1 and D1 picked 2026-09-26 · `web/src/lib/pins.ts` · `web/src/lib/dash-view.ts` ·
  `web/src/components/agent-list.tsx` · `web/src/components/agent-sidebar.tsx` ·
  `web/src/components/pane-actions-sheet.tsx` · `web/src/components/agent-card.tsx` ·
  `web/src/hooks/use-dash-prefs.ts` · `bridge/mux/identity.ts`

## Context

ADR 0063 put every pane in its workspace group, in the multiplexer's order, so a pane is found by
where it sits. Some panes are opened many times an hour wherever they sit. The clearest case is an
orchestrator that drives the others. On a 40-pane herd across 8 workspaces it means a scroll, or an
isolate and an un-isolate. Focus does not help, because an orchestrator is idle or working, not
blocked.

Issue 286 proposed a Pinned group on every footer tab, stored beside `hiddenSpaces` and keyed by
`paneRowKey`. Three facts in the code changed that shape. `useDashPrefs` is per-instance state that
saves its own copy, and four instances mount at once, so a pin written by the pane menu would be
lost at the next `shellsOpen` save from another instance. A pane id is unique only for one bridge
process (`identity.ts` rule 4): a new tmux server counts from `%0` again, Herdr reuses ids as
workspaces come and go (`mirror-invert.ts`), and the snapshot carries no epoch, so the phone cannot
see a restart. And the Changes tab lists workspaces, and a pane's changes are its workspace's.

## Decision

**A pin is a place the operator chose, never a state. Pinned panes lead the Panes, Focus and
Changes lists and the switcher, in place order, each listed once, on this device only.**

1. **A pinned pane leads.** A Pinned group sits at the top of the list, under the summary line, on
   Panes, Focus and Changes, and a Pinned section leads the switcher. It ignores the workspace
   filter and the Focus filter. The strip and the summary line keep their place on every tab. On
   Changes a pinned row is a pane that opens the pane, in the same place order as on Panes and
   Focus; the workspace rows below keep their change rows unchanged, whether or not one of their
   panes is pinned.
2. **Listed once, counted everywhere.** A pinned row leaves its workspace group. The summary line,
   the workspace headings, their dots and the strip chips count every pane, pinned or not. The
   Pinned heading counts nothing, so no two headings count one pane.
3. **Place order inside Pinned.** Machine, workspace number, tab number, position in the tab,
   the dashboard's own order. Status never moves a pinned row. Pin order without a drag handle is
   only the time of the pin, which the screen never shows.
4. **One menu.** The Pin to top / Unpin row lives in the pane's actions sheet, reached by a hold on
   a dashboard row, a hold on the pane pill, or the pane header's ⋮. On a dashboard row's hold the
   sheet opens with Pin to top / Unpin first, then Rename, Show in terminal and Close. It sits
   outside the read-only and host-write gates, because a pin writes nothing to any machine. No
   control goes on the pane header and no glyph goes on a row.
5. **Keyed by the row and the workspace name.** A pin applies to the live pane with its
   `paneRowKey` only while that pane sits in a workspace of the pinned name. A pin whose pane is
   absent is dormant and draws nothing. Absence never prunes, because a restart that keeps ids can
   pass through a listing without the pane.
6. **Pruned only by the operator's acts.** Unpin and Close from Collie remove a pin. Each write
   drops pins whose key now names a pane in another workspace and keeps at most 32 records, oldest
   dormant first. The store never writes on a poll.
7. **Per device, in its own store.** `collie:pins:v1`, a module store read with
   `useSyncExternalStore`, never a field in `collie:dash-prefs:v1` and never on the wire.
8. **No cap.** Many pins cost list room and nothing else.

## Consequences

- **A restart that reuses ids can hand a pin to a new pane** in a workspace of the same name (a
  new tmux server, a new zellij or Herdr session). The row shows its own name, a tap opens that
  pane, and one Unpin fixes it. Revisit with a multiplexer epoch on the wire, which would let a pin
  die with the process that minted its id.
- **Renaming a workspace unpins its panes,** and forming or leaving a crew re-keys every row, so
  pins made before stay dormant. Hide and isolate behave the same way.
- **Focus under the all-clear is no longer empty when pins exist.** ADR 0066 §2 said the all-clear
  is the whole answer; with pins, the Pinned group sits under it.
- **Two devices disagree by design.** A phone and a tablet pin what their own thumb needs.
- **A pinned pane on a peer the lead has not heard since it started is not drawn** until the peer
  answers, because the snapshot lists no pane for it.
- **Revisit** if operators ask to order pins themselves (drag), or if a Pinned group routinely
  pushes every workspace off the first screen (then a cap).
