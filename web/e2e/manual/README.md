# Manual live trigger — sidebar-overlay wizard dialogs (issue #347)

This directory holds the documented live flow, not a CI job. Tier 1 (`../*.spec.ts`)
pins the render path with fixtures; what lives here drives a REAL opencode pane once,
by hand, because only a live pane produces overlay chrome (a Models sidebar tail under
the free-text row) that no fixture captures yet.

## Files

- `question-wizard-live.sh` — the six steps as one guarded script (see below).
- `two-question.trigger.txt` — the allowlisted trigger prompt. Its wording comes from the
  corpus transcript itself (`oc--question--two--q1.txt` carries the user message that caused
  that exact call), so it deterministically produces one `question` call with two
  single-select questions. The ONLY prompt this script may send.
- `check-wizard-lift.ts` — verifies a capture lifts to a `wizard` block. Run with bun from
  `web/`; no network, no model, no writes. Committed (not scratch) so every run checks the
  same code the PWA ships.

## The six steps (what the script does, in order)

1. **Snapshot guard** — `herdr api snapshot`: the pane must read `agent_status: idle` AND
   `interactive_ready: true` (agents list). Anything else refuses. Herdr status alone is
   not proof (it has read `idle` under a live dialog before — QUESTION_NOTES.md round
   two), so step 2 checks the screen too.
2. **Dialog guard** — `herdr pane read <id> --source recent --lines 60 --format ansi` must
   NOT contain a dialog footer (`enter confirm|submit|toggle`). Never type into a pane
   with an open dialog: digits submit unseen options.
3. **Trigger** — `herdr pane send-text <id> "$(cat two-question.trigger.txt)"`, then
   `herdr pane send-keys <id> Enter`. Requires `--allow-model-call`: the trigger runs
   exactly one model call, which costs money.
4. **Wait** — `herdr pane wait-output --match "enter confirm" --timeout 180000 <id>`.
   The tabbed dialog's footer is the signal (Herdr status is not).
5. **Capture** — `herdr pane read <id> --source recent --lines 300 --format ansi` to a file.
6. **Verify** — `bun e2e/manual/check-wizard-lift.ts <capture> question`.

Then **clear** (unless `--no-clear`): `Escape` (dismiss), `/new` + `Enter`, snapshot
reads `idle` again. Single steps, then capture, then clear — never a conversation.

## Suitable tabs

Idle opencode tabs with `interactive_ready: true` from `herdr api snapshot` (agents
list). The Q/A-style tabs used so far: an idle tab that has produced question dialogs
before. Never: busy panes, `working`/`blocked` panes, panes with an open dialog, panes
owned by someone else's session, the pane you are working in.

## Safety rules (non-negotiable)

- Never type into a pane with an open dialog — digits submit.
- Never answer or take over foreign sessions — this flow only LIFTS, it never answers.
- Only idle panes (`idle` + `interactive_ready`).
- No bare digits, no free text besides the trigger and `/new`.
- No model calls without explicit user okay (`--allow-model-call`).
- Captures are evidence in `/tmp` — delete when done.
