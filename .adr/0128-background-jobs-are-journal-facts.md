# 0128: Background jobs are journal facts, shown on the belt

- **Status:** Accepted
- **Date:** 2026-11-03
- **Shipped in:** pending
- **Relates to:** [ADR 0119](./0119-a-plan-is-a-tool-kind-and-its-updates-fold.md) (Gentle Shell's
  background tools end on a notice row; the reducer keeps `ongoing` until it arrives),
  [ADR 0073](./0073-a-live-session-is-a-bounded-window-on-the-existing-poll.md) (the live window the
  reader reads), [ADR 0082](./0082-chat-is-the-default-view-of-an-agent-pane.md) (Chat is the view
  that keeps the window alive).
- **Trail:** [issue 670](https://github.com/AltanS/collie/issues/670) (@viniciosrab: a badge on the
  working dot, "working · 1 job", on the dashboard row, the switcher and the header, or a distinct
  state) · `bridge/journal/tool-call.ts` · `bridge/journal/pi.ts` (`startWork`, `settle`) ·
  `bridge/jobs-journal.ts` (new) · `bridge/answer-mask.ts` · `bridge/server.ts` ·
  `web/src/components/actions-row.tsx` · `web/src/components/jobs-sheet.tsx` (new) ·
  `web/src/components/composer.tsx` · `web/src/components/strip-column.tsx` · milestone M83

## Context

A pi agent with Gentle Shell often ends its turn while a command it started still runs: a build, a
test suite, a CI watch. `bash_background` and `monitor` answer "started" at once, and pi logs the end
later as a `gentle-jobs.notice` row. The reducer already reads both (ADR 0119): the `execute` call
carries `background: true`, and `ongoing: true` until the notice, then `exitCode`.

The pane keeps its working light on the whole time. From the phone that looks like an agent still in
its turn, or a stuck one. Issue 670 asks for the difference to show, and offers two roads. One is a
distinct state, or a badge on the working dot, on the dashboard row, the switcher and the header. The
other is a mark in Chat, like the agents mark, with a sheet that lists the jobs.

Two facts decide between them. The working light is not Collie's: `AgentStatus` comes from the
multiplexer (`bridge/mux/herdr-core/layout.ts`), and every surface draws `pane.status` as it came. And
the job facts live in the journal, which Collie reads in a live window only while a reader polls the
pane's Chat. The dashboard polls no Chat.

## Decision

**A background job is an `execute` call with `background` and `ongoing`, read from the journal and
shown on the belt. The status light stays the multiplexer's, and the dashboard badge waits for a
journal tail.**

1. **A job is a fact on the call.** The `execute` kind gains `jobId`, `startedAt` and `endedAt` (epoch
   ms). The pi reducer sets the first two from the start result (its `gentleJobs.jobId` and the row's
   time) and `endedAt` from the row that ends the job. Any journal adapter that sets these facts gets
   the rest of this ADR. No shared code names a harness.
2. **One reader, memory only.** `JournalJobs` (`bridge/jobs-journal.ts`) lists the background calls in
   the live window: every one still `ongoing`, and every ended one whose `endedAt` is within the last
   ten minutes (`RECENT_JOB_MS`), applied at each read. It answers only while a Chat poll is fresh
   (`HELD_FRESH_MS`) and the log was written in the last `QUIET_RUNNING_MS`, the guards the journal
   subagent list uses. It reads no file.
3. **The wire field is `jobs?: PaneJob[]`**, attached beside `subagents` at serialise time, absent and
   never `[]` when there is none. `PaneJob` is `id`, `label`, `command`, `startedAt`, and on an ended
   job `endedAt` and `exitCode` where the end named one. With the mask on, `id`, `label` and `command`
   take it (`maskJobList`), on the bridge's own snapshot and on a lead's re-mask of a member's.
4. **The belt shows it.** A jobs mark (the Timer glyph) stands in the pinned block right of the agents
   mark while the pane has any job listed. Its corner badge counts the running jobs and is not drawn
   at zero, when only ended jobs keep the mark. A tap opens the Jobs sheet: the running jobs with
   label, command and run time, then the ended ones with exit code and how long ago.
5. **The status light is not Collie's to change.** Collie does not add a state, does not change
   `working`, and does not draw a badge on the dot. A job mark beside the light says why it is on.
6. **The dashboard badge is deferred.** A count on the dashboard row, the switcher and the header
   needs the facts with no Chat open. That needs a journal tail per pane, as `TAILED_TODO_AGENTS`
   reads Claude's and Codex's todos (`bridge/todos.ts`). It is a follow-up, not part of this ADR.

## Consequences

- **A job outside the window is not listed.** The live window holds the newest turns only. A job whose
  call left the window's front leaves the list, as a journal subagent does.
- **The mark lives as long as a Chat is read.** With no Chat poll for `HELD_FRESH_MS`, the field goes
  absent. The Screen view and the dashboard show no jobs.
- **A killed harness cannot leave a job running for ever.** A log quiet for `QUIET_RUNNING_MS` empties
  the list, running and ended alike.
- **An end with no code reads as ended, with no code.** A stopped `monitor` names no exit code. The
  sheet draws it under the ended jobs with its time and no exit line.
- **The wire grows by one optional field.** Additive; an older phone ignores it, and an older bridge
  sends none.
- **Not built, listed as later.** The dashboard, switcher and header count (point 6). A job's output
  in the sheet: it is in Chat, and the output path a harness names is a file on the host.
