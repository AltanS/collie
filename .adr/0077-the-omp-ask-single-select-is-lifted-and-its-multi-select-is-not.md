# 0077: The omp Ask single-select is lifted, and its multi-select is not

- **Status:** Accepted
- **Amended in scope by:** [ADR 0078](./0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md):
  the tool-approval dialog this record left assessed but raw is now lifted for `bash` and `write`.
  Everything below stands.
- **Date:** 2026-10-02
- **Shipped in:** 1.16.0
- **Amends:** [ADR 0076](./0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md),
  in scope. 0076 left "the Ask tool's selects" raw; the one-question single-select dialog is now a
  card. The multi-select dialog, the multi-question dialog and everything else 0076 says stand.
- **Trail:** `web/src/lib/harness/omp/ask.ts` (`detectAskSelectRegion`) ·
  `web/src/lib/harness/omp/ASK_NOTES.md` · `web/src/lib/harness/omp/APPROVAL_NOTES.md` ·
  `web/src/lib/harness/omp/index.ts` · `web/src/fixtures/panes/omp--v18-4-ask-*.txt`,
  `omp--select-menu*.txt`, `omp--select-multi*.txt` · pi-tui `overlays/ask-dialog.ts` (omp 18.4.10) ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md) ·
  [ADR 0058](./0058-the-resume-picker-commits-with-enter.md)

## Context

**omp's `ask` tool blocks the agent until a human answers.** Of all omp's modals it is the one an
operator away from the desk most needs to answer. Since ADR 0076 it showed as raw terminal text with
one Escape button, which can only refuse the question.

The 2026-10-02 captures (omp 18.4.10) and the two older sets show the single-select dialog in three
keycap dialects, all with the same shape:

```
╭─ Ask ──────────────────────────────────────╮
│ Pick a color                               │
├────────────────────────────────────────────┤
│ ❯ ○ Red                                    │
│   ○ Green                                  │
│   ○ Blue                                   │
│   ○ Other (type your own)                  │
│                                            │
├────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⎋ cancel    │
╰────────────────────────────────────────────╯
```

The footer reads `Enter select · n note · ↑/↓ move · Esc cancel` in 17.2.12, and in the Nerd Font
preset (18.4.4) the keycaps, the pointer and the radio are private-use glyphs: U+F0311, U+F12B7,
U+F054 and U+F10C.

The multi-select dialog has the same box plus a tab strip, and its footer moved under it:

| Version | Footer | Enter on an option |
|---|---|---|
| 17.2.12 | `Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel` | toggles the row |
| 18.4.10 | `␣ toggle · ⏎ submit · ↑/↓ move · ⇥/←/→ · ⎋ cancel` | submits the checked set |

omp 18.4.10's source (`ask-dialog.ts`) confirms both readings of the 18.4.10 screen and adds three
facts no capture shows. In a one-question single-select dialog, Enter on an option records it and
closes the dialog at once. Several questions add a tab segment to every footer, and Enter there
advances to the next question. And in multi-select, Space and Enter on the `Other` row both open the
answer editor.

## Decision

**The one-question single-select dialog becomes a pointed list. The multi-select dialog stays raw.**

