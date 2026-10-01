# OPENCODE QUESTION NOTES

The measured ground truth for the opencode `question` tool's dialog, the one the agent opens when it
asks the person a question with a list of answers. It is the sibling of `PERMISSION_NOTES.md`. Every
claim below was probed a keystroke at a time against **opencode 1.18.33** in a private Herdr session,
2026-10-01, and is pinned by the fixture corpus `web/src/fixtures/panes/oc--question--*.txt` (captured
the same day, listed in `web/src/fixtures/panes/README.md`). These notes make no claim about code: no
grammar was read or run.

One version caveat. opencode replaced its own binary on disk with 1.18.34 while the probe ran. Every
dialog below was painted by the process that started as 1.18.33 (its status row still read `1.18.33`
after a `/new`, at the narrow width). A 1.18.34 process was started once and never measured.

## Where the dialog paints

In its own bar run (`┃`, U+2503) at the buffer's tail. It takes the place of the whole composer: no
model row, no rule, no status row, no `esc interrupt`. The bar is PURPLE (`157;124;216`) on the
dialog's base background (`20;20;20`), inside a two-column gutter on the page background
(`10;10;10`). The permission dialog's bar is orange and the transcript's own user bars are blue
(`92;156;245`), so no colour is shared that a grammar could lean on. One row of the transcript
stays above the dialog and says it is pending: `→ Asked 1 question` (the `→` and the text in grey).

A single question with a single-select list (3 options with descriptions, 120 columns, rows counted
from the top of a 40-row buffer):

    ┃                                     <- row 26, a bare bar row (padding)
    ┃  Which colour?                      <- the question. No title row, and the header ("Colour") is NOT drawn
    ┃
    ┃  1. Red                             <- the pointer chip sits on "1. Red"
    ┃     warm                            <- the description, grey, under the label
    ┃  2. Green
    ┃     calm
    ┃  3. Blue
    ┃     cool
    ┃  4. Type your own answer            <- always the last row, numbered like the rest
    ┃
    ┃  ↑↓ select  enter submit  esc dismiss     <- row 37, the footer
    ┃                                     <- row 38, a bare bar row, then one blank row, the buffer's end

The header only appears when the dialog grows a tab bar. A multi-select question, or a call with two
or more questions, puts the tab row first:

    ┃   Colour   Size   Confirm           <- the active tab is a chip: `10;10;10` on `157;124;216`, one space inside each side
    ┃
    ┃  Which colours? (select all that apply)   <- multi-select adds this suffix to the question
    ┃  1. [ ] Red                         <- a box, `[ ]` or `[✓]`, is part of the label
    ┃  ...
    ┃  5. [ ] Type your own answer

The tabs are the questions' headers in order, then `Confirm`. A tab is bright (`238`) once the person
has visited it and grey (`128`) before; all eight captures with a tab bar fit that rule, and it is not
an answered mark (the `✓` is). **Corrected in round two (1.18.34): a tab is bright when its question
holds an answer, not when it was visited.** A visited tab with no answer stays grey, and a multi-select
tab goes grey again when every box is toggled off. `Confirm` is grey until it is the active tab. The
`Confirm` tab holds no options. It reads:

    ┃  Review
    ┃
    ┃  Colour: Red, Blue, mine            <- one `Header: answer` row per question, a bare row between rows
    ┃
    ┃  ⇆ tab  enter submit  esc dismiss

The footer's words say which dialog it is:

| Dialog | Footer |
| --- | --- |
| one question, single select | `↑↓ select  enter submit  esc dismiss` |
| one question, multi select | `⇆ tab  ↑↓ select  enter toggle  esc dismiss` |
| two or more questions, single select | `⇆ tab  ↑↓ select  enter confirm  esc dismiss` |
| the `Confirm` tab | `⇆ tab  enter submit  esc dismiss` |

The footer says `enter confirm` on the second row of that table, the same words the permission
footer ends with. What tells the two apart is `esc dismiss`, the `⇆ tab` hint and the absence of
option chips. The footer does not change while the free-text row is being edited, though `↑↓` stops
working there.

Wide and narrow are the same shape. At 50 columns the rows are identical, the question wraps, and the
footer's two-space gaps shrink to one space (`⇆ tab ↑↓ select enter toggle esc dismiss`). The
narrow multi capture also ends in two bare bar rows instead of one, the footer one row higher; the
cause is not known.

**Height.** The dialog is as tall as its content. A bare row on top and one under the footer, a bare
row above and below the question, two rows per option (label, then description or an empty row), one
row for the free-text option:

