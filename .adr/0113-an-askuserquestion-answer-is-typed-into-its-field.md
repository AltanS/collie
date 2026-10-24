# 0113: an AskUserQuestion answer is typed into its field

- **Status:** Accepted
- **Date:** 2026-10-14
- **Shipped in:** 1.24.0
- **Trail:** the 2026-09-26 rule that AskUserQuestion's `Type something.` row is "read, shown, and
  never typed into" (`web/src/lib/grammar/PLAN_FEEDBACK_NOTES.md`, `CLAUDE.md`), against an
  operator who answers interviews from the phone and could only pick a preset or end the whole
  interview with "Chat about this" ·
  `web/src/lib/answer-field.ts` · `web/src/lib/prompt-action.ts` ·
  `web/src/lib/wizard-action.ts` · `web/src/lib/multi-select-action.ts` ·
  `web/src/lib/harness/claude/prompt-select.ts` · `web/src/lib/harness/claude/wizard.ts` ·
  `web/src/lib/harness/claude/multi-select.ts` ·
  [`ASK_FIELD_NOTES.md`](../web/src/lib/grammar/ASK_FIELD_NOTES.md) ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md)

## Context

Claude Code's AskUserQuestion dialog ends its options with a text field, `N. Type something.`. In
the terminal you can type your own answer there, per question, and keep going through a
multi-question interview. Collie modelled the row so a focused field could lock the option
buttons, but it never typed into it: the single-question card refused the send, the wizard dropped
the row, and the multi-select card dropped it too. From the phone the only ways out of a question
were its presets and "Chat about this", which ends every remaining question at once.

The rule was not arbitrary. The sibling row on the plan dialog cannot be cleared (Backspace at the
caret's position 0 is a no-op), and a digit sent while a field has focus is typed as text. Both
facts were measured; neither had been measured on this row. Measured on Claude Code 2.1.299, a
keystroke at a time (`ASK_FIELD_NOTES.md`):

- On a single question and a wizard step, the field's digit focuses an EMPTY field and answers
  nothing; typing then `Enter` answers with the typed text (a wizard also advances one step).
- The same digit on a field that already HOLDS text answers with that text at once. No other
  keystroke on this dialog commits an answer so silently.
- On a multi-select question the digit only ticks the field's checkbox; the pointer has to be
  walked onto the row. Typing into an empty field ticks it; `Enter` toggles the tick.
- `ctrl+u` and `ctrl+k` clear the current visual line of the field. Repeated rounds of the pair
  empty even a wrapped value from any caret position, and are no-ops on an empty field.

## Decision

1. **Collie types an answer into AskUserQuestion's field**, on a single question, on a wizard's
   single-choice step and on a multi-select question (standalone or a wizard step). Every other
   harness's free-text row keeps its `free-text` purpose and stays untyped; their recipes were
   never measured.
2. **The field's digit is sent only while the field is empty.** A filled field is reached by a
   bounded, verified walk of `Up`/`Down`, never by its digit.
3. **A filled field is cleared only when it holds exactly the text the person saw when they
   tapped.** Anything else means someone at the desk is mid-sentence, and the send is refused with
   nothing cleared. The clear is rounds of `ctrl+u ctrl+k`, each re-read, capped.
4. **Typing waits for a verified focused field, and the commit waits for the exact text.** The
   `Enter` that answers (single, wizard) is bound to the read that proved the text. On a
   multi-select question nothing is committed: the row is filled and ticked, and the person still
   taps Next or Submit.

## Consequences

- The phone can answer a whole interview in its own words, and can change an earlier typed answer.
- A desk user mid-sentence costs the phone a refusal, never their text. The equality check is the
  only thing that protects them, so it must not be relaxed to "the field is non-empty".
- Wizard step arrows lock while the field has focus, because `Left` then moves the caret instead
  of the step.
- Revisit this if Claude Code changes what the field's digit does on a filled field, or adds a
  single key that clears the whole field; both are in `ASK_FIELD_NOTES.md`'s re-walk list.

## Addendum (2026-10-20, maintainer)

This addendum answers the two questions from the pull request thread. Nothing above is rewritten.

1. **Receipt.** A typed answer goes out through the one key path, keys plus a reply. It carries
   no request id, like every key tap today. The Ask v1 receipt is not used. The long-term design
   lists key taps as one open item for all of them, not new here.
2. **Claude only.** The feature is on only when the reader emits `purpose: "answer"` and a
   `field`. Today only the Claude reader does that. The measured keys live in the shared action
   modules: `ctrl+u ctrl+k`, the digit behaviour, and `Enter` toggling the tick. A second harness
   that emits `field` must first measure its own keys. Those keys must then move into profile data
   before the feature is switched on for that harness.
