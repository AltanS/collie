# pi question screens: what the reader reads, and the evidence

Herdr reports stock pi and OmO (the Senpi engine) alike as `agent: "pi"`. pi's question tools are
extensions, and npm lists many. So `ask.ts` reads every one of them by shape and footer, and names
none (`.adr/0098`). This file holds the evidence for each rule: the captures, the source lines read,
and the live probes.

## The screens in the corpus

| Screen | Footer | Plan | Proof |
| --- | --- | --- | --- |
| stock `question` (pi 0.87.1, 1.1.0) | `↑↓ navigate • Enter to select • Esc to cancel` | (a) walk | `pi--v0871-question-*`, `pi--v110-question-*`; source below |
| stock `questionnaire`, one question | `↑↓ navigate • Enter select • Esc cancel` | (a) walk | `pi--v*-questionnaire-single*` |
| stock `questionnaire`, a tab page | `Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel` | (a) walk, captioned | `pi--v*-questionnaire-tabs*` |
| stock `questionnaire`, Submit page | the same footer, `Press Enter to submit` in the body | review (Enter, Escape) | `pi--v*-questionnaire-submit-ready.txt` |
| PR 397 extension, single | `↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel` | (a) walk | `pi--v110-single*` |
| PR 397 extension, a tab page | `←→ tabs • ↑↓ navigate • Enter select • type a number or text • Esc cancel` | (a) walk, captioned | `pi--v110-tabs-single*`, `-tabs-compact` |
| PR 397 extension, Review page | `←→ tabs • Enter submit • Esc cancel` | review (Enter, Escape) | `pi--v110-review-complete.txt` |
| OmO ask, one question | `↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel` | (b) digit | `pi--omo-v5130-single-described*`; probe below |
| gentle-pi `ask_user_choice`, unnumbered, no status row | `↑↓ navigate • Enter select • Esc cancel` | (a) walk | `pi--v130-gentle-choice.txt`; source below |
| gentle-pi review consent, numbered, NO rule frame, footer last | `↑↓ choose · Enter confirm · Esc cancel · D details` | (a) walk | `pi--v130-gentle-review-consent.txt`; "A dialog with no rules" below |
| pi's own selector (`ctx.ui.confirm`, `ctx.ui.select`), unnumbered | `↑↓ navigate  enter select  escape/ctrl+c cancel` | (a) walk | built from source in `ask.test.ts` |
| pi's own selector with a title of several rows: the stock `permission-gate` example, the command quoted further in | the same | (a) walk | `pi--v0871-permission-gate*`; live taps below |

Raw, with the Escape card: every multi-select (`[ ]` rows, or a footer that gives Space a tick or a
toggle), a pointer on the free-text row, every inline answer editor (`Enter to submit • Esc to go
back`), an incomplete Submit or Review page (`Unanswered: …`, `Enter goes to the first unanswered`),
every picker (below), and a Submit page beside OmO's side panel (below). A question beside the
panel lifts, bound to the columns left of it (below).

A dialog quoted in agent prose or a tool result stays prose (`pi--prose-quoted-*`). The tail
decides: the bottom rule must be the last row, or have one to four status rows under it and nothing
else, every one styled except the last, which may be plain under a styled one (pi's extension-status
line, see "The editor"), and the footer row must be styled. A bare bottom rule counts since issue
455, because Gentle Shell replaces pi's footer and leaves nothing under the dialog; a quoted block
that ends the buffer is then the same bytes as a live dialog, and the screen cannot tell them apart. With the editor below, the editor's own rules are the tail, so the
quoted block above it is never read. With no editor, a quoted block lifts only when every tail rule
holds, which is pi's own screen; a walked tap there still sends no Enter, because the pointer never
moves and the poll times out.

## Stock pi, read from its source

pi's own examples, `examples/extensions/question.ts` and `questionnaire.ts`, are the same in pi
0.87.1 and 1.1.0.

