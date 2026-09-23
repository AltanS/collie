# 0066 — The dashboard has a footer: Panes, Attention, Changes

- **Status:** Accepted
- **Amended in scope by:** [ADR 0068](./0068-the-second-tab-is-focus-not-attention.md) — the second
  tab is renamed Focus and wears `CircleDot`; everything else below stands.
- **Date:** 2026-09-23
- **Shipped in:** pending
- **Trail:** GitHub issue 270 (@simplysoft: a `Needs you` chip on the workspace strip, persisted as
  `attentionOnly`) · the playground's `dashboard-nav` round, four numbered options (commit
  186e777d), option 1 picked with two corrections · `web/src/components/ui/tab-bar.tsx` ·
  `web/src/routes/home.tsx` · `web/src/components/agent-list.tsx` (`needsYouOnly`, `renderBody`) ·
  `web/src/lib/dash-view.ts` (`shownGroups`) · `web/src/lib/triage.ts` (`ATTENTION`, `needsYou`, `countBlocked`, `hasReady`) ·
  `web/src/components/workspace-changes-list.tsx` · `web/src/hooks/use-workspace-change-counts.ts` ·
  `web/src/hooks/use-dash-prefs.ts` (`dashView`) · [ADR 0063](./0063-a-pane-keeps-its-place-when-its-state-changes.md) ·
  [ADR 0065](./0065-the-changes-view-reads-git-read-only.md)

## Context

After the dashboard stopped sorting by urgency (ADR 0063), the panes that need you sit scattered
across their workspace groups. On a 25-pane herd that is a scroll per workspace. Issue 270 asked for
a view of the urgent set alone, as a third state on the workspace strip. At the same time the
Changes view (ADR 0065) had no way in from the dashboard: it opened from a pane's belt only.

The design round drew four ways to carry both: a three-tab footer, a two-tab footer with a Changes
chip on each workspace heading, a segmented control under the header, and a footer switch with a
Changes picker sheet. Option 1 was picked. The two corrections at the pick: the first tab was drawn
as "All", and its Changes tab wore a different icon from the one the pane belt uses.

## Decision

**The dashboard has a footer with three tabs, and each tab names what its list holds: Panes,
Attention, Changes.**

1. **Panes, not "All".** The app counts and names panes everywhere ("3 panes", "Your panes are
   under Spaces", the pane strip titled Panes), so the tab that lists every pane says so. "All"
   named nothing. Attention (`home.tabs.attention`) holds the panes blocked on you plus the finished
   panes you have not seen yet. It was first shipped as "Needs you", the summary line's section
   name, and renamed the same day: that label claimed something always needed you, and it was
   false whenever the list was empty. "Attention" names the filter, and it is true at 0 and at 5.
   The summary line keeps `status.section.needsYou`; only the tab changed.
   Changes wears `GitCompare`, the one Changes icon the belt and Settings already use.
2. **Attention is a filter, never a sort** (issue 270's rules). A workspace group shows only its
   panes whose `bucketOf()` is in `ATTENTION` (`needs`, `ready`), and a group with none is
   dropped. Workspaces keep their order and rows keep theirs. Every heading still counts its whole
   workspace, and the summary line still counts every pane, so the filter never understates the
   herd. When nothing needs you, the summary line's all-clear is the whole answer, not an empty
   list. The other two tabs carry no mark.
3. **Changes lists workspaces, not files.** One row per workspace the strip leaves shown, in the
   dashboard's order, with the changed-file count and the summed +added −removed, read from
   `GET /api/workspace/<id>/changes` on the workspace's own machine and session, with the device's
   Changes settings. A tap opens `/space/<id>/changes`. Every row is drawn from the first paint and
   a count fills in place; a clean workspace or one with no folder stays in its place, dimmed.
4. **The Changes counts refresh every 5 seconds, and only while that tab is on screen.** At most
   three workspaces are read at once, a round starts only after the last one ended, a hidden page
   skips its rounds, and leaving the tab stops them. Entering the tab reads at once, and so does
   the page coming back into view; that read replaces a round still out from before the page was
   hidden, which a sleeping phone can leave hanging (counsel, 2026-09-23). The dashboard's snapshot poll never carries
   them.
5. **The tab is a per-device choice** (`dashView` in `collie:dash-prefs:v1`), Panes by default, so
   an operator who never taps the footer sees the dashboard they had.
6. **At every width.** The dashboard is one centred column on a wide screen too, with no sidebar
   that would offer the same views twice.
7. **Attention's corner mark: a red count of blocked panes, or a quiet dot, or nothing.** The red
   number counts only the panes blocked on you (`countBlocked()`, the `needs` bucket). When none is
   blocked but a finished pane waits unseen (`hasReady()`, the `ready` bucket), the tab shows a
   small dot in the unseen mark's look (`ui/unseen-mark.tsx`) and no number. With neither, it shows
   nothing. The count and the dot sit in the same absolutely placed corner slot, so a change
   between them moves nothing. A screen reader hears "2 blocked" (`home.tabs.blocked`) or
   "finished panes unseen" (`home.tabs.unseen`). The list under the tab is unchanged and still holds
   both kinds, and the summary line keeps its own count of both. The reason: the badge first carried
   the summary line's count, blocked and unseen together, and an operator read 0 blocked plus 5
   finished panes as "5 urgent". A count should mean something waits on you. The dot says there is
   something new without claiming it is urgent. Changed 2026-09-23, the same day it shipped.

## Consequences

- **This amends nothing in ADR 0063.** No list is ordered by status; Attention only removes rows.
  The strip and the summary line stay where they are on all three tabs, and the footer sits outside
  the scroller, so a tab switch moves neither.
- **The dashboard spends 56px plus the safe area on the footer, always.** The build stamp gives up
  the safe area to it, and the dashboard's toasts float above it.
- **Launch and the Spaces navigator show under Panes only.** They belong to the whole herd.
- **The Changes tab costs a git status per workspace every 5 seconds while it is open.** That is
  the bridge's read-only path from ADR 0065, bounded by the concurrency limit and by visibility.
- **Revisit** if a fourth list earns a tab: the row holds three words comfortably at 375px, and a
  fourth would crowd the translations.
