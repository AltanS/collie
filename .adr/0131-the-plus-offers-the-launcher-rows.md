# 0131: The plus offers the launcher rows

- **Status:** Accepted
- **Date:** 2026-11-06
- **Shipped in:** pending
- **Relates to:** [ADR 0091](./0091-launch-by-id-with-a-request-id.md) (the start by id and its request
  id, which the sheet reuses), [ADR 0094](./0094-launchers-added-from-a-phone.md) (the rows, their
  availability and the no-prompts confirm), [ADR 0102](./0102-starters-are-launcher-rows.md) (a
  machine of starters keeps its New page link), [ADR 0127](./0127-the-leads-launcher-rows-are-the-crews-rows.md)
  (a lead's rows are offered on a member, and marked), [ADR 0067](./0067-back-goes-up-one-level.md)
  (the new pane is a step down, as the "+" made it).
- **Trail:** Altan's request of 2026-11-06 (milestone M91) · `web/src/components/new-tab-sheet.tsx` ·
  `web/src/hooks/use-new-tab-or-sheet.tsx` · `web/src/lib/new-tab-sheet.ts` ·
  `web/src/components/workspace-new-tab.tsx` · `web/e2e/new-tab-sheet.spec.ts` ·
  `docs/configure.md` → "Your own launchers"

## Context

The "+" at the end of a workspace's tab row, and the "+" on a workspace heading of the dashboard, opened
a bare shell in that workspace. Altan's words: "Currently I click on it and then I always type the
command for my agents myself." The agents were configured already: the New page lists them, and its
start can open a tab beside a pane. But the New page is a full page with a machine, a folder and a
worktree switch, and the "+" is the quick way to one more tab in the place you are.

The bridge lists every agent Collie knows on every machine, installed or not, with its availability
(`launcherItems` in `bridge/launcher-adds.ts`). So "the machine has no rows" never means an empty list.

## Decision

**The "+" opens a bottom sheet of the machine's launcher rows, with "Just a shell" last.**

1. **The New page's rows and start.** The sheet reads `GET /api/launchers` for the workspace's machine
   and lists the agents, then the command rows, in the New page's order, built by the same `offerFor`.
   A row that cannot start is listed, dimmed, with its reason. A lead's row on a member says "Lead".
   A tap starts through `useSpaceActions().start` with `beside` set to a pane of the workspace, so the
   bridge opens a TAB in that workspace, in that pane's folder, and the phone steps into it. No route
   and no bridge code is added.
2. **One sheet, every "+" that makes a tab.** The space view's tab row, the pane view's tab bar and a
   dashboard heading share one hook, `useNewTabOrSheet`, and the dashboard mounts one sheet for the
   whole list. The wide layout keeps its own "+", and a machine of starters keeps its New page link.
3. **The folder is the workspace's.** The sheet shows it under the title and does not offer to change
   it. "More options" opens the New page for that workspace (`/new?beside=`) for a folder, a worktree or
   a one-off line. A row with a pinned folder runs there, and says so.
4. **Nothing to offer, no sheet.** When the machine's answer holds no row that can start beyond the
   shell, the "+" makes the shell at once, as it always did. A tap before the answer is in opens the
   sheet, which says it is reading and lists no other machine's rows; an answer with nothing to offer
   then closes it for the shell.
5. **Busy and refusals.** One start at a time: the tapped row spins and every row is inert. A refusal
   shows in the open sheet with the New page's words. An outcome nobody can confirm stays open with the
   New page's notice, and a second tap on that row sends the same request id, so a start that did run
   lands on its receipt (ADR 0091). A device that may not write, a saved copy on screen and a machine
   not taking writes get their refusal on the "+" tap, before any sheet.
6. **"Just a shell" is the old "+".** It sends `POST /api/tab` with the workspace and nothing else, as
   the "+" did. A row that skips permission prompts asks first, through the guard every launch path
   uses (ADR 0094).

## Alternatives considered

- **A long press for the sheet, the tap for the shell.** Keeps the old tap. Rejected: the agents are
  what Altan reaches for, and a hold is the gesture nobody finds. The shell is one more tap, last in the
  sheet, where the thumb lands.
- **A setting: "+" opens a shell or the sheet.** Rejected: one more switch to explain, for a choice the
  machine already answers. A machine with nothing to offer keeps the shell on its own.
- **A default row: the "+" starts the operator's favourite agent at once.** Fastest when it is right.
  Rejected: the "+" would then do something different on each machine and after each edit of
  `launchers.toml`, and a no-prompts row would need its confirm on a tap that looks like a plain create.
- **The New page itself, opened by the "+".** It has every option. Rejected: a full page with a folder
  field and a worktree switch for "one more tab here" is the friction the request is about. "More
  options" keeps it one tap away.

## Consequences

- **The "+" reads the launcher list.** Each view that has a "+" reads its machine's list once on mount
  and again at every opening of the sheet, so a row added to `launchers.toml` shows on the next "+".
- **The sheet decides on the answer it has.** A list read before a row was added still makes a shell
  on that tap; the read behind it brings the row to the next one.
- **A failed read says "reading".** The sheet lists no rows it has not read, so it shows its reading
  line and "Just a shell", which still works.
- **The wide layout is unchanged.** Its tab row's "+" makes a shell, and its space header opens the New
  page with `beside`.
- **Not built.** A folder or worktree choice inside the sheet, a remembered last row, any change to the
  rows themselves.
