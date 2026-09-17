# 0048 — The input box is found by its own frame

- **Status:** Accepted
- **Date:** 2026-09-17
- **Shipped in:** _(set at the release commit)_
- **Amends:** [ADR 0004](./0004-the-statusline-run-is-bounded.md). The 8-row statusline bound stays,
  and so does its size. It now bounds only what the view strips as a statusline. It no longer
  decides whether the box exists, so it no longer guards the send.
- **Trail:** `web/src/lib/harness/claude/chrome.ts` (`locateInputBox`, `classifyTail`) ·
  `web/src/lib/harness/claude/input-box-frame.test.ts` · fixture
  `claude--autocomplete-slash-clipped.txt`

## Context

**A row the walk could not name hid a live box.** `locateInputBox` used to find the box by walking
up from the last line of the screen. It crossed the rows under the box first, with a budget: 8
statusline rows plus a footer, or a completion popup its grammar could read. Only then did it look
for the bottom border.

On an 82-column pane, Claude clipped a plugin command name in its slash popup to
`…escript:refactor-dependencies`. The popup grammar wanted a leading `/`, so the run ended early.
The walk spent its 8 rows, never reached the border, and reported no box. `composerReady` read
false, and the send guard typed the text and withheld Enter. The operator had to send twice.

This is the third time the same walk failed the same way. The background-agents footer broke it
first (`fixtures/panes/README.md`), a tall statusline second (ADR 0004), the popup third
(`autocomplete.ts`). Each fix taught the walk one more shape to cross. The next shape Claude paints
under its box will break it again.

**The walk was also weaker than it looked.** ADR 0004 measured that the row count never refused a
dialog; the blank line above a dialog's footer did. A dialog with no blank, directly under an
echoed box, passed: `box + "1. Yes" + "2. No" + "Enter to select · Esc to cancel"` read as a live
composer with a 3-row statusline.

## Decision

**Find the box by its own three marks, then account for every row below it.**

1. **The lowest frame mark is the bottom border.** Walk up from the last non-blank line to the first
   row that is a box border, a top-border-shaped rule, or a `❯`-led line. It must be a bare U+2500
   border, within 60 rows. So the box is the lowest box-shaped triple on screen. The rows below it
   hold no border, no labelled rule and no `❯` prompt line.
   One exception serves a statusline that draws such a row itself, for example a starship-style
   `❯ ~/src on main` or a `─ main ───` separator. The walk steps over a `❯`-led row without a
   number, and over a labelled rule. The box then stands only if the tail is `statusline`, every
   stepped row sits in its run within 8 rows of the border, and no labelled rule sits directly on
   a `❯` row. That last shape is a second box's top border and prompt. A `❯ 1. Yes` pointer row is
   never stepped over.
2. **The frame closes.** A `❯` line and a top border sit above it, inside the existing draft budget.
3. **The tail is labelled, never walked for the box.** `classifyTail` names it `statusline` (the old
   bounded walk), `autocomplete` (the popup grammar, under a `/` draft), or `unknown`.
4. **No modal is on screen.** Every specific dialog grammar runs over the whole screen and none may
   claim it. No tail row may carry a dialog footer. No `statusline` or `unknown` tail row may carry
   a numbered option or a `<key> to <verb>` hint. An `unknown` tail may also carry no `❯` anywhere,
   no rule and no stepper header. A `statusline` tail is exempt from those three, because a
   statusline may draw them. A popup tail is exempt from all of step 4 except the grammars and the
   footer check, because its grammar named every row.

**The view strips only classified chrome.** The box always goes. A `statusline` tail is stripped and
re-surfaced as before, and a popup becomes its list. An `unknown` tail stays on the raw mirror, under
the transcript.

**60 is the popup's own cap.** The old walk reached 17 rows as a statusline and 60 as a popup, so
every tail it accepted fits. The number buys no safety alone. Steps 1 and 4 do.

**The popup grammar also reads a clipped name.** A name may start with `…` as well as `/`. The clip
is by column, so a clipped name may also open on `-`, `_` or `:`; a `/` command id still may not. A
name may carry a parenthesised alias (`…opic-skills:morning (morning)`), which sits inside the name
column and leaves the two-space column gap alone. The description column still has to agree, so the
grammar is no looser. `@` file mentions stay out: no capture of that popup exists.

## Consequences

- **Safety now comes from the frame and the modal checks.** Neither is a row count. A stale box
  above a live dialog is refused when the dialog paints a step 4 mark in the tail, or a dialog
  grammar claims the screen. That holds at any tail height. A statusline-shaped tail is checked
  only for numbered options and key hints.
- **A tall unknown tail no longer stalls the send.** It used to refuse the box. Now the box is found,
  and the rows stay visible on the mirror. A statusline taller than 8 rows sends again, and it shows
  as raw rows rather than on the status strip.
- **An unrecognised modal with none of the step 4 marks would read as a live composer.** No such
  screen exists in the corpus: every Claude dialog capture carries a `❯` pointer, a rule or a key
  hint in its rows. Under a statusline-shaped tail the bar is lower: a dialog with an un-numbered
  `❯` pointer or a rule, and no numbered row or key hint, would also read as live. A new modal
  shape is a new capture and a new grammar, as before.
- **The echo limitation in ADR 0004 is narrower.** An echo of our own send, bracketed by rules,
  above a dialog with numbered rows or a key hint is now refused. With a statusline-sized run below
  that carries neither, it still reads as a draft. `draftCarriesSend` still cannot tell.
- **The old corpus agrees.** On every Claude capture the new locator finds the same boxes and
  refuses the same dialogs, with the same drafts, statuslines and strip counts.
  `input-box-frame.test.ts` pins that, and pins each check in step 4.

**What would justify revisiting this:** the same as ADR 0004. With Herdr's `agent_status` or scroll
geometry in the client, box liveness could be established instead of inferred from shape.
