# Native editor integration checks

These opt-in Vitest cases run the **production** reader/actions/browser API against real Pi and
`@juicesharp/rpiv-ask-user-question`. They supplement, not replace, the required browser leg in
[README.md](./README.md). They are excluded from the ordinary frontend unit run.

## Start isolated fixtures

Use the existing rig's separate HOME/state/socket setup from README.md. Keep authentication enabled,
use synthetic content only, and do not reuse an operator's pane. Installed prerequisites measured
here: Pi 1.4.0, package 2.15.0, English terminal chrome/default bindings and Linux/Herdr. The package
is a test prerequisite, **not** a Collie dependency; these tests install nothing.

In each of **three separate disposable rig panes**, run Pi with the installed package's `index.ts`
and this directory's `editor-questions.json`. Use an isolated Pi agent directory/auth setup, not the
operator's live configuration. A fixture command, with absolute paths substituted, is:

```sh
pi --offline --approve --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-mcp --no-themes --no-builtin-tools \
  --tools ask_user_question -e /installed/rpiv-ask-user-question/index.ts \
  --provider openrouter --model anthropic/claude-haiku-4.5 --thinking off \
  -- @/checkout/web/e2e/rig/editor-questions.json \
  'Call ask_user_question once with these exact parameters. Await the user; choose nothing.'
```

Start scripts can be launched with the rig's existing `bun e2e/rig/rig.ts pane /absolute/start.sh`.
Read each returned pane id; do not predict it. Wait until the native Plan question is visible.
Leave the first two on Plan. Put the third on Submit with four noncommitting Tabs, for example
through the existing rig client from `web/`:

```sh
COLLIE_REVIEW_PANE=returned-id bun -e '
  import { Rig } from "./e2e/rig/leg";
  await new Rig().keys(process.env.COLLIE_REVIEW_PANE!, ["Tab", "Tab", "Tab", "Tab"]);
'
```

That setup creates no answer. The suite navigates the other two fixtures itself. It deliberately
edits/clears synthetic native values during setup; it must never address a live questionnaire.

## Run the public-boundary checks

Preserve the same isolated `HOME` and `COLLIE_RIG_STATE` for these commands:

```sh
cd web
COLLIE_READBACK_PANE=first-id \
COLLIE_SINGLE_PANE=second-id \
COLLIE_REVIEW_PANE=third-id \
  bunx vitest run --config e2e/rig/editor-readback.config.ts \
    e2e/rig/editor-readback.test.ts e2e/rig/editor-single.test.ts \
    e2e/rig/editor-review.test.ts
```

The three primary fixtures cover 44 cases: 38 answer/note read-and-edit cases (including wrapped
multiline save/return), four single-choice/preview cases and two review/global-note cases.
`editor-api.ts` forwards same-origin calls to the real authenticated bridge. It audits every write's text/style bindings and the operation's allowed keys; reads cannot
send text, erasure, Enter, Space or closure. Faults enter at that public API boundary, never through
mocked private helpers. Faulted bodies cannot enter the production ETag cache.

Two additional disposable fixtures exercise the review regressions, bringing the full suite to
50 cases. Launch the same isolated Pi command with `editor-standalone-questions.json` for one call,
and with `editor-successor-questions.json` for **exactly two sequential calls**, first `first`, then
`second`, awaiting each answer without choosing any. Set `COLLIE_STANDALONE_PANE` and
`COLLIE_SUCCESSOR_PANE` to their actual returned ids alongside the other three variables, then omit
the three explicit test filenames to run all five files. Standalone checks cover complete multiline read/return, wrapped and inclusive-limit
save, explicit custom-value removal with authored selections preserved, and bound final advance.
The standalone tests finally submit their synthetic answer; the successor test completes the
first call and cancels the second. Restart those fixtures before another run.

Run on wide and narrow native panes. For a 59-column stacked layout, split only a disposable
workspace using the rig's scoped `herdr` helper from `rig-lib.ts`; never resize the operator's PTY.
The answer wrap boundaries and complete note-viewport boundary come from the fixture's actual
native dimensions. A settled repaint is required after a resize; the corpus retains a genuine
intermediate paint to prove it grants no hidden binding.

## Check the phone and native outcome

Use the existing `phoneOn`/Pixel 7 harness against these same isolated panes. Exercise walked
preview choice, checkbox toggle/advance, complete custom-value save and explicit clear, question
note save/return/removal, single-choice multiline commit, question navigation, global note and
explicit partial/all-answered submission. Check ordinary composer focus and page overflow, and
record only synthetic keys/text and whether bindings were present—never credentials.

For the final result, inspect Pi's **tool-result session entry** (`role: "toolResult"`,
`toolName: "ask_user_question"`) in the isolated agent directory. Assert exact answer/newline/note
values, selected preview, cancellation details and the explicitly unanswered questions there. The
model's later `RPIV_PROBE_ANSWER` is not the authority: it can paraphrase the tool result, choose a
different JSON shape, and wrap quoted values across terminal rows.

Use `bun e2e/rig/rig.ts down` with the same isolated state when finished. It stops only its recorded
processes. Full multi-harness/crew validation still needs every prerequisite in README.md and must
not be reported green from these focused checks alone.
