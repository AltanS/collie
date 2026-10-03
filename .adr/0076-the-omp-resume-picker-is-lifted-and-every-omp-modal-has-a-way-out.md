# 0076: The omp resume picker is lifted, and every omp modal has a way out

- **Status:** Accepted
- **Amended in scope by:** [ADR 0077](./0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md):
  the Ask tool's one-question single-select dialog is now lifted as a pointed list, so it draws no
  Escape card. The multi-select dialog, the tool-approval dialog and everything else below stand.
- **Amended in scope by:** [ADR 0078](./0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md):
  the `bash` and `write` tool-approval dialog in its two captured presets is now lifted as a card, so
  it draws no Escape card. Every other approval and everything else below stand.
- **Amended in scope by:** [ADR 0079](./0079-the-omp-model-picker-is-lifted-as-its-visible-window.md):
  the compact model picker's session state is now lifted as a card, and the modal gate of point 1
  accepts one segment after the way out, the picker's `Alt+P task model` or `Alt+P session model`.
  Everything else below stands.
- **Amended by:** [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md) (2026-10-02): a tap on a
  pointed list is no longer sent as one batch. Point 4 below says "as one batch"; read it as the
  action layer's walk, verify, commit: the arrows go first, bound to the tapped screen, and `Enter`
  goes only bound to a fresh read that shows the pointer on the tapped row. The last Consequences
  bullet ("the guard checks the screen before the batch") is superseded the same way. Nothing else
  changes.
- **Date:** 2026-10-02
- **Shipped in:** 1.16.0
- **Amends:** [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md) and
  [ADR 0072](./0072-a-two-pane-box-pans.md), in scope. 0053's omp row (none, a gap) now reads
  `Escape`, with the fifth condition from its own addendum, and 0072's omp `/model` consequence
  moves into the unread-dialog card. Everything else in both stands.
- **Trail:** the road this closes is [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md)'s
  omp gap, which declined a `cancelKey` for omp and left every omp modal as the raw mirror with the
  composer locked and no button; the operator hit it on 2026-10-02, when `/resume` could not be driven
  from the phone ·
  `web/src/lib/harness/omp/modal.ts` (`ompModalOnScreen`) · `web/src/lib/harness/omp/resume.ts`
  (`detectResumePickerRegion`) · `web/src/lib/harness/omp/RESUME_NOTES.md` ·
  `web/src/lib/harness/omp/index.ts` · `web/src/fixtures/panes/omp--v18-4-resume*.txt`,
  `omp--menu-resume*.txt` ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md) ·
  [ADR 0058](./0058-the-resume-picker-commits-with-enter.md)

## Context

**Every omp modal was a dead end on the phone.** Oh My Pi's pickers (`/resume`, `/model`, `/settings`,
`/tree`, the Ask tool's selects, the tool-approval dialog) showed as raw terminal text. The composer
was locked behind `composerReady`, which answers false on all of them, and no button existed. The
Keys drawer could drive them by hand, but `/resume`, the one picker an operator opens to get back to
work, could not be driven from a pocket.

Two things were already known and are not reopened here. omp's adapter is Tier 1: it lifts no
interactive block, so a mis-parse costs cosmetics. And ADR 0053 declined omp's unread-dialog card for
one reason. omp's composer scanner has a total, permanent false-negative mode: one ZWJ emoji in a
statusline template and `locateComposer` returns null on every frame, so `composerReady` is false
forever on a healthy pane. A card gated on `composerReady === false` would paint itself over a live
composer for good.

**The 2026-10-02 captures change what can be said.** omp 18.4.10 draws `/resume` as a rounded box that
fills the pane, with glyph keycaps in the footer:

```
╭─ Resume Session (current folder) ─────────────────────╮
│ > ab                                                  │
│ ❯ Render Fancy Content in Terminal                    │
│   lets push the boundaries here abit and render …     │
│   7 minutes ago  ·  138.1KB  ·  current  ·  ✔ done    │
│ [⌦/⌫ delete · ⏎ select · ⇥ all projects · ⎋ cancel]   │
╰───────────────────────────────────────────────────────╯
```

Read with the 17.x to 18.1 captures (`omp--menu-resume.txt`, unboxed, text keycaps), three facts hold.
Both footers print the commit key (`⏎ select`, `Enter select`) and the way out (`⎋ cancel`,
`Esc cancel`). Every other modal in the corpus that has a footer also ends it with its way out, in
six spellings across the two dialects, and the approval dialog's is lower case. A third dialect, omp's
Nerd Font symbol preset, prints the key as the private-use glyph U+F12B7 (`󱊷 cancel`); the `ask` tool
captures in PR 336 show it, and the modal check accepts it for `cancel` and `close`. And one modal, `/tree`,
prints no way out at all: omp clips its hint row, and neither capture holds an Esc segment.

