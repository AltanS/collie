# 0119: a plan is a tool kind, and its updates fold into one card

- **Status:** Accepted
- **Date:** 2026-10-16
- **Shipped in:** 1.24.0
- **Trail:** [issue 461](https://github.com/AltanS/collie/issues/461) (Gentle Shell's `todo`, subagent
  and background tools drawn as `other`) · `bridge/journal/tool-call.ts` · `bridge/journal/pi.ts` ·
  `web/src/lib/chat-items.ts` · `web/src/components/chat-cards.tsx` ·
  [ADR 0073](./0073-a-live-session-is-a-bounded-window-on-the-existing-poll.md) ·
  [ADR 0098](./0098-pi-questions-are-read-by-shape-and-footer.md)

## Context

`ToolCall` was nine kinds and closed, and the header of `tool-call.ts` says why: tool vocabularies
overlap, so a small union covers every harness, and anything else is `other`. A task list does not fit
any of the nine. `TodoWrite` (Claude Code), `update_plan` (Codex) and Gentle Shell's `todo` (pi) all
keep one list the agent rewrites as it works, and as `other` each update is a line that says only that
the list changed.

Gentle Shell's `todo` makes it worse: `todo update` names one task, so the input alone never holds the
list. Its result does. Over 277 local `todo` results (2026-10-16) every one carried the whole list in
`details.gentleTodo.tasks`.

Two other Gentle Shell tools return before their work ends. `subagent_run` in background mode and
`bash_background` answer "started" at once, and pi logs the end later as a `custom_message` row
(`gentle-agents.result`, `gentle-jobs.notice`) that names the task or job id. A card coloured from
its result alone shows these as done while they still run.

## Decision

1. **A plan is the tenth kind.** `{ kind: "plan", name, tasks }`, each task a title and one of five
   statuses (`pending`, `in_progress`, `done`, `blocked`, `dropped`); other harnesses' words map onto
   them (`completed` is `done`, `cancelled` is `dropped`). The list is read from the input where the
   input holds it (`tasks`, `todos`, `plan`) and from the result's details where it does not. A tool
   that keeps a list is not a new kind per tool.
2. **On pi, a list's updates fold into the card its `write` drew.** The reducer holds the newest plan
   card; a later `todo` call that is not a `write` draws nothing of its own, and its result rewrites
   the held card's tasks and names that turn in `changed` (ADR 0073). A new `write` opens a new card,
   and a `clear` ends the held one: the card keeps the list as it last stood, and the next `add`
   draws its own. A rewind past the held card releases it too. Other harnesses draw one plan card per
   call: their lists have no `write` to mark where one list ends and the next begins. A call that
   carries only the items it changed (Hermes's `todo` with `merge: true`) is not a plan.
3. **A call can be ongoing after it returns.** `execute` and `task` carry `ongoing: true` while the
   work they started runs, and the end notice with the same id clears it, sets an exit code and marks a
   failure. Chat draws an ongoing call as running. `subagent_result` folds into the card of its
   `task_id` the same way.

## Consequences

This closes off two roads: a card per vendor tool (one kind serves every list) and a line per update
(on pi the list is one card). A tool with a list in a field this code does not read stays `other`
until the field is named here.

A held plan card can sit well above the bottom of a long session, which is why a `write` opens a new
one. If an agent writes once and updates for hours, the card is drawn where it was written and the
reader scrolls up to it; revisit if that is reported.

A live session is a bounded window (ADR 0073). When the held card has scrolled out of it, the
updates that fold into it still draw nothing, so the reader keeps the card as it was until the next
`write`; a fresh read of the session draws the current list. The same holds for a subagent or a job
whose card has left the window.

An ongoing call whose end notice never arrives (pi killed, notice outside the window) stays running.
That is the same as a call whose result never arrived, and it is drawn the same way.

## Addendum 2026-10-25: OMP and Gentle Shell jobs from the journal

Oh My Pi (18.6.1, read off a real session) starts a subagent with a `task` call whose result
answers at once: `details.async` (`state: "running"`, `jobId`) and one `details.progress[]` row per
subagent (`id`, `agent`, `status: "pending"`). The job ends in an `async-result` notice
(`details.jobs[]`: `jobId`, `label`; the status sits in the notice's `<task-result … status>`) or in
a `wait` result (`details.jobs[]`: `id`, `status`, `label`). The pi reducer reads this beside Gentle
Shell's shape: the card is `ongoing`, remembered by job id and by progress id, and carries the job
id as `jobId`; a notice settles it by job id, then by label, and any result whose `details.jobs[]`
rows carry a final status settles the jobs it names. A second job of one name gets `<name>-2` as its
job id, so a progress id an ongoing card already holds stays with that card. A failed spawn
(`isError`, no `async`) is never ongoing.

The belt's agents mark (the running subagents of a pane, `PaneSubagent[]`) read Claude Code's meta
files only. For a pane whose journal has no subagent files it now also lists the ongoing `task`
cards of the session's live Chat window (`bridge/subagents-journal.ts`), from memory and never from
disk, so the mark fills while a reader polls that Chat and empties 30 seconds after the last poll,
or when the log has been quiet past the Claude list's 30-minute bound. Such a row has no transcript
route behind it and carries `transcript: false`, which the Agents sheet draws without a tap. The job
id is not `agentId` on the card: `agentId` names a log the subagent sheet fetches, and no route
serves one for these jobs.