| Dialog | Rows, top bare row to bottom bare row | First text row to footer |
| --- | --- | --- |
| single, 3 options | 13 (measured) | 10 (the question) |
| single, 4 options | 15 (arithmetic, not measured) | 12 |
| multi, 4 options, tab bar | 17 (measured) | 14 (the tab row) |
| two questions, first has 3 options | 15 (measured) | 12 (the tab row) |
| single, 8 options | 23 (measured) | 20 |
| single, 9 options | 25 (measured) | 22 |
| single, 14 options | 35 (measured) | 32 |

The footer sat on row 37 of the 40-row buffer in every wide capture. The permission lift's bound is
16 rows from the title row to the footer. A question dialog stays inside it up to 6 options (no tab
bar) or 5 options (tab bar), and leaves it from 7 or 6. At 14 options the dialog filled the pane,
rows 4 to 38, and the user message above it was cut to its first row; the dialog did not scroll. A
longer list than the pane is tall was not measured.

An open input row adds one row: digit `4` on the free-text row grew the 13-row dialog to 14.

## The recipe (probed)

Probed one key at a time on **opencode 1.18.33**, 2026-10-01, in a private Herdr session with the
user's normal opencode config and a free model (`Ling 3.0 Flash Sante`). Keys went through
`herdr pane send-keys`; `Shift+Tab` is spelled `shift+tab` there. "Unchanged" means the pane read
(`--ansi --source recent --lines 300`) was byte-identical before and after the key.

A single question, single select, three options plus the free-text row (4 rows):

| Act | Keys | Evidence |
| --- | --- | --- |
| Move the pointer down one | `Down` | the chip moved `1. Red` to `2. Green` (`oc--question--single--moved`). From `2`, `Up`, `Up`, `Down`, `Down`, `Down`, `Down` read 1, 4, 1, 2, 3, 4, so `Down` at `4` wraps to `1` |
| Move the pointer up one | `Up` | `2` to `1`, and `Up` at `1` wrapped to `4. Type your own answer` (the same run) |
| `Left`, `Right`, `Tab`, `Shift+Tab`, `Space` | nothing | the screen was byte-identical after each, pointer on `1` |
| Choose the option the pointer is on | `Enter` alone | untouched dialog, `Enter`: the dialog closed at once and the transcript showed `Red`. It does not toggle first and it asks nothing more |
| Choose option 2 from the untouched dialog | `Down`, `Enter` | the transcript showed `Green` |
| A digit `1` to `3` | the digit alone | pointer on `1`, `3`: the dialog closed at once and the answer was `Blue`, journal `answers [["Blue"]]`. The digit does not need the pointer and does not wait for `Enter` |
| A digit past the last row, `0` | nothing | `9`, `8`, `0` and `5` left the pane byte-identical (a first `9` read as a change, a retest showed it was the transcript settling) |
| A digit AFTER the dialog closed | types into the composer | a `2` sent a moment later landed as the draft `2` in the composer |
| Open the free-text row | digit `4`, or `Enter` with the pointer on it | an input row appeared under `4. Type your own answer`, showing the placeholder `Type your own answer` in the description grey (`oc--question--free-text`) |
| Type into it | the text, in place | `hello` replaced the placeholder, in the bright foreground `238` (`oc--question--free-text--typed`) |
| Submit the typed text | `Enter` | the dialog closed, the transcript showed `hello`, journal `answers [["hello"]]` |
| `Enter` on an empty input | leaves the input, submits nothing | the placeholder row closed, the pointer stayed on `4`, the dialog was back at 13 rows |
| While the input is open: `Up`, `Down`, `Left`, `Right`, `Tab`, `Shift+Tab` | nothing | the pane was byte-identical after each, the pointer stayed on `4` |
| `Escape` while the input is open | closes the input only | the dialog stayed, the pointer stayed on `4`. The typed `hello` did not survive: after `Up`, `Down`, `Enter` the input showed the placeholder again |
| `Escape` on the list | dismisses the dialog and ends the turn | the dialog closed, the transcript kept `→ Asked 1 question`, no `esc interrupt`, Herdr read `idle` |

Sequences that follow, from the untouched dialog: option 1 is `["Enter"]`. Option `k` is
`["Down" × (k-1), "Enter"]`, and `Down` wraps, so the free-text row is also one `Up` from option 1.
A free-text answer is `["Down" × 3, "Enter"]`, then the text, then `["Enter"]`. A digit also submits,
but it is the one key here that acts without looking at the pointer, so it fails the way the
permission notes avoid (.adr/0009): a digit sent against a stale render picks an option the person
never saw selected.

A single question, multi select, four options plus the free-text row (5 rows, a tab bar):

