# 0158: The large-screen dashboard repeats what needs you in a band, and no row leaves its place

- **Status:** Accepted
- **Date:** 2026-11-19
- **Amends in scope:** [ADR 0147](./0147-a-pane-list-keeps-its-place-and-the-footer-holds-views.md), rules 1, 2 and 7:
  the only place a list shows urgency as a position of any kind, and the dashboard's column at a wide width.
- **Relates to:** [ADR 0120](./0120-on-a-large-screen-the-pane-screen-is-a-strip.md) (the `expanded` width class and the Off setting),
  [ADR 0153](./0153-the-first-frame-paints-from-a-remembered-shape.md) (the first frame draws what is known).
- **Trail:** the `dashboard-wide` proposal round of 2026-11-19, four answers for the dashboard on a large
  screen, and the operator's pick of option 4, "Needs you first, then Spaces", over three that never
  repeat a session (Spaces wrap in rows, Spaces stack in columns, a strip of Spaces) · the 640px column the
  dashboard kept at every width (rule 7 of 0147, a column with empty margins on a desktop) · Files:
  `web/src/components/wide-dashboard.tsx`, `web/src/components/agent-list.tsx` (`wide`),
  `web/src/lib/wide-dashboard.ts`, `web/src/routes/home.tsx`, `web/e2e/dashboard-wide.spec.ts`

## Context

On a desktop the dashboard was the phone's column, 640px wide, with empty margins. The large-screen layout
of ADR 0120 reshaped the pane screen only. A person with twenty Spaces scrolled one long column on a
screen that could show twelve of them side by side. The proposal round drew four answers. Three keep
rule 1 of 0147 whole. The operator picked the fourth, which puts a band of cards over the grid, one for
each session that needs the person or finished unseen, each with its question.

0147 says no list is ordered by status and urgency is a mark, never a position. A band above the grid is a
position. This record states the exception exactly, so it does not grow into a second sort.

## Decision

1. **Where it applies.** The Dashboard tab of the home route, in the `expanded` width class (900px, and
   480px tall) with Large-screen layout not Off. Everywhere else, the phone, the medium class, a phone held
   sideways and Off at any width, the dashboard is the phone's list, unchanged. Crew and Files keep the
   phone's column, centred under the wide header.
2. **The grid.** Spaces stand in fixed 384px columns, 24px apart, wrapping in rows, in the list's own
   order (machine, Space number, tab number). The number of columns is the width of the scroller, measured,
   and nothing else (`spaceColumns`, at most six); no status or count can move a Space to another column.
   There is no sidebar. The header, the tab bar and the New button are as wide as the grid and its 24px
   gutters.
3. **The band is a copy.** Above the grid, one card for each session that needs the person or finished
   unseen (`needsYou`), in the list's own order, never by urgency or age. Each session keeps its row in its
   own Space with its mark. The band is a second way to the session, not a move, and it carries no DOM id
   of the row. A session in the Pinned group is in the band too.
4. **It holds still under a finger.** While a finger is down on the list, who needs you is what the finger
   found, as for the needs-you switch (0147 rule 3). With the needs-you switch on the band is not drawn,
   because the grid already says it. A session query narrows the band like the rows.
5. **The band moves the grid, and that is accepted.** It opens and closes through `Collapse`, which respects
   reduced motion. On a cold open the saved copy is the herd, so the band is in the first frame, open, and
   the grid does not drop a moment after load (0153). When the last waiting session is answered the band
   closes, and the grid moves up once.
6. **The rest is the phone's.** Filters, the freeze, the still list, pins, the orders (a ranked list is cut
   into columns), the heading's "+", the connection banner and the saved copy are the phone's own code.
   The empty dashboard is the first-start card, centred at one Space's width.

## Today in the code

- Rules 1 and 2: `useWidthClass`, `useElementWidth(…, "client")`, `spaceColumns`, `contentWidth`
  (`routes/home.tsx`, `lib/wide-dashboard.ts`); `RouteHeader` with a numeric `width`; `Fab` `columnWidth`.
- Rule 3: `waitingPanes`; `WaitingBand`, `WideSpace`, `SpaceGrid` (`components/wide-dashboard.tsx`).
- Rules 4 and 5: `heldNeeds` and `Collapse` in the `wide` branch of `AgentList`.

## Consequences

- The band repeats a session on one screen, so a count of rows on the page is no count of sessions. The
  summary line and the heading counts still count each session once.
- The grid moves by the band's height when the first session starts or the last stops waiting. The operator
  accepted that movement for this screen only.
- A change of the band's rule (a cap, an order, another state) is a new record. A third place that repeats
  a session needs one too.

## What we tried before

- Spaces wrap in rows, Spaces stack in columns, a strip of Spaces: all kept 0147 whole and were set aside
  by the pick. The strip hid every Space past the right edge until a swipe.
- Option 4 as drawn put the New button over the last row. The route gives the scroll area the room the
  phone's list already gives it, so the last row scrolls clear.

## Addendum — 2026-11-21: no tab bar at the foot, and one command row

The operator's pick in the `wide-home` round amends rule 2. On a large screen the dashboard has no tab bar and no floating New button. The views (Crew, Dashboard, Files) are the compact segmented control in a header that spans the window on the recess at the pane view's 48px. The tricks' items go last in that control, and the Hill is an icon button beside Actions. The command row (the summary, the filter, the order, the switch, the magnifier and New) is sticky under the header. Every empty state (not paired, no Space, no answer, waiting) is one column centred both ways, with no Spaces section beside it. Files and Crew stay the phone's centred column. Files: `web/src/components/dashboard-views.tsx`, `web/src/components/ui/nav-edge.ts`, `web/e2e/dashboard-wide-head.spec.ts`.

## Addendum — 2026-11-21: Settings is one page of two columns

On a large screen (`expanded`, Large-screen layout not Off) Settings is the section list beside the chosen section. One
layout route, `settings`, wraps every Settings address (`components/settings-shell.tsx`): below the large screen it
draws only its outlet, so the phone's pages are the same DOM; on the large screen it draws the dashboard's spanned
header (48px, the recess, `NAV_EDGE`) filled with Back, the word Settings and the path, the 280px list at the
window's left edge on the recess (rows 44px, icon and title, the phone's second line in `title`, the chosen row on
the paper), and the section in a column of at most 720px, left-aligned beside the list, on the page plane. The block
spans the window rather than sitting in a centred container, because the list then stands where the pane view's
sidebar stands, on the same plane, and the two read as one app. The section pages do not fork: each draws through
`SettingsPage` (Updates moved onto it), which inside the layout leaves the header to it and draws a plain `h1`, with
Back one level up beside it on a deeper page, and portals its path into the header. A row is a push, so the browser's
Back returns to the section before; the header's Back steps back past the sections walked through to where Settings
was opened from (the nav trail), else up to the Dashboard. `/settings` replaces itself with Updates while a release
waits, else Appearance. Machines stays a page of its own, and its row leaves Settings. Files:
`web/src/components/settings-shell.tsx`, `web/src/components/settings-page.tsx`, `web/src/hooks/use-settings-rows.ts`,
`web/e2e/settings-wide.spec.ts`.

## Addenda moved to ADR 0173

- 2026-11-21, Files and Changes are two columns under one header: moved to [ADR 0173](./0173-files-new-and-the-space-address-take-the-large-screen.md), word for word.
- 2026-11-21, New is a dialog over the screen, and the space address opens the pane view: moved to [ADR 0173](./0173-files-new-and-the-space-address-take-the-large-screen.md), word for word.
