# omp `ask` tool: keystroke recipe

The choreography notes file the Tier-2 bar asks for (`HARNESS_CONTRIBUTING.md`), for the second omp
screen the adapter lifts ([ADR 0077](../../../../../.adr/0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md)).
Grammar: `ask.ts`. Corpus: `omp--select-menu.txt` and `omp--select-menu-moved.txt` (omp 17.2.12,
2026-08), `omp--select-menu-other.txt` and `omp--select-menu-noted.txt` (omp 18.4.4, Nerd Font preset,
2026-10-01), `omp--v18-4-ask-*.txt` (omp 18.4.10, 2026-10-02), `omp--v18-8-ask-single-described.txt`
(omp 18.8.0, 2026-10-07), `omp--v18-8-ask-single-described-moved.txt` (omp 18.8.7, 2026-10-10),
and `omp--v18-10-ask-*.txt` (omp 18.10.3, 2026-10-13). Key semantics come from the published
Ask dialog implementation in those versions and the live probes below.

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

An option with a `description` prints it on rows of its own under the label, six columns in,
wrapped at that indent. The 18.4.10 source already draws these rows; 18.8.0 is where they were first
captured (`omp--v18-8-ask-single-described.txt`, 217 columns, cut narrow here):

```
│ ❯ ○ Staging (Recommended)                      │
│       Deploy to the staging cluster first, run │   a description, wrapped onto more rows
│       the full smoke suite against it, …       │
│   ○ Production                                 │
│       Ship straight to production.             │
│   ○ Skip                                       │
│       Do not deploy now.                       │
│   ○ Other (type your own)                      │
```

omp draws every option's description wherever the pointer is: one `Down` changes the pointer column
and nothing else (`omp--v18-8-ask-single-described-moved.txt`). It shows the first two rows of a
description and adds `<key> expand` to the footer when any description runs longer. At the same
indent it also prints an answer typed earlier under `Other`, and an option's `preview` behind a `│`
rail of its own.

## What a tap sends

| Tap | Keys |
|---|---|
| the pointed row | `Enter` |
| a row below the pointer, `n` rows down | `Down` × n, then `Enter` |
| a row above the pointer, `n` rows up | `Up` × n, then `Enter` |
| `Other (type your own)` | the same walk, then `Enter` |
| the card's last row | `Escape` |

The plan is not sent as one batch: the arrows go first, bound to the tapped screen, and `Enter` goes
only bound to a fresh read that shows the pointer on the tapped row (walk, verify, commit,
[ADR 0080](../../../../../.adr/0080-a-pointed-list-is-walked-verified-then-confirmed.md)). No digit
anywhere: the screen printed none, and the dialog ignores digits.

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
2. The footer matches one captured preset. Current OMP may append `Alt+H hide`, then
   `Ctrl+O expand` or `Ctrl+O collapse`. A unicode batch adds exactly `⇥/←/→ question` and
   requires its styled tab strip. Unknown controls and scroll indicators still decline.
   `expand` offers only Expand/Cancel; answer buttons require the untruncated screen.
3. The body is option rows, each followed by its description rows if it has any, then blank rows.
   Every option row carries that preset's pointer or a space, then its radio, then a label.
   A batch may show one saved `◉` answer when revisited; a single question may not.
   A description row is exactly six columns in and sits under an option or under that
   option's previous description row, never under `Other`, never behind a `│`, and never opening
   with the preset's radio or pointer. Its rows join, one space apart, into the option's description
   on the card.
4. The last option is exactly `Other (type your own)`, no other row is, and at least one option sits
   above it.
5. Exactly one pointer.
6. A divider, question rows and the title `╭─ Ask ─╮` above the body. More than four question
   rows require the measured `Ctrl+O collapse` state. A batch has exactly one styled active tab;
   its index binds the walk identity and its styled region binds each write.
7. A signature no longer than the bridge accepts as a bound region (32000 characters here).

Anything missing returns null, and the screen stays raw with the unread-dialog card's Escape over it.

## What is not modelled

- **`n note`.** It opens the same editor for a note on the pointed row. `PromptModel` has no field for
  a footer action, so the card does not offer it; the Keys drawer sends `n`. A saved note shows as
  the row's description, `✎ note`, or as `✎ note · <description>` when omp prints one under the row.
- **The multi-select dialog** (see below).
- **Multi-select toggles, tab navigation and clipped lists.** (Previews: lifted on 18.12.6, see the end.) No new key recipe is inferred.

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
  A tap on `Other` opened the answer editor. These taps were made with the old one-batch plan; the
  walk, verify, commit of ADR 0080 has not been probed live. The multi-select dialog drew no option card, only the
  Escape card, as designed. Not probed: a composer reply typed into the editor after the `Other` tap
  (PR 336 covers the editor itself), the Cancel row on this card, a pointer moved at the desk between
  the render and the tap, and the Nerd Font preset.
