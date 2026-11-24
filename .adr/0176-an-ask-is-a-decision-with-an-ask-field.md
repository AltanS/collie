# 0176: An ask is a Decision with an `ask` field, and one Send answers a session's asks

- **Status:** Accepted (2026-11-24), the lead's design for the first build on the dev lane
- **Date:** 2026-11-23
- **Trail:** The Asks lab of 2026-11-22: four test agents, 13 asks, and the faults each rule below answers (bare
  labels, no background, two decisions in one ask, a decision left in a plan file, all asks sent at the end of the
  turn). Files: `web/src/lib/hill/wire.ts`, `web/src/lib/hill/answers-message.ts`, `bridge/hill/ask-rules.ts`,
  `bridge/hill/ask-files.ts`, `bridge/hill/answers.ts`, `bridge/hill/service.ts` (`askPost`, `cancelAsk`,
  `answerAsks`), `bridge/files-view.ts` (`linkableFile`), `bridge/server.ts` (`hillAnswersRoute`), `cli/ask.ts`.

## Context

An agent that meets a decision it cannot take ends its turn with a list of questions. The operator runs many sessions
and reads that list later, with no memory of the session, and answers in free text that the agent must match back to
the questions. The Hill (M96) already carries one question per card, with options, a recommendation and an answer that
is typed back into the session. What it lacked for this use: rules that make a card readable cold, a background longer
than a card, files to look at, a cap that keeps the list short, and one message for many answers.

## Decision

**An ask is a Hill Decision with one more field, `ask`. `collie walky ask` posts it; the phone answers a session's
asks in one Send, which types ONE WalkyTalky message.** Nothing it supersedes; the Hill's own Decisions do not change.

1. **The id is `ak_` and 12 characters.** `HILL_ID_RE` takes `dc_` and `ak_`; `HILL_ASK_ID_RE` takes `ak_` only. Only
   an agent's session posts an ask (`from.kind` is `agent`).
2. **Its own limits, beside the Hill's** (`HILL_ASK_*`; the old limits do not change). The question is at most 90
   characters and ends with `?`. The fact (`summary`) is at most 240. 2 to 5 options; each label at most 60 and never a
   bare Yes, No, OK or Cancel; each option's `detail` is required, at most 300. The body is at most 20,000. A `--words`
   ask has no options and `text: "required"`; an ask with options has `text: "optional"`.
3. **No priority, no push, no end by age.** Priority and `priorityAsked` are `today`, no `pushTag`, `expiresAt` null.
   The store's rule that gives an open card an end on read skips an ask. The sweep still closes an ask whose session is
   gone. The quiet mark (`spokeAfter`) is never set on an ask: it stays open when the person writes in the session.
4. **At most five open asks per session** (`HILL_ASK_OPEN_MAX`). The refusal lists them, id and question, and says
   "Take one back or replace one".
5. **`more-context` is a reserved intent, valid on every ask**, with an optional note. It closes the ask answered, with
   the label "I need more context", and the typed line says how to ask again with `--replaces <id>`.
6. **`--replaces <id>` is `supersedes`.** It takes an open ask of the same session, which closes superseded; or one of
   the same session answered with more context, which stays closed: the new ask only records `supersedes`.
7. **A take back may say why.** `collie walky cancel <id>` closes `withdrawn` "by the poster"; `--because` keeps the
   agent's reason as "by the poster: <reason>"; `--answered` closes it "answered in the session", its own reason, which
   the self-clear keeps as it keeps a card the person answered in the session.
8. **A linked file is a pointer, never a copy.** The CLI resolves each `--file` to an absolute real path. The bridge
   finds the poster pane's Files root (`agentPaneFilesRoot`), checks the path with the Files view's own functions
   (`linkableFile`: the root's real path and bound, `parseRelPath`, `checkedTarget`, one `lstat` for a regular file),
   and stores it relative to that root, with `root` the pane id the Files route takes. Nothing is opened or read, then
   or later: the phone opens the file through `GET /api/pane/<id>/files`, under the Files right the device holds. At
   most 10 files, a path of at most 4096 bytes, `#heading` at most 120 characters, `:line` a positive integer, both
   stored as given. A crew member's ask carries no files in this build.
9. **One Send per session: `POST /api/hill/answers`.** The gate is the single answer's (`browserGate(HILL_ANSWER_RIGHT)`),
   this machine only. The body is `{ rid, answers: [{ id, intent, text? }] }`, 1 to 5 answers to open asks of one
   session. Each ask is claimed in the answer lane and closes with its own receipt, under a request id derived from the
   Send's `rid` and its id. ONE operator message is typed, subject "Answers to your asks", its text from the shared
   `answers-message.ts`; the session's other open asks get a "no answer yet" line, last. A repeat of the `rid` answers
   the stored result. A message longer than a WalkyTalky message is a 409 `too_long` with the characters over, and
   nothing closes. An ask that closed before the Send is reported gone; with none left, nothing is typed. A refused
   send opens every ask again. The single answer route still answers an ask, in the one-line form.
10. **The Hill switch gates asks** (`hill_off`), as it gates every Decision.

## Consequences

- An agent learns asks from `collie walky ask --help` (seven rules, under 1,500 bytes) and the skill's short Asks part.
- The phone reads asks from `GET /api/hill` as Decisions; an older phone shows them as plain cards, and an older lead
  posts a member's ask as a plain card, which the member takes back at once with `lead_too_old`.
- The receipts file holds one record per ask answered plus one per Send; its cap (200) covers fewer Sends than answers.
- A Send to a busy session is held by WalkyTalky like any operator message (a running turn, or a draft in the box),
  and delivered when the session is free, or left in the inbox after an hour.