Two shapes in those captures were not what a first reading predicted. Sessions that share a title are
ordinary (a fork keeps its parent's), so a label alone cannot tell two rows apart. And the unboxed
capture lists two of its three sessions with **two** rows (first prompt, meta), because an untitled
session has no title row.

## Decision

**The card needs omp's own footer on screen, and `/resume` becomes a list of sessions.**

1. **A modal gate, `ompModalOnScreen`.** True only when a footer row at the buffer tail is a key-hint
   list whose last segment is one of `⎋ cancel`, `⎋ close`, `⎋ to close`, `Esc cancel`, `Esc close`,
   `Esc to close`, or `󱊷 cancel` and `󱊷 close` in the Nerd Font preset, matched case-insensitively because
   the approval dialog spells it `esc cancel`. `Esc to
   cancel` is not on the list: omp never prints it, Claude prints it on most modals, and accepting it
   would be one step from reading another harness's screen. The footer is one of the last four
   non-blank rows, and every row below it is box frame (a blank `│ │`, the bottom border, a bare
   rule), with one exception: the very last row may be anything, because omp prints a usage strip under
   an approval box. Every captured composer fails that walk by itself: a row of real text that is not
   the last row (the powerline in the box's top border, or the draft row over a rule composer's status
   row) stands between the tail and any hint-shaped line. So a live composer reads false however
   `composerReady` answers.
2. **`cancelKey: "Escape"` and `modalOnScreen: ompModalOnScreen` are declared together.** This
   answers ADR 0053's omp gap rather than ignoring it: the false-negative mode still exists, and the
   card now also needs positive evidence of a modal, which a ZWJ statusline cannot fake. Escape is the
   key every one of those footers names, read from `omp--v18-4-menu-model.txt`,
   `omp--v18-4-menu-settings.txt`, `omp--select-menu.txt`, `omp--approval-bash.txt` and the resume
   captures. Every omp modal that prints a way out and that no grammar lifts now gets the unread-dialog
   card.
3. **`/resume` is lifted as a `prompt-select` list.** The evidence is all required: the layout's
   bottom border at the tail, one spacer row, a bracketed footer that is a hint list ending in a way
   out and naming `select`; the layout's title (`(current folder)` or `(all projects)` boxed, only
   `(current folder)` unboxed), its search row and blank rows, in order; the list as blank-separated
   groups ending in a meta row that carries an age and a size; exactly one `❯`. Any piece missing
   returns null and the screen stays raw with the card over it. A group is three rows (title, first
   prompt, meta), or two for an untitled session, in both layouts (`omp--menu-resume.txt` and
   `omp--v18-4-resume-untitled-dated.txt`). The no-match screen has no row and declines. The age may also be a date: from seven days on,
   omp 18.4.10 prints `toLocaleDateString()` (`9/20/2026` in en-US, captured in `omp--v18-4-resume-untitled-dated.txt`). A date of three numbers
   joined by `/`, `.` or `-` is accepted; the other locale shapes are read from omp's source, not from
   a capture.
4. **The keys are ADR 0055's.** Option *i* sends `Down` × (*i* − pointed) or `Up` × (pointed − *i*),
   then `Enter`, as one batch; the pointed row sends `["Enter"]` and shows `❯`, every other row shows
   no badge. No digit. The card's last row is the footer's own way out, in its own words (`Cancel`),
   sending `Escape`, as ADR 0058 point 5 does. `PromptModel` has no field for footer actions, so
   `⌦/⌫ delete` and `⇥ all projects` stay off the card and the Keys drawer reaches them.
5. **The label is the title, and the description is the whole meta row.** An untitled session's first
   prompt is its label. The meta row leads with the age and carries size, state, fork mark and cwd, so
   two sessions with one title stay distinguishable.
6. **The race guard carries the whole region.** The signature runs from the title through the bottom
   border, rows trimmed of trailing space and otherwise verbatim, so a pointer moved between the render
   and the tap, a session added, an edited first prompt and a ticked age all refuse the tap (ADR 0055
   point 6). The core signature is the same text with the pointer glyph blanked. The signature is also
   the bridge's bound `expected_prompt`. The bridge refuses one over 32768 characters (raised from 8192
   by this record, because a full-screen desktop pane is already past 8192), so a region longer than
   32000 declines at detection rather than failing every tap with a 400.