- **Probed live, 2026-10-10 (omp 18.8.7, Herdr, paired headless browser).** At 217 columns the
  same call draws the 18.8.0 capture's Ask region again. After one `Down` the region matches it
  byte for byte except the two rows the pointer left and reached, and `Escape` reports `Ask tool was
  cancelled by the user`. At 120 columns, against the web app from the #372 branch, a call whose
  first description wraps to two rows drew the card with each description on its option. A tap on
  `Production`, under that description, walked `Down` and confirmed with `Enter`, the prompt binding
  passing on both requests (ADR 0080), and the agent echoed `Production`. A first description too
  long for two rows put `Ctrl+O expand` in the footer: that screen drew no card at all, not even the
  Escape card, because `modalOnScreen` is false for it, on main too. The multi-select dialog drew the
  Escape card, its mirror wrapping or panning with Wrap lines before and after Put away; there
  `Space` toggled the pointed row and `Enter` submitted the ticked rows alone, as in 18.4.10. Not
  probed: a tap on the pointed row, on `Other` or on Cancel of a described card.
- **Still declined without a complete captured grammar:** wrapped option labels, a saved
  custom answer displayed under `Other`, scrolling option lists/reviews, note rows in review,
  `ask.timeout` countdown titles and the `ascii` preset. Long questions and descriptions are now
  captured in their collapsed and expanded states, as described below.
- **A recommended option** carries ` (Recommended)` after its label and starts with the pointer on
  it. Both are read off the screen as they are, so nothing special is needed
  (`omp--v18-8-ask-single-described.txt`: `Staging (Recommended)`, pointed when the dialog opens).

## OMP 18.10.3: current footer, batches and long questions (2026-10-13)

The prior exact footer rejected even a short one-question Ask because OMP added `Alt+H hide`.
Removing only that hint made the same real capture lift. A three-question call still declined:
its tabbed layout was outside the earlier grammar. In Chat this left the journal card saying
`Waiting for an answer` with no interactive dock; the journal itself is intentionally read-only.

The current question uses the same guarded pointer walk. Enter saves the answer and advances;
the final review is a separate card. Its footer is `⏎ submit · ↑/↓ scroll · ⎋ cancel · Alt+H hide`.
Up/Down scroll here, so Submit sends only Enter. Recognition requires each numbered answer in tab
order, the active Submit tab and the static `❯ Submit` row. A warning, missing answer or clipping
declines instead of submitting unseen answers. The numbers are never digit shortcuts.

Only background/bold styling identifies the active tab. Plain text alone cannot distinguish
identically worded steps: the tab index is part of `coreSignature`, and `expected_styled` binds
the full region at entry and commit. Pointer movement alone keeps the core identity.

OMP truncates questions past four rows and descriptions past two rows, advertising `Ctrl+O expand`.
The card first offers Expand, sending that key alone. Once `Ctrl+O collapse` proves the expanded
state, the card shows the complete captured text and the answer options.

**Live probe:** isolated bridge and real Herdr/OMP pane, paired Chromium mobile viewport. A long
three-question Ask expanded, then taps chose Below / Change / Confirm; the review showed those
answers, Submit closed it, and the agent echoed all three. A separate run submitted a typed
custom answer through the existing Other editor, then Keep / Confirm and the final review;
the agent echoed the custom text and both choices. No component or shared action model changed.

`src/components/agent-chat-omp-ask.test.tsx` replays the real captures through Chat: the unmodified parser fails
to draw single and batch controls; the corrected parser completes their guarded key sequences.
Unit cases also reject a style-only successor step, ambiguous tabs and incomplete reviews.
Batches and the review are lifted only for the default glyph preset.
Not live-probed: a desk/phone race, non-default symbol presets for batches, multi-select toggles,
scrolling lists or timeout dialogs. These are not claimed as supported by this change.

## omp 18.12.6: option previews (2026-10-25)

Corpus: `omp--v18-12-6-ask-previews--w120.txt` (omp-gang tester 04, case 9; plain pane read, last 30 rows).
Source: pi-tui `overlays/ask-dialog.ts` `renderRowLabel` and `renderCachedPreview`. Each option with a
`preview` draws it under its label and description, one row per rendered line, as `      │ <line>`. The
preview is markdown or fenced code, so a row may be empty. Above the panel omp also echoes the call as
`╭─── Ask 1 questions`; that block lies above the `╭─ Ask ─╮` title and the grammar never reads it.

| What | Evidence |
|---|---|
| Rows: label, description, then `│ ` preview rows, all six columns in | capture, source |
| Preview is drawn for every option whatever the pointer | source (`renderRowLabel` has no pointer test for it) |
| Footer `⏎ select · n note · ↑/↓ move · ⎋ cancel · Alt+H hide` | capture; already accepted |
| A tap is the same walk and Enter | source; not probed on a card |

Declined: a preview under `Other` or under no option, a description row after a preview, a preview of
blank rows only, and a hidden or bidi character.

The plan-mode question follows the same shape: `omp--v18-12-6-ask-plan-mode--w120.txt` (omp-gang tester 14, plan
mode on, "Gather task for plan mode"). Four choices with a description and a preview each, `Other (type your own)`
last, the footer `⏎ select · n note · ↑/↓ move · ⎋ cancel · Alt+H hide`. The echo block above the panel and the
status row on its first line are outside the region. The choices are fixed text, so the card is the ordinary one:
a choice is a walk and Enter, `Other` opens the answer editor (the phone types there), Cancel is Escape.