| Act | Keys | Evidence |
| --- | --- | --- |
| Move the pointer | `Down`, `Up` | `Down` moved `1` to `2`. Wrap at the ends was not measured here |
| Toggle the option the pointer is on | `Enter` | `1. [ ] Red` became `1. [✓] Red`, pointer stayed (`oc--question--multi--toggled`) |
| `Space` | nothing | the screen was byte-identical, `[ ]` stayed |
| A digit `1` to `4` | the digit alone | toggles THAT option and moves the pointer to it: `3` on pointer `2` gave `3. [✓] Blue` with the chip on `3`; `3` again gave `[ ]` |
| Open the free-text row | digit `5`, or `Enter` on it | the input row opened under `5. [ ] Type your own answer`, no toggle yet |
| Commit the typed text | the text, then `Enter` | `5. [✓] Type your own answer`, the input closed, the text `mine` stayed under the row, and it stayed after `Up` and `Down` (unlike the single-select input) |
| Go to the `Confirm` tab | `Tab`, or `Right` | the `Confirm` chip became active, `Review` and `Colour: Red, Blue, mine` replaced the options, footer `⇆ tab  enter submit  esc dismiss` (`oc--question--multi--confirm`) |
| Go back to the list | `Tab` or `Left` or `Right` | back on the options. With two tabs every one of the three moves the other way, so they are not told apart |
| `Shift+Tab` | nothing | the screen was byte-identical on the list and on `Confirm` |
| `Up`, `Down`, `Space`, a digit on `Confirm` | nothing | byte-identical |
| Submit | `Enter` on `Confirm` | the dialog closed, journal `answers [["Red","Blue","mine"]]`. The free text is one more string beside the labels |
| Submit with nothing toggled | `Tab`, `Enter` | the dialog closed, journal `answers [[]]`, the transcript block read `(no answer)` |
| `Escape` | dismisses | measured from the `Confirm` tab: the dialog closed, the journal `error`. From the list tab not measured |

The shortest submit of a toggled first option from the untouched dialog is
`["Enter", "Tab", "Enter"]`. The first `Enter` toggles, `Tab` reaches `Confirm`, the last submits.

A call with two questions, both single select (`oc--question--two--*`):

| Act | Keys | Evidence |
| --- | --- | --- |
| Answer the question the pointer is on and move on | `Enter` | on `Colour` it selected `Red` and the `Size` tab became active (`oc--question--two--q2`). On the last question it moves to `Confirm` |
| A digit | the digit alone | `3` on `Colour` selected `Blue` and moved to `Size`. It selects and advances, it does not submit the call |
| Move between tabs | `Tab` or `Right` forward, `Left` back | `Colour`, `Size`, `Confirm`, wrapping to `Colour`; `Left` went the other way. `Tab` from `Confirm` wrapped to `Colour` |
| Show an answered option | nothing to press | the row reads `1. Red ✓`, the `✓` and, off the pointer, the whole label in `127;216;143` (`oc--question--two--q1-answered`) |
| Where the pointer starts on a revisit | not at the answer | back on `Colour` with `Blue ✓`, the pointer was on `1. Red` |
| Submit | `Enter` on `Confirm` | the journal read `answers [["Blue"],["Small"]]`, one array per question in order |
| Answer both with the first options | `["Enter", "Enter", "Enter"]` | first `Enter` answers `Colour`, the second `Size`, the third submits from `Confirm` |
| `Escape` | not measured on a two-question call | |

A digit is therefore three different keys. On a lone single-select question it submits. On a
multi-select list it toggles. On a call with several questions it selects and moves on. On any list's
free-text row it opens the input. That difference is the reason to prefer the pointer-relative `Down`
and `Enter` over a digit once a grammar exists.

## What the pointer looks like