- `question.ts`: Up and Down move the pointer and clamp at both ends, over every row including the
  last one, `Type something.` (`Math.max(0, …)`, `Math.min(allOptions.length - 1, …)`). So the ends
  do not clamp at the last real option, and the reader sets no `clampedEnds`. Enter on an option
  answers and closes. Enter on `Type something.` opens an inline editor (`Your answer:`), and Escape
  there goes back to the list. Digits do nothing.
- `questionnaire.ts`: on a question page, Up and Down move and clamp, and Enter saves the pointed
  option and moves to the next tab (or to Submit after the last). Tab and Left/Right move between
  tabs and wrap. On the Submit tab, Enter submits only when every question has an answer. The
  current tab chip is drawn with a background colour only (`48;2;…`), so the reader finds it by
  that segment; answered chips are `■`.

## Unnumbered rows: gentle-pi and pi's own selector (issue 455)

Captured 2026-10-16 with pi 1.3.0, gentle-pi 4.2.0 under Gentle Shell, Herdr 0.9.5, a 200-column pane:
`pi--v130-gentle-choice.txt`, gentle-pi's `ask_user_choice` with three options and the pointer on
the first, and `-moved`, the same dialog two seconds after `herdr pane send-keys <pane> Down`, the
pointer on the second. Gentle Shell replaces pi's footer, so the dialog's bottom rule is the last row.
The Down is the walk's own key, so the pair is also the live proof that it moves this pointer.

Read from source, not captured:

- gentle-pi 4.2.0, `lib/native-choice-list.ts`: each row is a `Text` with one column of padding,
  `→ ` on the pointed row and two spaces on the others, the description as `\n   description`, so it
  lands four columns in. Up and Down clamp at both ends (`setSelectedIndex`). Enter on an option
  answers; with `allowCustomResponse` a last row `Other…` (`Provide a custom response`) opens an
  editor on Enter, so it is the `free-text` field and never a button.
- pi 1.3.0, `ExtensionSelectorComponent` (behind `ctx.ui.confirm` and `ctx.ui.select`): the same
  ` → Label` / `   Label` rows with no description, clamped at both ends, a blank row on each side of
  the footer. A `timeout` adds a ` (Ns)` countdown to the title, which moves the signature every
  second, so a tap there is refused and the phone reads again.

Unnumbered rows are read at column 1 only, never beside a tab strip, with no trailer row (a label
long enough to wrap comes back at column 1 and declines), and lift by plan (a) only.

### pi's permission gate: a title of several rows (2026-10-17)

pi's stock example `examples/extensions/permission-gate.ts` (the same file in 0.87.1 and 1.3.0) asks
before `rm -rf`, `sudo` and `chmod`/`chown 777` with
`ctx.ui.select("⚠️ Dangerous command:\n\n  <command>\n\nAllow?", ["Yes", "No"])`. The selector draws
each title line one column in, so the command row is three columns in: ` ⚠️ Dangerous command:`, a
blank row, `   chmod 777 gate-probe.txt`, a blank row, ` Allow?`, the selector's blank row, then
` → Yes` and `   No`. Until 1.22.5 the reader took the first row of that shape for the first option:
the command row, then a blank row ended the list with no pointer in it, and the phone showed the
unread-dialog card. No release read it: before 1.20.1 pi had no adapter, and 1.20.1 to 1.22.4 all
show the unread-dialog card on these captures.

The list is now the run that holds the one pointer, read up from it, and it opens on an option row.
A row indented deeper than one space may stand in the header only when the selector's blank row
stands right over the list and a row one space in (` Allow?`) stands between the two. Two shapes
with the same rows still decline: an unpointed option cut off from the list by a blank row (no
title row between), and a label wrapped back to column 1 right over the pointer (no blank row). A
quoted row straight over the selector's blank row also declines, so `select("Run?\n\n  cmd", …)`
stays raw until a capture shows it. The card's question is every header row joined, the command
included: `⚠️ Dangerous command: chmod 777 gate-probe.txt Allow?`.

