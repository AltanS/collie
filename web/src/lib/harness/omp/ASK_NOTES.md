# omp `ask` tool: keystroke recipe

The choreography notes file the Tier-2 bar asks for (`HARNESS_CONTRIBUTING.md`), for the second omp
screen the adapter lifts ([ADR 0077](../../../../../.adr/0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md)).
Grammar: `ask.ts`. Corpus: `omp--select-menu.txt` and `omp--select-menu-moved.txt` (omp 17.2.12,
2026-08), `omp--select-menu-other.txt` and `omp--select-menu-noted.txt` (omp 18.4.4, Nerd Font preset,
2026-10-01), `omp--v18-4-ask-*.txt` (omp 18.4.10, 2026-10-02). Behaviour below is read from
pi-tui's `overlays/ask-dialog.ts` in the published omp 18.4.10 packages and checked against those
captures.

## What the screen prints

omp 18.4.10, a one-question single-select call (`omp--v18-4-ask-single.txt`, 108 columns):

```
╭─ Ask ──────────────────────────────────────────╮
│ Pick a color                                   │   the question, up to four rows
├────────────────────────────────────────────────┤
│ ❯ ○ Red                                        │   pointer column, radio, label
│   ○ Green                                      │
│   ○ Blue                                       │
│   ○ Other (type your own)                      │   omp adds this row last, always
│                                                │   blank rows pad the body
├────────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⎋ cancel        │
╰────────────────────────────────────────────────╯
```

The same box in the other two keycap dialects:

| Preset | Footer | Pointer | Radio | Capture |
|---|---|---|---|---|
| glyph keycaps (18.4 `unicode`, the default) | `⏎ select · n note · ↑/↓ move · ⎋ cancel` | `❯` | `○` | `omp--v18-4-ask-single.txt` |
| text keycaps (17.x) | `Enter select · n note · ↑/↓ move · Esc cancel` | `❯` | `○` | `omp--select-menu.txt` |
| Nerd Font (`nerd`) | `U+F0311 select · n note · ↑/↓ move · U+F12B7 cancel` | U+F054 | U+F10C | `omp--select-menu-other.txt` |

A row with a saved note ends in `  ✎ note` (`omp--select-menu-noted.txt`).

## What a tap sends

| Tap | Keys |
|---|---|
| the pointed row | `Enter` |
| a row below the pointer, `n` rows down | `Down` × n, then `Enter` |
| a row above the pointer, `n` rows up | `Up` × n, then `Enter` |
| `Other (type your own)` | the same walk, then `Enter` |
| the card's last row | `Escape` |

One batch per tap. No digit anywhere: the screen printed none, and the dialog ignores digits.

What each key does, from omp 18.4.10's `handleInput`:

- `Up` and `Down` move the pointer and clamp at both ends. A walk to a row on screen never needs a wrap.
- `Enter` on an option, in a one-question dialog, records that option and closes the dialog. The
  agent gets the answer at once. There is no review screen for one single-select question.
- `Enter` on `Other (type your own)` opens the answer editor, titled `Custom answer: <question>`.
  This one was pressed by hand on omp 18.4.4 (`omp--answer-editor-empty.txt`, PR 336). omp's adapter
  reads that box as an input (`answer-editor.ts`), so the phone's composer types the answer and Enter
  submits it. `Escape` in the editor returns to the dialog with nothing recorded.
- `Escape` cancels the dialog. omp reports the call as cancelled by the user.

The 17.2.12 text-keycap dialog is lifted on its footer alone: it prints `Enter select` and no tab
segment, so the screen has no Submit tab to advance to, and `Enter` is the only way it can answer.
Its source is not on this host.

## What the grammar requires, all of it

1. The bottom border is the last non-blank row, the footer is the row above it, and a divider sits
   above the footer.
2. The footer is exactly the four segments of ONE preset in the table above, nothing more or less.
   This one check pins three facts: a single-select question (multi-select prints `toggle`), a
   one-question dialog (several questions add a `⇥/←/→` tab segment, and there `Enter` advances to
   the next question), and arrows as the move keys (omp prints the user's own binding).
3. The body is option rows, then blank rows. Every option row carries that preset's pointer or a
   space, then that preset's unselected radio, then a label.
4. The last option is exactly `Other (type your own)`, no other row is, and at least one option sits
   above it.
5. Exactly one pointer.
6. A divider, one to four question rows, then the title `╭─ Ask ─╮` above the body.
7. A signature no longer than the bridge accepts as a bound region (32000 characters here).

Anything missing returns null, and the screen stays raw with the unread-dialog card's Escape over it.

## What is not modelled

- **`n note`.** It opens the same editor for a note on the pointed row. `PromptModel` has no field for
  a footer action, so the card does not offer it; the Keys drawer sends `n`. A saved note shows as
  the row's description, `✎ note`.
- **The multi-select dialog** (see below).
- **A multi-question call.** Its footer adds the tab segment, so the grammar declines every step of it.

## The multi-select dialog stays raw

The two footers disagree about what Enter does:

| Version | Footer | Enter on an option |
|---|---|---|
| 17.2.12 | `Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel` | toggles the row |
| 18.4.10 | `␣ toggle · ⏎ submit · ↑/↓ move · ⇥/←/→ · ⎋ cancel` | submits the whole set at once |

In 18.4.10 a toggle is a walk then `Space`, Enter on an option submits the checked set without
toggling the pointed row, and both `Space` and `Enter` on `Other` open the answer editor. The
`toppings / Submit` tab strip leads to a review screen (`omp--select-multi-review.txt`) that prints a
numbered summary, `1. toppings: Cheese, Olives`, then `❯ Submit`.

No shared model carries a walk-then-Space toggle. `MultiSelectModel` knows a digit toggle and a
digit-jump-then-Enter toggle, and omp ignores digits. Adding a third recipe changes the core macro
in `lib/multi-select-action.ts`, which is its own decision. Until then these screens keep the raw
mirror and the Escape card. ADR 0077 says what a later slice needs.

## Not proven by the captures

- **Probed live, 2026-10-02 (omp 18.4.10, Herdr, 109 by 59, paired headless browser).** A real Ask
  dialog (`Pick a color`: Red, Green, Blue, Other) drew the card with four option buttons and Cancel.
  Taps on Blue, Green, Red and Blue each answered the agent with that colour (the agent echoed it).
  A tap on `Other` opened the answer editor. The multi-select dialog drew no option card, only the
  Escape card, as designed. Not probed: a composer reply typed into the editor after the `Other` tap
  (PR 336 covers the editor itself), the Cancel row on this card, a pointer moved at the desk between
  the render and the tap, and the Nerd Font preset.
- **Shapes read from source, none captured, all declined:** an option with a description (rows six
  columns in), a label that wraps (rows four columns in), an option with a preview, a list taller
  than the body (scrollbar cells and a `↑`/`↓` indicator in the footer), a question past four rows
  (`ctrl+o expand` in the footer), the `ask.timeout` countdown (`Ask (30s)` in the title), and the
  `ascii` symbol preset. Each needs its own capture before the grammar may read it.
- **A recommended option** carries ` (Recommended)` after its label and starts with the pointer on
  it. Both are read off the screen as they are, so nothing special is needed. Not captured.