A BACKGROUND-COLOUR chip on exactly one row's `N. label` run, plus a different text colour. From
`oc--question--single` (SGR, `cat -v`, shortened):

    focused    ^[[38;2;106;145;198m^[[48;2;30;30;30m1.^[[0m ^[[38;2;92;156;245m^[[48;2;30;30;30mRed^[[0m
    unfocused  ^[[38;2;128;128;128m^[[48;2;20;20;20m2.^[[0m ^[[38;2;238;238;238m^[[48;2;20;20;20mGreen^[[0m

| Part of the row | Focused | Not focused |
| --- | --- | --- |
| the digit `N.` | `106;145;198` on `30;30;30` | `128;128;128` on `20;20;20` |
| the label | `92;156;245` on `30;30;30` | `238;238;238` on `20;20;20` |
| the description row under it | `128;128;128` on `20;20;20` | the same |

So the focus IS derivable from styles alone, the way the permission dialog's is: exactly one option
row has its label on a background other than the dialog's base. The base is the footer hint's own
background (`20;20;20` here), read the same way the permission detector reads it. The chip is the
`N. label` run only, with one space inside it; the rest of the row to the right edge sits back on the
base. Inside the dialog's rows the only SGR codes, over every capture, are `0`, `38;2;r;g;b` and
`48;2;r;g;b`: no inverse (`7`), no bold, no underline, no dim. Bold (`1`) and strikethrough (`9`) do
occur in the transcript above the dialog, see "After the answer".

The issue reporter's note, "digits carry distinct colors; no inverse focus marker found in styled
output", is half right. The digits do carry a distinct colour (`106;145;198` against `128;128;128`) and
there is no inverse. But the label colour changes with the digit, and the background lightens, so the
marker is not the digit's colour alone.

State drawn on top of the chip:

- A toggled multi-select row off the pointer: the box and label turn green, `127;216;143`, and the box
  reads `[✓]`. On the pointer the chip colours win (`[✓] Blue` stayed `92;156;245`), so a toggle on the
  pointed row is told by the `✓` glyph alone.
- An answered option in a many-question call: a ` ✓` suffix in `127;216;143` sitting OUTSIDE the chip
  on the base background, and a green label off the pointer.
- The free-text row while its input is open: the chip stays on the `N. Type your own answer` row. The
  input row below it is plain text on the base background, the placeholder in `128`, typed text in `238`.
- The active tab: `10;10;10` on `157;124;216`, a space inside each side. An answered tab `238`, an
  unanswered one `128`.

The pointer does NOT always start on option 1. With 8 options or fewer it did (every capture). With 9
options (three runs: twice with descriptions, once with letters) it started on `2`, and with 14 options
it started on `7`. In every one of those the pointed row was the one drawn on screen row 19, the middle
of the 40-row pane, which is what a stale mouse position would do. That is a guess and nothing proves
it. What it means for a reader: take the pointer from the chip, never assume `1`.

## The spinner

Nothing churns while the dialog waits. Four pane reads 1.5 seconds apart at 50 columns hashed
identically, and the wide key probes read byte-identical before and after every inert key. The status
row is gone with the composer, so there is no animation under the dialog. Above it the transcript
keeps `→ Asked N question(s)` while the call is pending. The `Thought: 351ms` rows above are fixed once
printed. The only churn seen came within about a second of a dialog opening, while the transcript was
still settling.

Herdr read `blocked` on the single-select dialog and `idle` after `Escape`. The other dialogs were not
read for status.

## After the answer

An answered dialog leaves a block in the transcript, in a bar whose own colour matches the page
(`10;10;10`), so the bar shows as nothing (`oc--question--answered`):

    ┃  # Questions                  <- grey
    ┃
    ┃  Which colour?                <- grey, one pair per question
    ┃  Red                          <- bright, or `(no answer)`
    ┃
       + Thought: 31ms
       You chose Red (warm).        <- the model's own reply

A dismissed dialog leaves nothing: the transcript keeps `→ Asked 1 question`, now STRUCK THROUGH
(SGR `9`; while the dialog is up the same row carries no strikethrough), the composer is back, and the
turn has ended (`oc--question--dismissed`). The model's `You chose Red (warm).` carries the chosen
label in bold.

## The journal

The store is `~/.local/share/opencode/opencode.db`, table `part`, one row per tool call, `data` a JSON
object. Read with `sqlite3 -readonly`. The latest row with `"tool":"question"`:

While the dialog waits (single select, one question):

    {"type":"tool","tool":"question","callID":"call_847311b040e5418687cfd6ae",
     "state":{"status":"running","input":{"questions":[{"header":"Colour","multiple":false,
       "options":[{"description":"warm","label":"Red"},{"description":"calm","label":"Green"},
       {"description":"cool","label":"Blue"}],"question":"Which colour?"}]},
       "time":{"start":1790889128314}}}

`multiple` is `true` for a multi-select, and a call with two questions has two entries in `questions[]`.
The free-text option is not in the input, opencode adds it.

After an answer (`Blue` by digit `3`):

    "state":{"status":"completed","input":{...},
     "output":"User has answered your questions: \"Which colour?\"=\"Blue\". You can now continue with the user's answers in mind.",
     "metadata":{"answers":[["Blue"]],"truncated":false},"title":"Asked 1 question",
     "time":{"start":1790889128314,"end":1790889204676}}

The answer is `state.metadata.answers`: one array per question, in order, each holding the chosen
labels, or the typed text as a plain string. Observed: `[["hello"]]`, `[["Red","Blue","mine"]]`,
`[["Blue"],["Small"]]`, and `[[]]` for a multi-select confirmed with nothing toggled, where `output`
then read `="Unanswered"`.

After `Escape` (the call never gets an answer):

    "state":{"status":"error","input":{...},"error":"The user dismissed this question",
     "time":{"start":1790889262259,"end":1790889263256}}

There is no `metadata.answers` and no `output` on a dismissed call.

Listening port: `ss -ltnp | grep -i opencode` printed nothing while the TUI ran (the one opencode
process, pid 482487, holds no listening TCP port).

## Open questions / limits

- Only the `question` tool was probed, only with the user's own opencode config, and only on a free
  model. A different model can phrase the call differently but the dialog is opencode's, not the model's.
- No grammar, lift or composer scanner was run against these captures, so nothing here says whether
  the composer's tail scanners refuse to type while the dialog is up. The permission dialog gets that
  from its footer being a bar row under where the rule would be; the question dialog's footer is also a
  bar row, but that was not tested.
- The initial pointer is not always option 1 (see "What the pointer looks like"). The row-19 guess is
  untested: no mouse event was sent, and the pane height was not varied.
- ~~A multi-select list was probed with `Down` only, so wrap at the ends is not measured there. `Escape`
  on a multi-select list tab and on a two-question call was not measured, only from `Confirm`. `Escape`
  while a multi-select free-text input is open was not measured.~~ Closed in round two: both wraps,
  `Escape` on a multi-select list tab, on `Q1` of a three-question call, and with the free-text input
  open were all measured.
- ~~A multi-select free-text answer commits with `Enter` and keeps its text. Whether the text survives
  `Escape` there was not measured. In the single-select input it does not.~~ Closed in round two: typed
  text that was never committed does not survive `Escape`. Committed text does, see "Round two".
- Lists longer than the pane is tall (more than about 17 options at 40 rows) were not measured. Panes
  taller or shorter than 40 rows were not measured, and nor was a pane narrower than 50 columns.
- Only a 3-option single dialog, a 4-option multi dialog, a 2-question call, and the 5, 7, 8, 9 and 14
  option lists were captured. A 4-option single dialog's 15 rows are arithmetic, not a capture.
- Option labels or descriptions that wrap at 50 columns were not captured; only a long question was.
- A markdown question and a question whose label contains the box glyphs `[ ]` were not measured. A
  question with an empty description was seen once in round two, see "Round two", with no fixture.
- ~~The status column was read with `herdr pane get` on one dialog and after `Escape` only.~~ Round two
  read it again and got a different answer, see "Round two". The status column is now an open question.
- Open after round two: Herdr's `agent_status` read `idle` under a live question dialog on 1.18.34
  (round one read `blocked`). The cause is not known. Nothing here says whether a status of `blocked`
  can be relied on for this dialog.
- Open after round two: a tab bar wider than the pane (many questions, long headers), a call with more
  than three questions, a multi-select as the LAST question, and `Shift+Tab` on a three-question call
  were not measured. The submit of an empty multi-select was not repeated on 1.18.34.
- The probe sent keys through Herdr, not through a real keyboard, so a key Herdr sends as another
  sequence (`shift+tab` as the CSI `Z`) may not match what a terminal sends. `Shift+Tab` did nothing
  everywhere, which is consistent with opencode not binding it, and is also what a mismatch would look like.

## Implementation

Two grammars read the question dialogs, both wired into `opencodeBuildBlocks` after the permission
detector, single select first. `question.ts` lifts the dialog with no tab bar. `question-tabs.ts` lifts
the four dialogs that have one. They share the footer anchor, the numbered-row walk, the pointer read and
the footer's two inks, which `question.ts` exports. Every step can only reject, and a shape no step
knows returns null, so the raw mirror and the unread-dialog card with Escape cover it (ADR 0053).

**The footer's verb and the tab count say which dialog it is.**

| Footer | Tabs | Block | Phase |
| --- | --- | --- | --- |
| `enter submit`, `↑↓ select`, no `⇆ tab` | none | `prompt-select` | one question, single select |
| `enter toggle` | 2 (`Header`, `Confirm`) | `multi-select` | checkbox, `steps` null |
| `enter toggle` | 3 or more | `multi-select` | checkbox, one step chip per question |
| `enter confirm` | 3 or more | `wizard` | question |
| `enter submit`, `⇆ tab`, no `↑↓ select` | 2 | `multi-select` | review |
| `enter submit`, `⇆ tab`, no `↑↓ select` | 3 or more | `wizard` | review |

**Single select.** One question, up to nine options. Each option's key is its own digit, alone, because a
digit submits at once, ignores the pointer, and the screen printed it (ADR 0009 forbids only a digit the
screen did not print). The free-text row is not an option. It is modelled as `feedback` with the
`free-text` purpose. While its input is open (a row under it holds the placeholder or the typed text)
`feedback.focused` is true and the card locks every button, because the dialog takes digits as text
there. Collie never types into that row.

**Multi select, lone or one step of a call.** The checkbox phase has `toggle: "digit"`: a digit toggles
option N whatever the pointer is on, and never advances (measured). `advanceKeys` is `["Tab"]`, sent once
as one guarded write, because the dialog has no advance row to walk onto. `advanceLabel` is the next tab's
own word: the next question's header, or `Confirm` after the last question. `steps` holds one chip per
question tab, `Confirm` left out, and is null for a lone question. There is no escape row. The free-text
row is never an option. Its box and committed text show in the signature only.

**Single-select step of a many-question call.** The `wizard` question phase. Each option's key is its
digit alone, because a digit selects and advances (measured). A row that ends in ` ✓` is the answered
option, `chosen`, with the mark taken off the label. `escape` is false on every option.

**The Confirm tab.** A body of `Review`, then one `Header: value` row per question, each header the tab's
own label and in tab order. The value is the labels joined by `, ` with free text last, or
`(not answered)`, which makes the review `incomplete`. Both reviews submit with `["Enter"]` and cancel with
`["Escape"]`. The cancel button says `Dismiss`, the footer's own word, because Escape ends the whole turn.
With two tabs the review is a `multi-select` with `submit: "keys"`, `backKeys: ["Left"]` (back to the
list, measured) and `pointer: null`. With three or more it is a `wizard` review, whose way back is the
stepper's own `Left`.

**Tab chips are read from style, never by colour name.** The active chip is the one whose label sits on
another background than the footer's `esc dismiss`. A chip that is not active is painted in the footer's
bright ink (the `esc` word) when its question holds an answer, and in the footer's grey ink (the `dismiss`
word) when it does not. An ink that is neither refuses the screen. The active chip's own colours are
inverted, so its answer comes from the body: a ` ✓` row on a single-select step, a `[✓]` box on a checkbox
step. On the Confirm tab no question chip is current. The screen is refused when the active chip count is
not one, the last chip is not `Confirm`, two chips share a label, the footer's two inks are one, or there
are more than nine questions.

**The pointer.** It is read, never sent. The chip is the one numbered row whose `N.` run sits on another
background than the footer's own. Zero chips or two refuse the dialog. On a checkbox step the model reports
`pointer: "option"` with `pointerRow`, or `"other"` on the free-text row. A digit does not care where the
chip is, so a moved chip changes no signature, which is text.

**The free-text row on a checkbox step.** A row under it is the input or the committed text. Text equal to
the placeholder means the input is open, so the lift refuses. Otherwise the row's ink decides: bright is
typed text in an open input, so it refuses. Grey is committed text with the input closed, so it lifts and
the row is still not an option (`multi--free-text--committed`). Any other ink refuses. A single-select
step has no committed state, so any row under its free-text row refuses.

**Signatures.** The checkbox phase's `signature` is the rows from the tab row to the footer with every
`[✓]` and `[x]` normalised to `[ ]`, so a toggle moves `checked` and not the signature. Its
`regionSignature` is the same rows literal, run through the static footer, and ends inside the bridge's
tail window. The wizard question and both reviews sign the literal rows. The block replaces the dialog
from the tab row down, and the mirror keeps what is above it.

**What stays raw, and why.**
- A free-text input that is open (`multi--free-text`). A digit is typed into it as text, and no card
  button could say so.
- More than nine options (`tall14`). A tenth option has no single key. Nine options lift (`tall9`).
- A numbering that does not run 1..n, no pointer chip, two chips, a Confirm row that is not
  `Header: value`, or ordinary output more than two rows under the footer.
- An option with an empty description. The row under its label is a bare bar row, which ends the walk and
  fails the numbering. It was seen once and has no fixture.
- A call with no free-text row at all (custom answers turned off) lifts like the single lift does, every
  numbered row an option. That shape was not measured.

**The key plans.**

| Act | Keys |
| --- | --- |
| Answer a single-select option, lone or in a call | the option's digit |
| Toggle a checkbox option | the option's digit |
| Go to the next tab from a checkbox step | `["Tab"]` |
| Move between steps | `Left` and `Right`, the stepper's own |
| Go back from a lone multi select's Confirm tab | `["Left"]` |
| Submit from the Confirm tab | `["Enter"]` |
| Dismiss the whole dialog from the Confirm tab | `["Escape"]` |

`modalOnScreen` answers true on every question footer (`esc dismiss` after `enter submit`, `enter toggle`
or `enter confirm`, on a bar row at the tail), the screens that stay raw included, so the card and the
composer lock work on all of them. `composerReady` answers false on every dialog capture, because the
dialog's own bar rows sit where the composer's rule would be, and true again on `answered` and `dismissed`.

## Round two (1.18.34, 2026-10-01)

Every measurement in this section was taken on **opencode 1.18.34**. The status row read `1.18.34` and
`opencode --version` agreed. Round one's dialogs came from a process that started as 1.18.33. The
recipe is the same: a private Herdr session (headless, 120 by 40, Herdr 0.9.3), the free model
`Ling 3.0 Flash Sante`, keys through `herdr pane send-keys`, pane reads with
`--ansi --source recent --lines 300`, and the journal read with `sqlite3 -readonly` from table `part`.
"Unchanged" means byte-identical pane reads. Each fixture call began after `/new`, so no text from an
earlier call sits above it. No grammar was read or run.

### A. Drift check

No difference from round one. Footers, chips, rows, tab bar and journal shapes all matched.

| Case | Keys | Result on 1.18.34 |
| --- | --- | --- |
| Single select, 3 options | `Right`, then `2` | `Right` unchanged. `2` closed the dialog at once, journal `answers [["Green"]]` |
| Multi select, 4 options | `3`, `Tab`, `Enter` | `3` gave `3. [✓] Blue` with the chip on `3`. `Tab` reached `Confirm` (`Colour: Blue`). `Enter` submitted, journal `[["Blue"]]` |
| Two questions, single select | `3`, `Enter`, `Enter` | `3` selected `Blue` and moved to `Size`. The first `Enter` moved to `Confirm`, the second submitted, journal `[["Blue"],["Small"]]` |

### B. Three questions, the second is multi select

`Colour` single (Red, Green, Blue), `Toppings` multi (Cheese, Olives, Ham, Basil), `Size` single
(Small, Large). The tab bar reads `Colour   Toppings   Size   Confirm`. The dialog's height follows
the active tab: 15 rows on `Colour`, 17 on `Toppings`, 13 on `Size`, 13 on `Confirm`. The footer
stays on row 37, so the top edge moves.

| Act | Keys | Evidence |
| --- | --- | --- |
| The footer follows the ACTIVE tab, not the call | none | `Colour` and `Size`: `⇆ tab  ↑↓ select  enter confirm  esc dismiss`. `Toppings`: `⇆ tab  ↑↓ select  enter toggle  esc dismiss`. `Confirm`: `⇆ tab  enter submit  esc dismiss` |
| Reach `Toppings` | `Enter` on `Colour` | selected the pointed option and moved on (`oc--question--three--q2-multi`) |
| A digit on `Toppings` | `2` | toggles `2. [✓] Olives` and moves the pointer to it. It does NOT advance (`oc--question--three--q2-multi--toggled`) |
| `Enter` on `Toppings` | `Enter` | toggles the pointed box, on and off again, and stays on `Toppings`. It never advances |
| Box glyphs | none | the rows carry `[ ]` and `[✓]`, and the question ends `(select all that apply)`, as in a lone multi call |
| Leave `Toppings` forward | `Tab` or `Right` | both go to `Size`. The toggles stay when you return (`[✓] Olives`, green off the pointer) |
| Leave `Toppings` back | `Left` | goes to `Colour`. The answered option reads `2. Green ✓`, the pointer starts on `1. Red`, not on the answer |
| Pointer on a revisit | `Left`, `Right` | back on `Toppings` the pointer sat on `1`, although it had been on `2` before |
| Free-text row on `Toppings` | digit `5` | opens an input row under `5. [ ] Type your own answer` with the placeholder, as in a lone multi call. `Escape` closes the input only, the dialog and the pointer stay |
| `Confirm`, all answered | `Right` from `Size` | `Colour: Red`, `Toppings: Ham`, `Size: Large`, one row per question, a bare row between (`oc--question--three--review`) |
| `Confirm`, `Size` not answered | `Right` twice from `Toppings` | `Size: (not answered)`. The words are red (`224;108;117`), the `Size:` header grey (`128`). An answer is `238` (`oc--question--three--review--incomplete`) |
| Submit with `Size` not answered | `Enter` on `Confirm` | it submits. Journal `answers [["Green"],["Olives"],[]]`, output `"Which size?"="Unanswered"` |
| Submit with all answered | `Enter` on `Confirm` | journal `[["Red"],["Ham"],["Large"]]`. One array per question, in order |
| Tab colours | none | a tab is bright (`238`) only when its question holds an answer. A visited tab with no answer stays grey. A multi tab goes grey again when its boxes are all off. `Confirm` is grey until it is active. This corrects round one's "visited" rule |

### C. Tab wrap on three questions

| From | Keys | Goes to |
| --- | --- | --- |
| `Confirm` | `Tab` | `Colour` (wraps) |
| `Colour` | `Left` | `Confirm` (wraps) |
| `Confirm` | `Right` | `Colour` (wraps) |
| `Confirm` | `Left` | `Size` |
| `Size` | `Right` | `Confirm` |

### D. `Escape` on a list tab

| Case | Keys | Result |
| --- | --- | --- |
| Lone multi list, one box toggled, not on `Confirm` | `Escape` | dismisses the dialog and ends the turn. Journal `status error`, `The user dismissed this question`, no answers. The composer came back and Herdr read `idle` |
| `Q1` of a three-question call, `Q1` already answered | `Escape` | the same. The answered `Colour` is lost, the call keeps no partial answers. The transcript keeps `→ Asked 3 questions` |

### E. Lone multi select, four options and the free-text row

| Act | Keys | Evidence |
| --- | --- | --- |
| Wrap up | `Up` on option 1 | the chip moved to `5. Type your own answer` |
| Wrap down | `Down` on row 5 | the chip moved to `1` |
| Open the free-text row | digit `5` | an input row under the row with the placeholder `Type your own answer`, the dialog one row taller (`oc--question--multi--free-text`) |
| `Tab` while the input is open | `Tab` | unchanged, byte-identical |
| `Escape` while the input is open | `Escape` | closes the input only. The dialog stays and the pointer stays on `5`. Typed text that was never committed is gone: after `tmp`, `Escape`, `5` the placeholder was back |
| Commit text | type `mine`, `Enter` | `5. [✓] Type your own answer`, `mine` under it in grey (`128`), the input closed. A key typed now is ignored (`oc--question--multi--free-text--committed`) |
| The digit on a committed row | `5` | the box goes back to `[ ]`, the input stays CLOSED, `mine` stays under it in grey |
| The digit again | `5` | opens the input with `mine` as its text. The box stays `[ ]`. The only change on screen is the text colour, grey `128` closed and bright `238` open |
| A digit while that input is open | `5` | typed as a character: the text became `mine5` |
| `Enter` on a committed row | `Enter` | the same two steps as the digit. The first unchecks, the second opens the input with the text. `Enter` in the open input commits and checks the box again |
| `Escape` on a reopened input | `Escape` | closes the input, keeps the text and leaves the box `[ ]` |
| `Escape` on an unchecked row with text, input closed | `Escape` | dismisses the whole dialog, because the input is not open. The journal read `error` |
| `Confirm` with nothing toggled | `Tab` | `Colour: (not answered)`, red, as in B (`oc--question--multi--confirm--empty`). The submit of it was not repeated on 1.18.34, round one read `[[]]` and `(no answer)` |

An option with an empty description, seen once when the model put the colour's note into the label,
still takes two rows: the label, then a bare bar row. No fixture.

### F. `Confirm` with a free-text answer

Still holds. With `Red`, `Blue` and the free-text `mineZ` toggled, `Confirm` read
`Colour: Red, Blue, mineZ`: labels in option order, the free text last. `Enter` submitted, journal
`answers [["Red","Blue","mineZ"]]`, output `"Which colours?"="Red, Blue, mineZ"`. No fixture.

### Fixtures added

`oc--question--three--q2-multi`, `oc--question--three--q2-multi--toggled`,
`oc--question--three--review`, `oc--question--three--review--incomplete`,
`oc--question--multi--free-text`, `oc--question--multi--free-text--committed`,
`oc--question--multi--confirm--empty`. All are 120 by 40, ANSI, and listed in
`web/src/fixtures/panes/README.md`.

### What surprised

- **Herdr read `idle` under every dialog.** On 1.18.34 `herdr pane get` returned `agent_status: idle`
  on a single-select dialog (three reads over 6 seconds), on `Toppings` and on `Confirm`. Round one read
  `blocked` on the single-select dialog. The cause is not known: Herdr 0.9.3 both times, the opencode
  version differs. Treat the status column of the new README rows as measured `idle`, and do not lean on
  Herdr's status to know that a question is open. The footer words are the signal.
- The model sometimes writes the description into the label (`Red (warm)`) and leaves the description
  empty. The dialog is the same shape, one bare bar row under each label. Fixtures were captured from
  calls where the label held the colour word alone.
