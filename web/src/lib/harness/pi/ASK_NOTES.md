# OmO single-choice questions reported as `pi`

Captured on 2026-10-12 with OmO 5.1.30 (engine Senpi 2026.10.11), Herdr 0.9.3,
in a disposable sandbox tab at 113 columns. Herdr reports this executable as `agent: "pi"`.
The adapter lifts only OmO's built-in `ask_user_question` / `request_user_input` screen,
not every question extension a pi installation might load.

## The captured screen

The question replaces the composer between two horizontal rules. The ordinary styled status
tail remains below the lower rule.

```text
────────────────────────────────────────────────────────────

 Ask user · 30m
 → Color    Submit
 Pick a color for the Collie sandbox probe?
 → 1. Red (Recommended)
      Warm color.
   2. Green
      Cool color.
   3. Blue
      Deep color.
   Type your own answer...
 Submit (0/1 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel

────────────────────────────────────────────────────────────
```

`pi--omo-v5130-single-described.txt` and its `-moved` twin differ only in the pointer.
The single question's descriptions are required by the public tool: a live call with no
descriptions returned `option description is required` without opening a dialog.

## Verified key recipe

| Action | Keys | Observed result |
| --- | --- | --- |
| Select Blue while the pointer is on Blue | `3` | Dialog closes; agent echoes `PROBE_ANSWER=Blue` |
| Move the pointer | `Down`, `Up` | Only the pointed option changes; all descriptions remain |
| Focus the Other row | `Down` to the last row | `→ Type your own answer...` |
| Open Other's editor | `Enter` on that row | `Your answer ...` and `> ` input; footer changes |
| Discard the empty Other editor | `Escape` | Returns to the question |
| Cancel an unanswered question | `Escape` | Tool reports `cancelled`; agent resumes |
| Cancel a multi-select question | `Escape` | Tool reports `cancelled`; agent resumes |

**A choice sends its printed digit alone, never a trailing Enter.** The runtime's
`dist/modes/interactive/components/ask-user-question-keys.js` dispatches `1` through `9`
to `activateOption`; for one question and `multiSelect: false`, it immediately calls
`attemptSubmit`. The `3` probe above confirmed this against the live agent.
The arrow walk used by omp is unnecessary here, and no new action-layer recipe is added.

The detector requires the exact single-select footer, one question chip plus Submit, the
`0/1 answered` line, contiguous numbered options with descriptions, exactly one option
pointer, and the unpointed Other field. Its signature includes the whole dialog, including
the pointer and countdown; the changing status counters below it do not affect a tap.
A changed countdown can refuse a stale tap, which is the safe side.

## Screens deliberately kept raw

- Multi-select: `space toggle`, `enter toggle`, `tab next / Submit`. Enter toggles, not submits.
  `pi--omo-v5130-multi.txt` is the negative control.
- Focused Other row and its answer editor: captured separately. No digit buttons or composer
  typing are enabled there; the user can use the terminal view and Keys. The unread-dialog
  card names Escape, which discards the editor rather than promising to cancel the whole call.
- Several questions, review/comment tabs, existing answers, unfamiliar footers, more than nine
  options, missing/clipped rows and unknown status tails. No recipe is inferred.
- Stock pi's optional `question` extensions. Their screens are not read; the raw mirror stays.

## Stock pi's editor, and why this adapter reads it

Registering any adapter for `pi` moves every `pi` pane off the one-step send and onto the guarded
one (`lib/reply-action.ts`), which types only when `composerReady` says yes and submits only when
the draft reads back. So the stock pi editor has to be read too, or a stock pi send is refused.

Stock pi 0.85.1 (`pi--v0851-idle.txt`, `pi--v0851-draft.txt`, 2026-10-12, run through `bunx` in a
sandbox pane) draws the same frame without the prompt glyph: a rule, the draft at column zero,
a rule of the same colour, then styled status rows. While a turn runs, the top rule carries a
label (`── ⠴ Working ───`, `pi--v085-working-editor.txt`), and so does OmO's. A row between the
rules that opens with a space is never a stock draft, which is what keeps OmO's Ask dialog from
reading as one; `composerReady` also refuses whenever `askModalOnScreen` holds.

**Probed live, 2026-10-12:** a phone send of `collie stock pi send probe` to that stock pi pane
typed, read back and submitted. Pi answered `No API key found` (the sandbox has no login) and
the editor was empty again.

## Comparison with omp and upstream PR 397

omp's Ask is a bordered radio list ending in `Other (type your own)`, with a footer naming
arrows and Enter. Its taps walk, verify the pointer, then commit with Enter.
OmO instead prints digits, `→`, a separate unnumbered field, and a persistent status tail.
Only the neutral `PromptModel`, renderer and guarded action dispatch are reused.

Stock pi's [built-in tool registry](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/index.ts)
does not include this question tool. This host's `pi` executable is Senpi/OmO, not a separate
stock pi installation, so a stock pi live question was not claimed.
[PR 397](https://github.com/AltanS/collie/pull/397) targets pi 1.1.0 with a question extension:
its notes use `["N", "Enter"]`, and its multi-select draws `[ ]` / `[x]`. Those recipes must not
be applied to OmO. Both contributions register `pi`, so their registry integration must be
reconciled if PR 397 lands first.

## Browser verification

**Probed live, 2026-10-12 (OmO 5.1.30, Herdr 0.9.3, this branch's bridge on loopback, paired
headless Chromium at the `iphone-14` preset).** The default Chat view drew the card under the
question with three option buttons, each with its description, plus Cancel. With the pointer on
Red, a tap on Green answered the tool `Color: Green`, and the agent replied
`BROWSER_ANSWER=Green`.

Not probed from the browser: the Cancel button, a pointer moved at the desk between render and
tap, and the unread-dialog card on the multi-select and Other-editor states (those are pinned
by fixtures only).
