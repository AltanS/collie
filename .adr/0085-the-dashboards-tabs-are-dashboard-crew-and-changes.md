# 0085: The dashboard's tabs are Dashboard, Crew and Changes

- **Status:** Accepted
- **Date:** 2026-10-05
- **Shipped in:** 1.17.0
- **Amends:** [ADR 0066](./0066-the-dashboard-has-a-footer-panes-needs-you-changes.md) and
  [ADR 0068](./0068-the-second-tab-is-focus-not-attention.md), in scope. The footer, the filter's
  rules (a filter and never a sort, whole-workspace counts on every heading, a group with nothing
  urgent dropped, the all-clear line when nothing needs you), the corner mark's count/dot/nothing
  rule, the Changes tab and the per-device storage all stand. The Focus tab becomes a switch, the
  first tab is renamed, and a Crew tab is added while a crew is configured.
- **Trail:** the operator's call on 2026-10-05, after the crew's machine cards (ADR 0084) needed a
  place that was not a second route · `web/src/routes/home.tsx` · `web/src/components/agent-list.tsx`
  (`needsYouOnly`, `onNeedsYouOnlyChange`) · `web/src/components/needs-you-switch.tsx` ·
  `web/src/components/crew-tab.tsx` · `web/src/lib/dash-view.ts` (`DashView`, `coerceDashView`,
  `isLegacyDashView`, `wasFocusView`) · `web/src/hooks/use-dash-prefs.ts` (`dashView`,
  `needsYouOnly`) · `web/src/components/ui/tab-bar.tsx` · `home.tabs.dashboard` and
  `home.needsYouOnly` in all seven catalogs · [ADR 0070](./0070-a-pin-is-a-place-the-operator-chose.md) ·
  [ADR 0071](./0071-the-operator-may-ask-for-activity-order.md)

## Context

The footer had three tabs: Panes, Focus and Changes. Focus was the Panes list with one filter on it
(ADR 0066 point 2). It shared the strip, the summary line, the Pinned group and the order toggle with
Panes, and differed from it by one boolean. A tab is a place. A boolean on a list is a switch, and
drawing it as a tab put two entries in the footer for one list.

Two things then pushed on the footer. The crew's machines (ADR 0084) needed a home on the dashboard,
and a footer with a third list tab and no room for it would have crowded the translations (ADR 0066
named a fourth tab as the point to revisit). And the first tab's name, Panes, was true of both
Panes and Focus, which made the pair read as two views of the same thing when one was a filter.

## Decision

**The footer's tabs are Dashboard, Crew and Changes. Focus is a switch in the summary line. With a crew the footer reads Crew, Dashboard, Changes, left to right.** Dashboard is the default and sits in the middle under the thumb; the two side tabs are the side trips (the operator's call on 2026-10-05, after the first build, which had Crew between the other two).

1. **Dashboard is the one list tab.** It is the old Panes list: the strip, the summary line, the
   Pinned group, the workspace groups (or the one ranked list of ADR 0071), then the launch strip and
   the Spaces navigator. Its label is "Dashboard" in all seven locales. It keeps `Rows3`, the icon the
   Panes tab wore: the list is rows, and a grid icon such as `LayoutDashboard` would promise tiles.
2. **"Needs you" is a switch, not a tab.** A toggle button in the summary line's row, beside the
   Activity/Cache order toggle, wearing `CircleDot`, the icon Focus wore. It is a 44px target with
   `aria-pressed` and the accessible name "Show only panes that need you". On, it wears the primary
   tint and a hairline primary ring. The ring is there because the order toggle's selected segment is
   `bg-muted`, and with the brand's near-black primary the two fills read alike. It applies exactly the
   filter ADR 0066 point 2 describes: a filter, never a sort, so a group keeps only its panes in
   `ATTENTION`, a group with none is dropped, every heading still counts its whole workspace, the
   summary line still counts every pane, and the all-clear is the whole answer when nothing needs
   you. It is stored per device as `needsYouOnly` in `collie:dash-prefs:v1`, off by default.
3. **The launch strip, the Spaces navigator and the pin hint show only while the switch is off.**
   They belong to the whole herd, as they belonged to Panes and not to Focus. The switch filters the
   Dashboard list and nothing else: on Crew and Changes it is not drawn.
4. **The corner mark moves to the Dashboard tab, and is drawn always.** The red count of blocked
   panes, or the quiet dot for a finished pane not yet seen, with ADR 0066 point 7's rule and the same
   accessible text ("Dashboard, 2 blocked"). It is drawn with the switch on or off, and on every tab:
   it is information about the herd and no nag, as it was on Focus.
5. **Crew is a tab drawn only while a crew is configured**, the condition `crew-footer-link.tsx`
   uses (`useCrew().multi`). It sits first, to the left of Dashboard, and wears `Network`, the icon the
   Settings card, the switcher sheet and the footer line already use for the crew. Its body is
   `CrewTab`, mounted only while the tab is selected, so it fetches nothing otherwise. A solo
   Collie has two tabs, Dashboard and Changes, and its chrome is otherwise as it was. `CrewFooterLink`
   stays.
6. **Changes is unchanged**, last: third with a crew, second on a solo Collie. The keyboard and screen-reader order is the DOM order of the buttons in `TabBar`, which is the visual order; there is no separate roving focus to keep in step.
7. **The order toggle shows on the Dashboard in both switch states.** On Changes the row's
   controls slot stays, invisible and `aria-hidden`, so the summary line does not jump between the
   two pane tabs. Crew is a different list, machines and not panes, so it carries none of the pane
   chrome: no space strip, no summary line, no controls slot and no Pinned group, and its body starts
   with the machine cards. This is the stated exception to ADR 0070's "Pinned on all tabs". A crew
   with no pane anywhere draws the same Crew body, instead of the list's empty placeholder.
8. **Migration: no one loses their view.** `DashView` is `"dashboard" | "crew" | "changes"`.
   `coerceDashView` reads a stored `"panes"` as `"dashboard"`. A stored `"focus"` (and its earlier
   names `"needs"` and `"attention"`, ADR 0068) reads as `"dashboard"` AND turns `needsYouOnly` on,
   once: `use-dash-prefs.ts` writes the migrated blob back when it loads one, so the switch is stored
   as its own value afterwards and an operator who turns it off is not put back. A stored `"crew"`
   on a device with no crew shows the Dashboard, and the stored value is left alone, so the tab is
   back where it was when the crew returns. Anything else is `"dashboard"`.

## Consequences

- **Nothing in the filter changes.** Only its door does: one tap in the summary row where a footer tab
  was. The rules, the tests of the rules and the all-clear stand.
- **The summary row holds more.** At 375px the summary line, the switch and the three order segments
  share one row, and the counts wrap before the controls shrink. Each control keeps its 44px.
- **A pin still leads every pane tab (ADR 0070).** That is Dashboard and Changes. Crew lists machines,
  so the Pinned group is not drawn there (point 7).
- **The footer has room for a fourth tab no more than before.** ADR 0066's "Revisit" stands: three
  words fit comfortably at 375px, a fourth would crowd the translations.
- **ADR 0066 and 0068 are history for the tab, current for the rules.** Where they say "the Focus
  tab", read "the needs-you switch".