1. **The footer is the contract.** The grammar accepts a footer of exactly four segments,
   `<enter> select`, `n note`, `↑/↓ move`, `<esc> cancel`, in one of three presets, and the body's
   pointer and radio must be that same preset's glyphs. That single comparison pins a single-select
   question (multi-select prints `toggle`), a one-question dialog (several questions add `⇥/←/→`),
   and the arrows as the move keys (omp prints the user's own binding there). Any other footer
   declines: a scroll indicator, `ctrl+o expand`, a rebound key, the tab segment, a clipped row.
2. **The keys are ADR 0055's.** A tap sends `Down` or `Up` from the pointed row to the tapped row,
   then `Enter`, as one batch. The pointed row sends `Enter` alone and shows `❯`; every other row
   shows no badge. No digit. Enter is printed in the footer, so this is inside ADR 0009's rule.
3. **`Other (type your own)` is an option like any other.** Its tap walks to it and presses Enter,
   and omp opens the answer editor. The adapter already reads that editor as an input (PR 336), so the
   phone's composer types the answer and Enter submits it. The row's own label says what it does,
   and the screen it leads to is one the phone handles, so leaving it off would only make the
   operator use the Keys drawer for the most open answer. The grammar requires it as the last row,
   exactly once, because omp always adds it there and renames any option that would collide with it.
4. **`n note` is not modelled.** `PromptModel` has no field for a footer action, as ADR 0058 point 5
   records. The Keys drawer sends `n`. A row that carries a saved note keeps `✎ note` as its
   description.
5. **The card's last row is the footer's way out in its own words** (`Cancel`), sending `Escape`, as
   ADR 0076 does for `/resume`.
6. **The Nerd Font preset is lifted, the `ascii` preset is not.** The Nerd Font footer, pointer and
   radio are all in `omp--select-menu-other.txt` and `omp--select-menu-noted.txt`. The card shows `❯`
   for its pointer, because the private-use glyph may not exist in the card's typeface. The `ascii`
   preset has no capture, and its pointer `>` is the most common glyph in a transcript.
7. **The body is option rows and blank rows, nothing else.** Option descriptions, wrapped labels,
   previews and scrollbars are all in the source and none is captured, so a body holding any of them
   declines. The question may run one to four rows; it is free text, read for the card only, and its
   bytes ride in the signature.
8. **Tail anchoring and the race guard are 0076's.** The region runs from `╭─ Ask ─╮` through the
   bottom border, which must be the last non-blank row. The signature is every row of it verbatim,
   trailing padding off, and the core signature blanks the pointer alone. A region over 32000
   characters declines, under the bridge's 32768 bound.
9. **The multi-select dialog is not lifted, in either version.** Three reasons, each enough.
   - **No shared recipe fits.** omp toggles with a walk then `Space`. `MultiSelectModel` knows a digit
     toggle (Claude) and a digit-jump then Enter (Muse), and omp ignores digits. A third recipe is a
     change to `lib/multi-select-action.ts`, the core macro every harness shares, and it needs its own
     record and its own live probe.
   - **Enter changed meaning.** It toggles in 17.2.12 and submits the whole set in 18.4.10. A card
     must read the verb from the footer, and on the older footer submitting means a tab switch to the
     review screen first.
   - **The review screen is ADR 0009's digit trap.** It prints `1. toppings: Cheese, Olives` above
     `❯ Submit`.
   The dialog keeps the raw mirror and the Escape card.

## Consequences

- **An omp Ask question with one single-select answer is answered from the card**, in all three
  captured keycap dialects. The agent continues as soon as the tap lands.
- **Typing a custom answer takes two steps:** a tap on `Other`, then the composer. Each step is a
  screen the phone reads.
- **Common shapes still decline.** An option with a description, a long label, a long list or a timed
  question gets the Escape card only. ASK_NOTES.md lists each one and the capture it needs. Of these,
  descriptions are the likeliest in real use and come first.
- **Multi-select and multi-question calls keep the Escape card.** A later slice lifts multi-select by
  adding a walk-then-Space toggle to the shared model, reading Enter's verb from the footer, and
  declining the 17.x footer unless a capture proves a submit path.
- **The transcript above the dialog is a raw block again.** Under 0076 the whole pane was the card's
  mirror; now only the box is the card. The welcome splash above it pans as a table again
  (`table-run.test.ts`).
- **The tool-approval dialog is assessed, not lifted.** APPROVAL_NOTES.md records that its pointed row
  carries the preset's pointer glyph (U+F054 in the 18.1.17 captures) and a background band, that
  only the glyph is safe to read, and which captures a lift needs first.
- **Live verification, 2026-10-02, omp 18.4.10 under Herdr, 109 columns by 59 rows.** A paired
  headless browser tapped four options of a real Ask dialog (Blue, Green, Red, Blue) and the agent
  answered with each colour. `Other` opened the answer editor. The multi-select dialog drew only the
  Escape card. Not probed: the Cancel row on this card, a pointer moved at the desk, a typed reply
  into the editor after the `Other` tap, and the Nerd Font preset.
- **Revisit** when a capture shows an option description, a scrolling list, a timed question or the
  `ascii` preset, when omp changes the footer or what Enter does, or when the multi-select toggle
  gets a shared recipe.

## Addendum — 2026-10-10: option descriptions are read

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum takes up the
first case of the Revisit clause: a capture shows option descriptions
(`omp--v18-8-ask-single-described.txt`, omp 18.8.0, issue #372), and a second capture of the same
dialog with the pointer moved (`omp--v18-8-ask-single-described-moved.txt`, omp 18.8.7) proves the walk.

- **Point 7 now reads description rows, and nothing else it declined.** omp draws every option's
  description wherever the pointer is, so a walk still moves the pointer alone and the keys do not
  change; each description joins its option's `description` on the card. The row layout and the
  shapes that still decline are in `ASK_NOTES.md` and `ask.ts`, beside the code that reads them.
- **A lifted description is never cut short.** omp hides a description's rows past the second behind
  an expand key it names in the footer, and point 1's exact footer declines that screen.
- **The race guard counts body rows, not options.** The core signature blanks the pointer on the
  pointed option's own row, which description rows push down. Counted in options, the blank would
  miss the pointer, and every walk to an option below a description would read back as a changed
  dialog.

## Addendum — 2026-10-13: current Ask footers and single-select batches

This amends points 1, 7 and 8 for the captured OMP 18.10.3 footer, expanded question body and
style-only batch identity. Point 9 still excludes multi-select: the review below belongs to a
batch of single-select questions and prints an explicit Enter-to-submit footer.
`Alt+H hide` had prevented even short questions from producing a card in Chat;
`Ctrl+O expand/collapse` names the measured long-text state.

- Single-select batch questions reuse the guarded pointer walk of ADR 0080. Enter advances;
  the complete final review offers Submit with Enter alone. Review arrows scroll, not select.
- The active question is style-only. Its tab index is part of the walk identity and the styled
  region binds each write, including the final review. Identical text on another tab is not
  the same question.
- Truncated text offers only Expand and Cancel. Answers become available after the expanded
  screen is read; no hidden text is reconstructed from the session journal.
- Missing review answers, preview rails, timeout titles and unknown footer segments decline.
  Clipped question windows have no capture here and are not claimed as supported; matching a
  complete-looking box does not establish that arbitrary missing rows can be detected.
  Multi-select still needs its own guarded toggle recipe.

Evidence and limits: `ASK_NOTES.md`, the `omp--v18-10-ask-*` captures, parser/guard tests and
`src/components/agent-chat-omp-ask.test.tsx`. A paired mobile-shaped browser completed a real three-question call
including expansion and final Submit; another completed a typed custom answer. The Chat journal
card stays read-only. No shared model or Chat component changes are needed.

## Amendment, 2026-10-25: option previews are lifted on omp 18.12.6

A model that gives each option a `preview` makes omp 18.12.6 draw rows behind a rail (`      │ <line>`) under the
option's description (`omp--v18-12-6-ask-previews--w120.txt`, `ask-dialog.ts` `renderCachedPreview`). The grammar
declined every such row, so the Surface read `modal: unreadable`, the phone had no card and a plain send was
refused `unconfirmed`. The "no preview" line of the fail-closed list changes:

- **Preview rows belong to the option above them.** They come after its label and description, never under
  `Other`, never before an option, never before a description row. They join into that option's card text after
  `Preview:`, rows apart by ` ↵ `, so the person reads what omp shows.
- **Declined as before:** a preview of blank rows only, a hidden or bidi character in a row, a row with no right
  border, and every other shape this ADR declines. The echo block above the panel is outside the region.
- **Keys do not change.** A preview is drawn whatever the pointer, so a tap is the same walk, verify and Enter.
  The walk pair for this dialog is a reviewed gap until a second capture exists.
- **The plan-mode question is one of them.** omp 18.12.6 with plan mode on asks "What work should I plan?" through
  the same dialog (`omp--v18-12-6-ask-plan-mode--w120.txt`). It lifts as the previews dialog does: four choices, `Other`,
  Cancel as Escape. Its choices are fixed, so no new rule was needed.
