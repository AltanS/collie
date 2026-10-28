# AskUserQuestion's `Type something.` field — TUI choreography notes

Empirical findings from driving live Claude Code `AskUserQuestion` dialogs in a throwaway Herdr pane
(`herdr agent send-keys`, `herdr pane send-text`, `herdr agent read --source visible`), measured
**2026-10-14** on Claude Code **2.1.299**, Herdr 0.9.4, Windows, a 157-column pane. Every row below
was produced by sending one keystroke (or one paste) at a time and reading the screen after it; every
answer was read back out of the agent's own session journal (`The user answered: …`), not inferred
from the screen. These are the ground truth behind `lib/answer-field.ts`, the field branches of
`prompt-action.ts`, `wizard-action.ts` and `multi-select-action.ts`, ADR 0113, and the fixtures
`web/src/fixtures/panes/claude--v2299-ask-field-*.txt`.

The plan dialog's input row is a different field with different rules; see
[`PLAN_FEEDBACK_NOTES.md`](./PLAN_FEEDBACK_NOTES.md). The preview variant has no such row at all
(re-confirmed on 2.1.299): its notes field is the free-text channel (`NOTES_NOTES.md`).

## Single question

```
 ☐ Color

Which color do you prefer?

  1. Red
     A warm color
  …
❯ 4. Teal, like the sea                ← the field, typed into; placeholder `Type something.`
───────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel
```

| From | Key | Result |
|---|---|---|
| pointer on row 1, field empty | `4` | pointer onto the field, focused; footer gains `ctrl+g to edit in Notepad` (`nano` on Linux). Answers nothing |
| field focused, empty | paste `Teal, like the sea` | the label becomes the text |
| field focused, holding text | `Enter` | **answers** with the text: `"Which color do you prefer?"="Teal, like the sea"` |
| pointer elsewhere, field holding text | `3` (the field's digit) | **answers at once with the held text** (`…Otter` was submitted, never focused) |
| field focused, holding text | `Up` then `Down` | back on the field; caret at position 0 (a paste of `X` gave `XTeal…`) |
| field focused, wrapped value | `Up` / `Down` | move the caret between the value's visual lines; the pointer stays on the field |

The value re-flows on word boundaries, its continuation lines indented five columns under the label,
like the plan row.

## Wizard (several questions)

| From | Key | Result |
|---|---|---|
| field empty | the field's digit | focuses it. Does **not** advance (an option's digit selects AND advances) |
| field focused, holding `Mango` | `Enter` | answers and advances one step (`☒ Fruit`, now on the next question) |
| field focused | `Left` | moves the caret one cell left; the step does not change |
| field focused | `Tab` | nothing |
| an answered-by-typing step, revisited | — | the field row reads `3. Mango ✔`; pointer reset to row 1 |
| that step, field holding `Mango` | the field's digit | **answers with `Mango` and advances**, like an option |
| that step | `Down` × n onto the field | focused; the row reads `❯ 3. Mango  ✔` (the extra space is the caret cell); caret at the END (`MangoZ`) |
| field focused, `Mango` | `ctrl+u` `ctrl+k` | empty: `❯ 3. Type something. ✔` |
| then paste `Kiwi`, `Enter` | | answers and advances; the review shows `→ Kiwi` |

The submitted result was `"Which fruit?"="Kiwi", "Which drink?"="Tea", "Which city?"="Lisbon"`.

## Multi-select (standalone, and a wizard's checkbox step)

```
←  ☐ Toppings  ✔ Submit  →             (a wizard step: ←  ☐ Toppings  ☐ Size  ✔ Submit  →)

  3. [ ] Basil
         Fresh basil leaves
❯ 4. [✔] Mushroom                     ← the field: placeholder `Type something` (no period)
     Submit                            (a wizard step: `Next`)
───────────────────────────────────
  5. Chat about this
```