**Probed live 2026-10-17** (pi 0.87.1, Herdr 0.9.4, a bridge from the fix's worktree, 120 columns):
the card read Yes, No and Cancel, and a tap through `POST /api/ask/<id>` sent `Enter` on Yes, and
`Down`, a read-back with the pointer on No, then `Enter` on No. pi ran the command after Yes (the
file went from 644 to 777) and printed `Blocked by user` after No.
`ask_user_question` (`❯` rows, a tab strip) is read from source only and stays raw with the Escape
card.

## A dialog with no rules: the review-consent screen

Captured 2026-10-18 with pi 1.3.0 and gentle-pi 4.2.0 (`herdr pane read --format ansi`, CRLF rows):
`pi--v130-gentle-review-consent.txt`. Measured shape, bottom up: there is NO rule frame and NO editor
or status row under the dialog, so the footer is the last non-blank row of the screen.

- the footer, painted (rgb 127), at column 0: `↑↓ choose · Enter confirm · Esc cancel · D details`;
- a blank row, one painted description paragraph at column 0 (`Effect: …`, it describes the pointed
  option), a blank row; both optional, the paragraph at most three rows (`framelessNote`);
- three numbered options, `N. label`, exactly one `→` at column 0 (rgb 157, the pointed row), the
  others indented by two spaces;
- two prose rows, then the bold painted title row, then a blank row and the transcript (`⠙ Working`).

`ask.ts` (`framelessFrame`) reads it only when the footer parses and is painted and the last row, a
`1.` row stands above it with a header block over it whose first row is painted, and no rule is among
the rows. The tail decides, as ever: a dialog quoted in prose sits above pi's real editor, whose
rules make `statusTailBottom` take the tail first, and a plain footer fails `footerAt`. `choose` is
taught to `parsePiFooter` as moving the pointer and `confirm` as Enter's select; `D details` is a
letter key the plan never emits. The plan is the walk (arrows, verify the pointer, Enter), and the
card's last row is `Cancel`, Escape, in the footer's words. Unnumbered rows never lift frameless (a
column-0 `→ name` is pi's palette).

The second capture, `pi--v130-gentle-review-consent-moved.txt` (after `herdr pane send-keys <pane> Down`),
has `→` on option 2 and an `Effect:` paragraph that now describes option 2. That paragraph follows the
pointer, so `coreSignature` blanks the note rows; without it the walk pair would read as a changed
dialog. The pair is in `walk-pairs.ts`.

Not proven: a walked tap on this screen end to end through the phone.

## OmO, probed by the PR 412 author

Captured on 2026-10-12 with OmO 5.1.30 (Senpi 2026.10.11), Herdr 0.9.3, a 113-column sandbox tab.

| Action | Keys | Observed result |
| --- | --- | --- |
| Select Blue while the pointer is on Blue | `3` | Dialog closes; agent echoes `PROBE_ANSWER=Blue` |
| Move the pointer | `Down`, `Up` | Only the pointed option changes; all descriptions remain |
| Focus the Other row | `Down` to the last row | `→ Type your own answer...` |
| Open Other's editor | `Enter` on that row | `Your answer ...` and `> ` input; footer changes |
| Discard the empty Other editor | `Escape` | Returns to the question |
| Cancel an unanswered question | `Escape` | Tool reports `cancelled`; agent resumes |
| Cancel a multi-select question | `Escape` | Tool reports `cancelled`; agent resumes |

A choice sends its printed digit alone, never a trailing Enter. OmO's
`dist/modes/interactive/components/ask-user-question-keys.js` sends `1` to `9` to
`activateOption`, and for one question with `multiSelect: false` it submits at once. The `3` probe
confirmed it. Enter there means "next", so the footer gives no Enter plan, and plan (b) applies
only on one question: one question chip, and the `Submit (0/1 answered)` counter when it is there.

OmO's multi-select prints no checkbox. Its footer says `space toggle  enter toggle`, and Enter
toggles, so the footer alone keeps it raw (`pi--omo-v5130-multi.txt`).

OmO's title row counts down (`Ask user · 30m`). `coreSignature` blanks that clock and the pointer,
`signature` keeps both, so a tap on a screen whose clock moved is refused and the phone reads again.

**Probed live, 2026-10-12, by the PR 412 author** (OmO 5.1.30, Herdr 0.9.3, a paired headless
Chromium at the `iphone-14` preset). Chat drew the card with three option buttons and Cancel. With
the pointer on Red, a tap on Green answered `Color: Green`.

## The editor

Registering an adapter for `pi` moves every pi pane off the one-step send onto the guarded one
(`lib/reply-action.ts`), so `composer.ts` reads both editors: stock pi (0.85.1, 0.87.1, 1.1.0: a
rule, the draft at column zero, a rule, status rows) and OmO (a `❯` row and two-space continuations).
The slash palette, a labelled top rule and a pasted shorter rule come from the PR 397 captures and
the canary's `15-rule` message. `composerReady` is false whenever `piModalOnScreen` holds, so the
phone never types into a question's answer editor.

The status rows are styled, except the last, which may be plain under a styled row. pi's footer
(`components/footer.js` in pi-coding-agent 1.1.0) joins every extension's `ctx.ui.setStatus` text
into ONE row after its own, truncated and unstyled unless the extension paints it. A default OmO
install prints its badge and memory there with no colour (`pi--omo-v5130-plain-idle.txt`), so
in 1.20.1 no OmO editor was found and every send was refused (#416; the reporter's own extension
painted a segment of that row, which hid it). Two plain rows, or a plain row straight under the
rule, are still output and not pi; across the whole corpus the only other screens that read as a
pi editor are the same three agy prompts as before (`composer.test.ts`).

The `/` completion list stands between the bottom rule and the status rows in two forms: stock pi's
`→ name` and `  name` with a `(n/m)` counter, and OmO's `  → name` and `    name`. One row carries
the arrow, on any row of the list, and the list counts only under a `/` draft.

## Pickers

Probed live 2026-10-12. pi's own `/model`, `/tree` and `/resume`, and OmO's, replace the editor
with a picker. OmO's `/model` and `/resume`, and stock `/resume`, sit between two rules of the
editor's width with rows the stock editor shape accepts, so in 1.20.1 they read as a ready
editor holding the picker's rows as a draft, and a phone send typed into the picker's search. The
others read as nothing at all, so Chat showed no card.

Every picker prints a key-hint row, and that row is what tells a picker (`ask.ts`,
`pickerOnScreen`):

| Picker | Hint row |
| --- | --- |
| OmO `/model` | `enter select ctrl+s select as default ctrl+f favorite` (single spaces) |
| OmO and stock `/tree` | `↑/↓ move · ←/→ page · ctrl+←/→ branch · ctrl+x copy · …` over an inner rule |
| OmO and stock `/resume` | `ctrl+s sort · ctrl+n named · ctrl+d delete · ctrl+p path (off) · ctrl+r rename` |
| stock `/model` | `Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel` |

A hint row is painted, and nothing but two or more key/action pairs (`keyHintPairs`, `footer.ts`).
With single spaces, a chord or an arrow always starts a pair, so `ctrl+d delete` is one pair.
It stands between the bottom rule and the nearest rule of its width above, or, when that section
is not an editor, in a header of at most eight rows above it. It never counts inside an OmO `❯`
frame, and a stock editor's rows are typed text, which pi never paints: a draft that reads
`enter select ctrl+s …` is a draft (`ask.test.ts`). Escape closes every picker; the card offers it.

## The side panel

OmO's fullscreen mode draws a panel at the right when the pane is at least 120 columns wide
(`side_panel` in `~/.omo/omo.jsonc`). When the panel is taller than the free rows it runs beside the
editor and the dialogs, starting at the column where the editor's rules end, W. `panel.ts` crops
every row at W when a rule runs straight into text, or when a row of the frame at the tail is padded
to W and then carries text. W counts only when it is the run of the tail frame's own bottom rule and
the sign is a row of that frame: agent output can print a rule straight into text too (a markdown
heading), and that must not crop the real frame (`panel.test.ts`). Windows ConPTY is not verified: `docs/windows.md` lists pi and OmO under "What is not tested".
Probed live 2026-10-12 at 125 columns: an idle send, a draft read back
without panel text, a `/` command. The panel ticks (`elapsed 1m21`), so the editor's bound prompt,
which is whole rows, binds nothing there: the write is unbound and Enter still waits for the
read-back. On an 18-row pane a picker pushes the bottom rule off the screen; see "A dialog taller
than the pane" below.

A question beside the panel lifts and binds to the columns it was read from, 0 to W
(`PromptModel.bindColumns`, `web/src/lib/column-range.ts`). The phone sends them as
`expected_columns`, and the bridge cuts every row of its fresh read to the same columns before it
compares. So the panel's clock does not refuse a tap, and a change in the dialog does, the title's
countdown included. A Submit page beside the panel has no capture and stays raw. **Probed live
2026-10-12** with OmO 5.1.30 in fullscreen mode in the tap rig, a 120 by 24 pane, the panel on
(`side_panel.min_columns: 100`, because the rig's pane is 120 columns wide): the card read
`Red=1`, `Green=2`, `Cancel=Escape` with columns 0 to 87. The model was read, then the panel
ticked (`elapsed 1m37` to `1m40`). A whole-row binding of that region was refused (`not_found`),
and the real `submitPromptOption` with the same stale model sent `2`: OmO recorded `Color: Green`,
and the audit line carries the columns. A first attempt was refused at entry, correctly, because
the title's countdown went from `30m` to `29m` between the read and the tap. On a 20-row pane the
same question lost its bottom rule off the screen; see the next section.

## A dialog taller than the pane

OmO's fullscreen mode draws a dialog from the top down. On a short pane (an 18-row `/tree`, a
20-row question beside the panel, probed live 2026-10-12) the dialog runs past the last row, so the
bottom rule and the status rows are off the screen. Every reader above starts from those rows, so
until 2026-10-15 such a screen read as nothing: no card, not even the Escape card, and a send was
refused. `ask.ts` (`openFrameTop`) now reads it as an open frame. What proves the modal once the
bottom rule is gone, all of it:

- The screen ends inside the frame: no pi status rows at the tail, nothing under the frame's top
  rule is a rule, and no row under it is wider than the rule.
- The top rule is the lowest full rule on the screen, and one of two shapes follows:
  - a dialog: after at most one blank row, a painted header row one space in (OmO's title
    `Ask user · 30m`, stock pi's question), every later row one space in or a pointer row, and the
    first option row (`1.`) or the footer on the screen;
  - a picker: a painted key-hint row in the header section between this rule and the rule of its
    width above it, and no `❯` editor row under it.

So the top rule plus a painted title is the core, and an option row or the footer is the second
sign: a title alone, cut above the options, proves nothing. An open frame is always a modal, so the
Escape card shows. Buttons need the footer, because every key comes from the footer: with the footer
on the screen the question lifts exactly as a closed one does, its region running from the top rule
to the screen's last row; cut above the footer, it gets the Escape card only. Beside the panel the
panel's column comes from the top rule (`panel.ts`, sign c), so the card binds to columns 0 to W.

The evidence is cut from real captures, not captured short: `pi--omo-v5130-panel-question-cut.txt`
(footer on screen, lifts), `-panel-question-cut-footer.txt` (cut above the trailer, Escape card) and
`-panel-picker-tree-cut.txt` (18 rows, Escape card); the fixtures README says so. The limit, pinned in
`ask.test.ts`: a dialog quoted in prose and cut at the screen's last row, with no editor and no
status rows under it, reads as an open frame. While pi runs its editor is at the tail, and after it
exits the shell prompt is, so that screen needs a pane cut mid-quote in the moment Herdr still says
`pi`.

## OmO's question banner

When OmO's ask arrives during a turn it may first show a banner over a ready editor:
`? Question pending (1 unanswered)`, the options as `[ Red ]  [ Green ]`, and `enter or alt+up to
answer · /answer · or just type your reply`. Enter on the empty editor opens the real dialog, which
lifts. Probed live 2026-10-12: a phone send while the banner shows is typed, read back and
submitted, and OmO takes it as the free-text answer (`↳ Color: "Blue please"`), as the banner says.
Nothing is lost or sent elsewhere, so the banner is left as it is: a ready editor, no card.

Chat used to give no sign of it, because Chat draws the session record and not the screen. Since
2026-10-15 the adapter answers `questionPending` (`ask.ts`, `piQuestionBanner`): the editor is ready,
no modal is up, and at most eight rows above the editor's top rule, with no blank row between, a row
opens with a painted `?` and reads `? Question pending (N unanswered)`. Chat then ends the thread with
one status line, "A question is waiting in the terminal. Your next message answers it.", with the
needs-you mark and no control (`session-stream.tsx`). No card and no buttons: the banner prints no
key a card could send but Enter, and a send is already its answer. The terminal view shows the banner
itself. Chat has no in-stream way to the terminal view; the pane menu's "Terminal view" row is the
one there is. Pinned by `pi--omo-v5130-question-banner.txt`, the only screen in the corpus that reads
so (`ask.test.ts`).

## NO_COLOR and monochrome panes

The editor, the dialog footer and the picker hint row are told by paint (`composer.ts`
`paintedStatus`, `ask.ts` `styledRow` and `paintedRow`), because the paint is what keeps a dialog
quoted in prose, or a draft that reads like key hints, from being read as pi's own. So a pane with no
colour would read as nothing. Captured 2026-10-15 in the tap rig: stock pi 0.87.1 and OmO 5.1.30 each
had `NO_COLOR=1` in its process environment (checked in `/proc/<pid>/environ`) and painted every row
as before, 24-bit colour on the rules, the status rows, the footer and the options. Neither honours
the variable: pi bundles chalk's colour check, which reads `FORCE_COLOR` and the terminal, and draws
its theme colours itself. The four captures (`pi--v0871-nocolor-*`, `pi--omo-v5130-nocolor-*`) read
exactly as the colour ones, and the tests pin that. No monochrome pi screen exists to read, so the
readers keep the paint rule and fall back to nothing: a shape-only fallback would have no capture to
prove it and would loosen the quoted-dialog rule for a screen nobody has seen. If a pi version starts
to honour `NO_COLOR`, capture it first, then read it.

## Not covered

- The PR 397 extension is not published, so its screens are read from the contributor's captures
  only, and three of its walk groups have one capture each (`WALK_GAPS`).
- Multi-select on any pi screen. The only evidence for a Space-then-Enter recipe is the PR 397
  extension, and OmO's Enter toggles. It stays raw until a published extension proves the recipe.
- OmO with several questions, or with an answered question.
- A Submit page or a walked question beside OmO's side panel: no capture. Only OmO's one-question
  digit card is proven there.
- A dialog taller than the pane whose options are on the screen but whose footer is not: Escape
  card only, because the keys come from the footer. No live capture of a cut screen yet; the
  fixtures are cut from whole ones.
- pi and OmO on Windows. Every capture is from Linux, and whether ConPTY pads OmO's side panel or
  the dialog rows the same way is not known. `docs/windows.md` lists it under "What is not tested".
- A pi or OmO pane with no colour: neither honours `NO_COLOR` (see "NO_COLOR and monochrome
  panes"), so no such screen has been seen.
- A picker taller than the pane, which pushes the bottom rule off the screen.
- A live tap on gentle-pi's `ask_user_choice` through the phone: the reader is pinned on the
  captures and the source, and Down was sent by Herdr, but no tap went end to end. pi's own selector
  was tapped end to end on the permission gate (see above).
- A column-0 dialog between two same-colour rules that ends the screen with an unpainted footer reads
  as a ready composer on a bare-rule editor (PR 450). Every captured pi footer is painted; the
  bridge's send protocol probe is the second line.
