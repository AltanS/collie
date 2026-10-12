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

Raw, with the Escape card: every multi-select (`[ ]` rows, or a footer that gives Space a tick or a
toggle), a pointer on the free-text row, every inline answer editor (`Enter to submit • Esc to go
back`), an incomplete Submit or Review page (`Unanswered: …`, `Enter goes to the first unanswered`),
every picker (below), and a Submit page beside OmO's side panel (below). A question beside the
panel lifts, bound to the columns left of it (below).

A dialog quoted in agent prose or a tool result stays prose (`pi--prose-quoted-*`). The tail
decides: the bottom rule must have one to four status rows under it and nothing else, every one
styled except the last, which may be plain under a styled one (pi's extension-status line, see "The
editor"), and the footer row must be styled. With the editor below, the editor's own rules are the tail, so the
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
heading), and that must not crop the real frame (`panel.test.ts`). Windows ConPTY is not verified. Probed live 2026-10-12 at 125 columns: an idle send, a draft read back
without panel text, a `/` command. The panel ticks (`elapsed 1m21`), so the editor's bound prompt,
which is whole rows, binds nothing there: the write is unbound and Enter still waits for the
read-back. On an 18-row pane a picker pushes the bottom rule off the screen; that screen reads as
nothing and a send is refused.

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
same question lost its bottom rule off the screen and read as nothing, like the picker above.

## OmO's question banner

When OmO's ask arrives during a turn it may first show a banner over a ready editor:
`? Question pending (1 unanswered)`, the options as `[ Red ]  [ Green ]`, and `enter or alt+up to
answer · /answer · or just type your reply`. Enter on the empty editor opens the real dialog, which
lifts. Probed live 2026-10-12: a phone send while the banner shows is typed, read back and
submitted, and OmO takes it as the free-text answer (`↳ Color: "Blue please"`), as the banner says.
Nothing is lost or sent elsewhere, so the banner is left as it is: a ready editor, no card.

## Not covered

- The PR 397 extension is not published, so its screens are read from the contributor's captures
  only, and three of its walk groups have one capture each (`WALK_GAPS`).
- Multi-select on any pi screen. The only evidence for a Space-then-Enter recipe is the PR 397
  extension, and OmO's Enter toggles. It stays raw until a published extension proves the recipe.
- OmO with several questions, or with an answered question.
- A Submit page or a walked question beside OmO's side panel: no capture. Only OmO's one-question
  digit card is proven there.
- A picker taller than the pane, which pushes the bottom rule off the screen.
