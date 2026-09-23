# 0063 — A pane keeps its place when its state changes

- **Status:** Accepted
- **Date:** 2026-09-23
- **Shipped in:** pending
- **Trail:** `bridge/state-engine.ts` (`byPlace`) · `bridge/crew/merge.ts` (`placeSorted`, which
  replaced `triageSorted` and its §9.2 reading "the phone's NEEDS YOU list must not hide a blocked
  agent behind a host tab") · `web/src/lib/pane-groups.ts` · `web/src/lib/pane-ordinal.ts` ·
  `web/src/lib/spaces.ts` · `web/src/components/agent-sidebar.tsx` · commit a039e277 (the
  dashboard's own switch, 2026-09-16) · `DESIGN.md` §2

## Context

Collie's first list was a triage list: blocked agents on top, then working, then the rest. The
bridge built that order itself. `state-engine.ts` sorted `agents` by `STATUS_RANK`, then by place,
and the crew merge did the same across machines, with the host as the tie-break below status, so a
peer's blocked pane would never hide behind a host tab. Every poll re-sorted the list.

In September 2026 the dashboard dropped its urgency sections (a039e277): panes stay in their
workspace in the multiplexer's order, and urgency became a mark. The bridge kept its status sort,
though, and four other surfaces kept the bridge's order. The pane strip in the pane view, the space
view, the switcher sheet with its Needs you, Ready, Working and Recent sections, and, in a crew, the
dashboard's own machine order all still moved. That order came from whichever pane arrived first,
so a peer whose pane blocked had its groups jump above the lead's. On a phone the thumb is already
moving when the list changes, and on these surfaces a wrong tap opens another terminal.

## Decision

**No list is ordered by status. A pane's place is its machine, its space, its tab and its position
in the tab, and a state change repaints it but never moves it.**

1. **The bridge sends place order.** `agents` sorts by `byPlace` alone. The crew merge sorts by host
   (the lead first, then peers by member id), workspace number, the tab's index in the merged `tabs`
   list, `tabPosition`, and the pane id last, so the order stays total.
2. **Every client surface recomputes place order** and does not trust the arrival order. The pane
   strip and the space view sort by `tabPosition`. The dashboard and the switcher group with
   `groupPanesByWorkspace(..., { order: "fixed" })`, and machines run in the `servers` list's order.
   An older peer that still sends status order cannot move a row.
3. **Urgency is a mark, and it has one place to go.** A row's alarm edge, its workspace heading's
   dot, and one summary line on top that counts what needs you and jumps to the first of it. The
   dashboard and the switcher draw the same `StatusSummaryLine`.
4. **`triage()` still classifies.** Its buckets decide every mark and every count. It no longer
   decides where a row sits on any surface.

## Consequences

- **A blocked pane at the bottom of a long list is not at the top any more.** The summary line, the
  row wash, push and the badge carry the alarm. The line's tap is the way to reach the pane.
- **The switcher's Recent fold is gone** with the Recent section. A workspace's handful of rows is
  not a tail to fold away. The Shells and Launch folds stay.
- **The pane strip now matches on the tab's full address** (host, session, workspace), so in a crew
  it no longer pulls a peer's panes into the lead's strip because both call their first tab `w1:t1`.
- **Revisit only with a surface that sorts by urgency on the operator's own request**, a toggle the
  operator taps and watches. A list that re-sorts itself on a poll is the fault this closes.
