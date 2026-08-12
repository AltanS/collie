# Plan-approval feedback row — TUI choreography notes

Empirical findings from driving live Claude Code `ExitPlanMode` dialogs in a sandbox pane through
Herdr (`pane.send_keys`, `pane.send_text`, `pane.read`), **2026-08-12**, Claude Code **2.1.228**.
Every row of every table below was produced by sending one keystroke at a time and capturing the
buffer byte-faithfully after each. These are the ground truth behind the free-text handling in
`harness/claude/prompt-select.ts` and the fixtures
`web/src/fixtures/panes/claude--plan-approval--feedback-*.txt`.

## Row 4 is an input, not an option

The plan-approval dialog's last row is an **inline text input**. `Tell Claude what to change` is its
**placeholder**, which is the only reason it reads like an option at all:

```
 Claude has written up a plan and is ready to execute. Would you like to proceed?

 ❯ 1. Yes, clear context (4% used) and use auto mode      ← row 1 varies with
   2. Yes, and use auto mode                                showClearContextOnPlanAccept
   3. Yes, manually approve edits
   4. Tell Claude what to change                          ← the INPUT (placeholder shown)
      shift+tab to approve with this feedback             ← static description sub-line

 ctrl+g to edit in Vim · ~/.claude/plans/<slug>.md        ← footer: family `plan`
```

Pressing `4` does not answer anything — it moves `❯` onto the row and focuses the field. So no
single digit can ever resolve this dialog through row 4, and up-levelling it into a button is always
wrong. That is what `isFreeTextLabel` was already getting right.

## The label is not a reliable marker; the description is

The placeholder holds **only while the box is empty**. Type into it and the label becomes the user's
own words — at which point a label-only test stops matching and the row would be lifted into a live
`keys: ["4"]` button carrying whatever half-written sentence is in the box.

The `shift+tab to approve with this feedback` sub-line is emitted from a **static** `description`
field. It is present in both states and is therefore the marker that identifies the row:

| Box state | Row 4 label | `isFreeTextLabel` | description sub-line |
|---|---|---|---|
| empty | `Tell Claude what to change` | ✔ matches | present |
| typed | `use a guard clause instead` | ✘ **misses** | **present** |

This is why `detectPromptSelectRegion` collects each row's description **before** the free-text
check rather than after it.

## Focus changes what every digit means

The hazard that motivates the bail. While `❯` sits on the input row, the dialog routes **every
digit into the field as a character** instead of answering:

| Pointer | Key | Result |
|---|---|---|
| on rows 1–3 | `1`–`3` | answers the dialog normally |
| on rows 1–3 | `4` | focuses the input; **answers nothing** |
| **on row 4** | any digit | **typed into the field**; dialog stays up |
| on row 4 | `Up` | pointer leaves the row, placeholder returns, digits answer again |
| on row 4 | `Enter` | submits as **deny-with-feedback** (see below) |
| anywhere | `Esc` | cancels the approval; the agent stops and waits |

Measured, from focused-and-empty:

```
   3. Yes, manually approve edits          send_keys ["3"]      3. Yes, manually approve edits
 ❯ 4. Tell Claude what to change          ───────────────►    ❯ 4. 3
      shift+tab to approve with this…                              shift+tab to approve with this…
```

The plan is **not** approved and nothing on the phone reports a failure. In that state the three
answer rows still parse as a perfectly ordinary menu, so a grammar that lifts them puts buttons on a
phone that are indistinguishable from working ones and that silently type into a sentence someone
else is in the middle of writing. Hence: **`❯` on the free-text row ⇒ decline the whole dialog** and
fall back to the raw mirror + keys pad, the same rule as the >9-option ceiling.

Note the text **survives losing focus** — `4`, type, `Up` leaves the words on the row with the
pointer elsewhere. That state is real, it is the one
`claude--plan-approval--feedback-typed.txt` captures, and in it the digits *do* answer; only the
description test keeps row 4 from becoming a button.

## What `Enter` and `Esc` actually deliver

Both were read back out of the agent's own transcript, not inferred from the screen.

- **`Enter` with text in the box** — deny-with-feedback. The tool result is:

  > The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a
  > file edit, the new_string was NOT written to the file). To tell you how to proceed, the user
  > said:
  > `use a guard clause instead`

  The agent keeps planning; permission mode stays `plan`.

- **`Esc`** — the same rejection without the feedback clause:

  > …The tool use was rejected … STOP what you are doing and wait for the user to tell you how to
  > proceed.

  It does **not** discard the plan: the plan file stays on disk and in the agent's context. It
  cancels the *approval* and halts the turn, which frees the composer.

## Hazards for anyone automating this

1. **`shift+tab` is approve-*with*-feedback, not approve.** It is also the key
   [#89](https://github.com/AltanS/collie/issues/89) reports as not getting through, so only
   deny-with-feedback is reachable from the phone today.
2. **`Up` as a recovery keystroke is only verified on an empty / single-line field.** Whether it
   leaves a multi-line draft or merely moves the caret inside it was not measured — do not bake it
   into a keystroke plan on the strength of this document.
3. **The footer never changes.** `ctrl+g to edit in Vim · ~/.claude/plans/…` is present in every
   state above, focused or not, so `classifyFooter` returns `plan` throughout and the footer is
   **not** usable as a focus discriminator. (This is the opposite of the notes flow, where focus is
   exactly what adds `ctrl+g` — see `NOTES_NOTES.md`.) Pointer position is the only signal.
4. **Row 1 is install-dependent.** `showClearContextOnPlanAccept` adds
   `Yes, clear context (N% used) and use auto mode`, so the dialog is 3 or 4 rows plus the input.
   Nothing may key on a fixed option count.
