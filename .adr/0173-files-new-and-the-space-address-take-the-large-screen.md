# 0173: Files, New and the space address take the large screen

- **Status:** Accepted (2026-11-21)
- **Date:** 2026-11-21
- **Relates to:** [ADR 0158](./0158-the-large-screen-dashboard-repeats-what-needs-you-in-a-band.md) (the large-screen
  Dashboard, with its other addenda of 2026-11-21), [ADR 0120](./0120-on-a-large-screen-the-pane-screen-is-a-strip.md)
  (the `expanded` width class and the Off setting).
- **Trail:** The large-screen rounds of 2026-11-21 after the Dashboard of 0158: the pick of Files and Changes as
  two columns under one header, and of New as a dialog over the screen it was called from, with the space address
  opening the pane view. Both first stood as addenda to 0158, which then passed the 120-line limit of a record, so
  they moved here unchanged. Files: `web/src/components/files-wide.tsx`, `web/src/lib/diff-layout.ts`,
  `web/src/routes/changes.tsx`, `web/src/lib/new-over.ts`, `web/src/components/new-over.tsx`,
  `web/src/routes/space.tsx`, `web/e2e/wide-files.spec.ts`, `web/e2e/wide-new.spec.ts`

## Context

ADR 0158 gave the Dashboard of a large screen its grid, its band and its header. Three more screens still drew
the phone's page in a wide window: Files and Changes, New, and the space address. This record holds the two
decisions that changed them. Each section below is the text of the addendum to 0158 it came from, not reworded.

## Decision

### 1. Files and Changes are two columns under one header

On a large screen (`expanded`, Large-screen layout not Off) Files and Changes are one page of two columns under the
spanned header (48px, the recess, `NAV_EDGE`): Back, the word Files, the space's label line and branch, the filter and
Refresh. The left column is 360px on the recess, with the Changes only / All files control on top at its full width
at every level. It holds the folder tree, which opens folders in place (one tab stop, the arrows walk it, Right opens
and Left closes or steps to the parent), or, while Changes only is chosen or a changed file is open from it, the list
of changes drawn as the tree's flat rows. A row is 36px with a mouse and 44px when the primary pointer is coarse, one
rule in `web/src/components/ui/nav-row.ts`. The right column holds the open file, and while none is open the folder's
name, the count of changes and "Choose a file to open it here." Only a file is a new history entry: a folder opened in
the tree moves nothing, Back returns to the file before, and the header's Back steps back past the files of the visit
to where Files was opened from. A file's row holds Previous file and Next file as two small buttons, and the phone's
foot bar is not drawn. The same row holds Unified / Side by side. Until a person chooses, a diff is side by side when
the file's column is at least 1200px wide, so it is one column at 1440 and side by side at 1920; a choice is kept on
the device (`collie:diff-layout:v1`). A new, deleted or untracked file is always one column and the control is
disabled. Side by side draws a comment that no line anchors above the first hunk across both halves. The dashboard's
Files view is one line a space, with the counts at the right, in a column of at most 720px from the grid's left edge;
the space filter is capped at 320px. A phone and a tablet keep the one column. Files: `web/src/components/files-wide.tsx`,
`web/src/lib/diff-layout.ts`, `web/src/routes/changes.tsx`, `web/e2e/wide-files.spec.ts`.

### 2. New is a dialog over the screen, and the space address opens the pane view

On a large screen (`expanded`, Large-screen layout not Off) New and "Add your own" no longer replace the screen. The
screen keeps its own address and gains `over=<the New address>` (`web/src/lib/new-over.ts`); the root layout draws New
over it as a centred dialog (`web/src/components/new-over.tsx`), in the shell every sheet has as a dialog
(`BottomSheet`, new `size="form"`: height by content up to 720px, the Tab key kept inside, the body and foot laid out by
the caller). New is about 880px wide in two columns: what to start and New worktree at the left (340px), the folder at
the right, the summary and a 200px Start in a foot across both; the right column scrolls, the foot stays. "Add your
own" is the same dialog in one column, about 560px, its back returning to New. `hooks/use-nav.ts` rewrites a move to a
New address into that shape, so every New button works unchanged. Back, Escape and the close button step off the
entry, and the focus returns to the control that opened New; a start replaces the entry with the new pane, so Back
from the pane returns to the screen without New. `/new` and `/new/add` opened directly redirect to the Dashboard with
New over it. Stacked sheets now close one at a time on Escape, the top one first.

`/space/:id` has no page of its own on a large screen: it opens the pane view of the Space's open tab, at the pane that
tab last showed, and the sidebar brings that row near its top once. A Space with no pane has no column on the
Dashboard either, so the address opens the Dashboard at its top. The move is sideways. A phone, a tablet and
Large-screen layout Off keep the New page, the Add page and the space page, box for box. Files:
`web/src/lib/new-over.ts`, `web/src/components/new-over.tsx`, `web/src/components/ui/sheet.tsx`,
`web/src/routes/new.tsx`, `web/src/routes/new-add.tsx`, `web/src/routes/space.tsx`, `web/e2e/wide-new.spec.ts`.

## Consequences

- A phone, a tablet and Large-screen layout Off keep the one column, the New page, the Add page and the space
  page, box for box.
- The two decisions are one scope with 0158 (the `expanded` width class), and a change to either is a new record
  or an addendum here, so 0158 stays within the limit.