**This is inside ADR 0009's rule, not an exception to it.** The commit key is printed in both
footers. ADR 0058 had to carve out an unprinted Enter for Claude's picker; omp's footer names Enter
itself, and the `❯` is the row it takes, so the tap sends the arrows the screen's pointer implies (ADR
0009 lets a `❯` row enable Up and Down, and ADR 0055 does the arithmetic) and a key the screen
printed. No other dialog gains anything from this record.

**Nothing else is lifted.** `/model`, `/settings`, `/tree`, the Ask tool's selects and the tool-approval
dialog stay raw. They get the card from point 2 and nothing more. A later contribution lifts each, and
each clears the Tier-2 bar on its own.

## Consequences

- **`/resume` resumes a session from the card, in both omp layouts.** The raw mirror and the Keys
  drawer remain for delete, the project toggle and the search box (typed through Type mode).
- **Every omp modal that prints its way out has one button.** The card's caption says "Collie cannot
  read this dialog" and its button names the key, never a verb, as ADR 0053 requires.
- **`/tree` gets no card.** Neither capture prints a way out, and declaring it from its title would
  be reading a screen from one line, the failure ADR 0053 names. It keeps the raw mirror it has today.
- **The card mirrors the whole pane in its own horizontally scrolling region.** The omp `/model` box,
  which ADR 0072 panned as a table inside the wrapping mirror, now scrolls as part of the card's
  mirror, as Claude's generic-menu card always has. The approval screens and the Ask tool's selects
  take the same card, and that has a cost: the transcript above those dialogs is now in a mirror that
  does not wrap, so a long line pans instead of wrapping. `table-run.test.ts` lists fewer omp screens
  accordingly.
- **The `ask` tool's answer editor never gets the card.** `Other (type your own)` and `n note` open a
  free-text box in place of the composer. omp's adapter reads it as an input (`composerReady` answers
  `true`, PR 336), so the card's gate, which needs a definite `false`, is shut, and its hint row ends
  on `external editor`, not on a way out, so `modalOnScreen` is false as well. Both are tested on the
  five captures of that box.
- **A very large pane declines.** The box fills the pane, so the region is about rows times columns,
  and the 109 by 59 capture is 6,489 characters. The cap is 32768 at the bridge and 32000 here, which
  is about 550 columns at 59 rows. The bridge cap was 8192 when the grammar was first written, and
  raising it is part of this record. A phone newer than its bridge gets the old 400 on a pane past
  8192, and no key is sent, so a crew member one release behind fails closed, not wrong.
- **A tap across a tick of the age is refused**, as ADR 0058 records for Claude: `7 minutes ago`
  becomes `8 minutes ago` while the card is up, the signature moves, and the card re-renders.
- **Shapes with no capture decline rather than guess:** a list longer than the pane (a scroll counter
  or marker), the all-projects title in the unboxed layout, a date in a locale that is not three
  numbers, and the `nerd` and `ascii` symbol presets, which print another pointer glyph. The `ascii`
  pointer is `>`, the same glyph as the search row's prompt, so lifting it needs its own capture and
  its own rule.
- **Live verification, 2026-10-02, omp 18.4.10 under Herdr, 109 columns by 59 rows.** A paired headless
  browser tapped sessions on the card, first in a list of two and then in a list of eight (five hand-made
  copies of one session log, so the list was long enough to need walks of several rows in both
  directions). Of eight taps on the eight-session card, seven resumed exactly the tapped session (Up and
  Down walks, the pointer starting on the first row and on the last) and one did nothing: no key
  reached the wrong session. The no-op is the race guard's safe side, most likely an age that ticked
  between the render and the tap. The card's Cancel closed the picker. The `/model` picker, which has
  no lifted grammar, drew the "cannot read this dialog" card, and its `Esc` button closed it. `/tree`
  drew no card, as recorded above. Not probed: the pointed row's own tap in a long list, a list long
  enough to scroll, and a pane wider than the old 8192 bound.
- **The guard checks the screen before the batch, not between its keys.** A tap is one `send_keys`
  call of arrows then Enter, as ADR 0055 records. A pointer that moves during those few milliseconds
  would resume a neighbour, not break anything; the picker is not destructive, and the resumed
  session's name shows at once.
- **Revisit** when a capture shows a scrolling session list or
  a clipped footer on a narrow pane, when omp prints `/tree`'s way out, when the bridge's cap on a
  bound region moves, or when a second omp picker asks to be lifted; each then needs its own capture
  and its own record.