| From | Key | Result |
|---|---|---|
| pointer on row 1 | the field's digit | **toggles the field's checkbox**; the pointer does not move; nothing is focused. Text pasted now is not typed into the field (see the stray-text hazard) |
| pointer on row 1 | `Down` × 3 | pointer on the field, focused (footer gains `ctrl+g`) |
| field focused | a digit | typed into the text (`Pineapple2`) |
| field focused, empty, unticked | paste `Mushroom` | `[✔] Mushroom`: typing into an empty field **ticks** it |
| field focused, holding text | `Enter` | **toggles** the tick; the text stays |
| field focused, holding text | `ctrl+u` `ctrl+k` | empty AND **unticked** |
| field focused | `Left` | moves the caret (also on a wizard step) |
| field focused | `Down` | onto `Submit` / `Next` |
| pointer on `Submit` | an option's digit | **nothing**: no row toggles (the footer still shows `ctrl+g`) |
| pointer on an option row | an option's digit | toggles that option, pointer stays |
| pointer on `Submit` | `Up` | onto the field, focused; `Up` again leaves it for the option above |

Submit → review → `1` gave `"Which toppings?"="Cheese, Mushroom"`; on a wizard step, Next → the next
question, and the result was `"Which toppings?"="Pineapple", "Which size?"="Small"`.

## Clearing

- `ctrl+k` deletes to the end and `ctrl+u` to the start of the **current visual line**, not of the
  whole value. On a wrapped value, each press clears one display line.
- From an unknown caret position on a three-line value, rounds of `ctrl+u ctrl+k` emptied the field
  in two or three rounds. A round on an empty field changes nothing.
- So the recipe is: send a round, re-read, repeat until the field reads empty, with a cap.

## Long answers

Measured **2026-10-27** on Claude Code **2.1.306** in a 153×48 tmux pane (the test "a value
wrapped onto twenty display lines" in `harness/claude/prompt-select.test.ts` rebuilds that
screen):

- The field never windows or collapses a paste: a 2834-character answer re-flowed onto 21 display
  rows, every continuation row indented five columns. At 60 columns the same answer took about 55
  rows and pushed the question and the first options off a 48-row screen.
- The field is not the last row (`Chat about this` follows it), so its wrap does not move the footer
  away from the last option, as the plan row's does. It moves the FIRST options away from the footer:
  in the capture they sit 28 rows above it, past the old 24-row option scan, and the whole dialog fell
  to the raw mirror.
- So the grammars add `MAX_ANSWER_WRAP` (24 rows) to their option scan, and `lib/answer-field.ts`
  counts the rows an answer will take at the pane's width (`answerFits`, after the widest label
  prefix, a multi-select's `❯ 4. [✔] `) and refuses before any key when the field would pass that
  allowance or the whole dialog would pass the option scan. The editor's own cap is `ANSWER_MAX_LENGTH` (4000), apart from the plan
  row's `FEEDBACK_MAX_LENGTH` (240), which is bound by the footer.
- `Chat about this` answers the tool with "User declined to answer questions"; a text too long for
  the pane goes as an ordinary message after it.

## Hazards for anyone automating this

1. **Never send a filled field's digit.** On a single question and a wizard step it submits the held
   text; it is the one keystroke on this dialog that commits an answer the person may never have
   meant to send. Reach a filled field by walking `Up`/`Down`.
2. **Text sent while the pointer is NOT on a focused field is not dropped.** It surfaced later in
   Claude's own prompt box, after the dialog closed. Type only after a read shows the field focused.
3. **Focus kills step navigation.** In a wizard, `Left` moves the caret while the field has focus.
4. **The caret position on re-entry is not stable.** It was at 0 after leaving and re-entering on a
   single question, and at the end on a revisited wizard step. Do not rely on it; the clear recipe
   does not.
5. **A digit sent before the dialog has drawn is lost.** Re-read before each step.

## Re-walk list

Re-walk this document before changing the recipe if Claude Code changes what the field's digit does
on a filled field, adds a single key that clears the whole field, or stops ticking a multi-select
field when it is typed into.
