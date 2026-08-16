# Plan-approval feedback row — TUI choreography notes

Empirical findings from driving live Claude Code `ExitPlanMode` dialogs in a sandbox pane through
Herdr (`pane.send_keys`, `pane.send_text`, `pane.read`): **2026-08-12** on Claude Code **2.1.228**,
re-walked **2026-08-15** on **2.1.233** (which added §"The caret resets" and the second table below).
Every row of every table was produced by sending one keystroke at a time and capturing the buffer
byte-faithfully after each. These are the ground truth behind the free-text handling in
`harness/claude/prompt-select.ts`, the feedback choreography in `lib/prompt-action.ts`, and the
fixtures `web/src/fixtures/panes/claude--plan-approval--*.txt`.

Throughout, the input row is written as "row 4" because that is where the 2.1.228 capture had it. It
is **row 3** on an install without `showClearContextOnPlanAccept` — see hazard 4. Nothing in the code
keys on the number; it is read off the screen.

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
else is in the middle of writing.

Hence: **`❯` on the free-text row ⇒ no button on this dialog may be pressable.** The model carries the
state (`PromptModel.feedback.focused`) rather than dropping the dialog, so three things can happen at
once: the renderer locks every button behind a banner that says why, `lib/prompt-action.ts` refuses to
write at all, and the feedback flow's own mid-flight polls can *see* the focus they are waiting for.
Polling clears the banner the moment the terminal's pointer moves off.

Note the text **survives losing focus** — `4`, type, `Up` leaves the words on the row with the
pointer elsewhere. That state is real, it is the one
`claude--plan-approval--feedback-typed.txt` captures, and in it the digits *do* answer; only the
description test keeps row 4 from becoming a button.

## The caret resets to position 0 on re-entry

The finding that decides when Collie may type at all. Leave the row and come back to it and the caret
is at the **start** of the existing value, not the end:

| From | Key | Result |
|---|---|---|
| row 4 focused, box holds `use a guard clause instead` | `Up` then `Down` | text intact, pointer back |
| …then `send_text "X"` | | `❯ 4. Xuse a guard clause instead` — **prepended** |
| …then `Backspace` ×30 | | **nothing deleted** — a no-op at position 0 |

So a non-empty box cannot be safely appended to *or* cleared. That is why `submitPromptFeedback`
refuses unless the box is **empty** (`feedback.text === ""`), and why the renderer shows the existing
text as a read-only card instead of an editor: the alternative is garbling a sentence someone at the
terminal is still writing and then submitting the result irreversibly.

## The row RE-FLOWS; it does not window

A value longer than the row does **not** scroll around the caret. Claude re-flows the whole thing
across as many display lines as it needs, indented under the row, with the static hint below them:

```
   ❯ 3. Keep the nested structure instead of a guard clause, but extract each condition into a
        small named predicate so the intent reads at the call site.
        shift+tab to approve with this feedback
```

Three consequences, all measured on 2.1.233 and all load-bearing:

1. **The value has to be rebuilt** from the row's label plus every line above the hint, rejoined with
   the single space the wrap seam consumed. Claude wraps on word boundaries, so this is exact.
2. **The hint stops being the first sub-line**, so a marker anchored at the start of the joined
   description silently stops matching — and the row goes back to being up-levelled into a button
   carrying the user's own words, which is the original bug.
3. **The footer moves away from the options.** A 355-character value pushed it past `MAX_FOOTER_GAP`
   and the *entire dialog* stopped being recognised — it fell to the raw mirror, buttons and all.
   `MAX_FEEDBACK_WRAP` is the allowance that keeps it readable, and `FEEDBACK_MAX_LENGTH` is sized to
   stay inside that allowance even on a narrow pane.

And one more, which is why the mid-flight identity is anchored at the **question** rather than at a
lookback window: growing the dialog makes the terminal re-flow the screen, and **the plan body above
the question comes back differently laid out**. Any signature reaching up into it moves under the
feedback flow's own keystrokes. Verified by diffing the two signatures across a single live
`3`-then-type transition — every line above the question shifted, nothing below it did.

## The verified send: digit → focus → type → Enter

The whole sequence, driven end to end through the real bridge against a live agent (2026-08-15):

```
send_keys ["3"]        → ❯ moves onto the row, field focused        (answers nothing)
  …verify focused
send_text "…", submit=false → the words appear on the row (wrapping if long)
  …verify the rejoined row matches our text EXACTLY
send_keys ["Enter"]    → DENY-with-feedback; the agent re-plans with it
```

The agent's next plan visibly incorporated the text, so this is a confirmed round trip, not a screen
inference — run twice, once with a short value and once with a 185-character one that wrapped onto a
second line. Each step is gated on a fresh read of the one before it, and the Enter is additionally
bound to the region of that last read, so a keystroke at the terminal in the gap earns a refusal from
the bridge rather than a submit aimed at a screen that has moved.

The focus step also requires the box to still be **empty**. That window — our digit landed, our paste
has not — is exactly when a human at the same dialog might start typing, and their fragment would sit
at the head of ours. This row cannot be cleared, so refusing is the only remedy.

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
   `Yes, clear context (N% used) and use auto mode`, so the dialog is 3 or 4 rows plus the input, and
   the input's own digit is 3 or 4. Nothing may key on a fixed option count or a fixed key.
   `claude--plan-approval--three-row.txt` is the fixture that pins the other shape.
5. **Anything typed into the box that reads back as the placeholder reads as EMPTY.** Feedback whose
   text is exactly `Tell Claude what to change` would be typed, then fail its own read-back check and
   sit in the box unsubmitted. Fails safe; not worth a special case, but don't be surprised by it.
6. **Approve-with-feedback is still out of reach.** `shift+tab` is the only key that keeps the plan
   AND passes the note; until [#89](https://github.com/AltanS/collie/issues/89) clears, the phone can
   only deny with feedback. Anyone adding the approve path should re-walk this document first — the
   `Enter` and `shift+tab` results differ in the agent's transcript, not on screen.
