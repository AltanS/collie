# 0048 — The input box is found by its own frame

- **Status:** Accepted
- **Date:** 2026-09-17
- **Shipped in:** 1.10.1
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

## Addendum — 2026-09-26: an indented row inside the frame is draft text

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum adds one
rule to step 2.

**A draft that held a rule or a `❯` line hid its own box.** Step 2 walked up from the bottom border
and stopped on the first box border or prompt row. A pasted rule (`────`) inside the draft stopped
the walk on a row that is not a prompt, and a pasted shell prompt (`❯ ls -la`) stopped it on a row
with no top border above. Either way the locator reported no box, `composerReady` read false, the
phone showed the unread-dialog card, and a send stalled. Pasting terminal output is enough to do
it. The three `claude-lab--draft-adversarial--*` captures were pinned as a declined `knownStall` for
exactly this, because comparing the two borders' widths was the only discriminator then on the
table.

**Claude paints the frame at column 0 and indents the draft.** On every box in the Claude fixture
corpus and the 2.1.283 captures (84 boxes), the top border, the prompt row and the bottom border
start in column 0, and every wrapped-draft continuation row is indented by two spaces. So step 2
now reads: only a row at column 0 can stop the walk up from the bottom border, and the prompt row
and the top border must both sit at column 0. An indented row is a continuation, whatever it holds.

Step 1 is unchanged and stays indent-blind: a dialog's pointer row and a statusline's own rule are
often indented, and they must still stop the search for the bottom border. Step 4 is unchanged, so
the modal checks guard the same screens as before.

**What would reopen this:** a real capture of a Claude input box drawn away from column 0 (a new
layout, a gutter, a nested frame). The locator would then report no box on that screen, which is
this module's designed failure mode, a stalled send rather than a typed modal.

Trail: `web/src/lib/harness/claude/chrome.ts` (`atColumnZero`, `walkFrame`) ·
`web/src/lib/harness/claude/input-box-frame.test.ts` · fixtures `claude--v2283-draft-rule.txt`,
`claude--v2283-draft-prompt.txt`.

Since 2026-10-15 (M56 spec 03) the walk lives in `web/src/lib/surface/frame.ts` (`findInputFrame`,
`frameAt`, `frameEdge`), read from the profile's anchors in `web/src/lib/surface/profiles/claude.json`.
`atColumnZero` and `walkFrame` are gone; the column-0 rule is the anchor's column, and the rule above
holds unchanged.

## Addendum, 2026-10-25: a frame is found, a draft in it is proven

A frame can be found and still be stale. Altan's OMP 18.6.1 pane under Herdr kept the status row and
the box of an earlier layout on its last two rows, with an old draft in the box. OMP drew its live
editor higher up, under the answer, with no frame of its own. The reader found the old box and read
a draft, so every send was refused `draft_present`, and a Replace pressed 41 Backspaces into the
live editor and ended `unknown`. The fixture is `omp--v18-6-1-stale-frame-below-live--w120.txt`.

The rule this adds, in the Send Protocol (`bridge/surface/protocol.ts`, the header) and the Clear
route (`bridge/surface/clear.ts`):

1. **A draft is a reading until a probe proves it.** When S0 reads a draft in an idle box with no
   dialog, the request types the probe character before it refuses `draft_present`, appends, clears
   or submits. The character must land in the box after the draft; one Backspace takes it out, and
   the run goes on from that read. A real draft costs the probe and one Backspace, nothing more.
2. **A probe that lands elsewhere or nowhere marks the frame stale.** A character that shows outside
   the box is taken back with one Backspace. A character that shows nowhere is left alone. No clear
   key is pressed on a box that did not take the probe.
3. **One second read, never a loop, and no redraw.** After one S0 gap S0 reads again. A box that now
   reads empty, or shows other rows whose draft takes a second probe, goes on from that read. The
   same rows again, or a second probe that does not land, ends `refused(probe_failed)` with the
   cause `stale_screen`, the key pad as the only offer, and nothing deleted. A Clear ends
   `refused(stale_screen)`. Collie does not ask the multiplexer to redraw the pane: a resize, even
   one cell and back, writes the operator's geometry, which
   [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md)'s 2026-09-05 amendment refuses, and
   it could not reach a pane alone in its tab anyway. A per-pane redraw is an ask to Herdr
   (`HERDR_API.md`, "What Herdr should provide").
4. **The pane says so.** After a request proved a frame stale, the bridge's Surface carries
   `staleFrame: true` on every read that shows the same box rows, and drops it at the first read that
   shows others. The phone shows it in the field's placeholder, never in a row of its own.

Left out on purpose: a box at its scroll height (`Frame.scrolled`) shows a slice of its draft, so it
is not probed and keeps its own refusals. A marked send (walky talky) over a draft is held, not
refused, and is not probed: nobody tapped it, and a person may be typing in that box.

Trail: `bridge/surface/protocol.ts` (`draftToProve`, `proveDraft`, `draftProbe`, `takeBack`,
`staleScreen`) · `bridge/surface/clear.ts` (`prove`, `probeBox`) · `bridge/surface/shadow.ts` (`markStale`) ·
`protocol.test.ts` ("a draft is a reading until the probe proves it").

## Addendum, 2026-10-26: a frame on its way is read again, and a proven draft is never held

Omp gang three, tester 2 (screen desync) and tester 3 (launch), Herdr 0.9.5, omp 18.6.1 and 18.12.6.
Holds have no ADR of their own (M56 spec 15 and the protocol header carry them); these rules sit
here because each one is about what a read of the box proves.

1. **A screen in flux is read once more before it holds or refuses.** For 50 to 100 ms after a client
   resize Herdr shows the old frame re-wrapped to the new width, until the program draws again. A send
   in that window was held `not_free` on an idle, empty box and went out about 42 s later (plain 5 of
   8, replace 6 of 12). S0 now takes one more S0 after `SETTLE_MS` (150 ms) when its two reads differ in
   shape (row count, or the widest row), when one read has a frame and the other reads as nothing at
   all (`no-match` or `torn`), or when its read is `torn`. Herdr's `visible` read keeps the pane's row
   count, so a frame re-wrapped to a narrower width can share the new size; it then has no frame. A
   dialog that opened between the reads reads as a dialog and gets no second S0. Only before any key,
   only once, never a loop; the read in flux and the pause are `gapsMs.settle`, and `s0` stays the
   time of the reads that were judged. No new mux field: the reads carry the signal.
2. **A probe that proves a draft ends `draft_present`, never a hold.** A stale row painted over the live
   box row while the live editor held `xy`: the probe went in, one Backspace took it out, the box then
   read `xy`, and the send was held as a clean probe. It went out later, behind the person's Replace,
   in an order the person did not choose. Now a failed probe whose one Backspace was read back, with
   no other key typed, and whose read shows a draft in the conversation's own box (no modal, not
   another screen's box), ends `refused(draft_present)` with the draft's offers. A clean probe over an
   empty box is held as before: a hold is for a box that is free but not ready.
3. **A box hold goes on the first free poll once its cause has cleared.** A send held because the box
   was not free (no turn read) waited for the quiet rule, five free polls over ten seconds. An idle
   pane polls every `pollIdleMs` (12 s), so a send held at launch arrived 29 to 50 s late on an idle,
   empty box. While no poll has read a running turn and no release has run since the hold was made,
   the first poll that reads the pane idle with an empty box releases it (`CLEARED_FREE_POLLS`). The
   release's own S0 is the fresh check: two reads that agree, before any key; a box not free there
   sends it back to its place. After a running turn the two-free-polls rule stays, and after a release
   the quiet rule stays, because a turn may yet draw.

Left open, for a decision: a held send can still go out after a later send on the same pane that does
not join the queue (a Replace, an Add to it, a Submit, a steer). Ending the held one would need a new
reason (`superseded`), so it is not built here.

Trail: `bridge/surface/protocol.ts` (`settledS0`, `inFlux`, `shapeOf`, `probeCleanup`, `tickHolds`,
`CLEARED_FREE_POLLS`) · `bridge/surface/protocol.transient-holds.test.ts` · `protocol.test.ts` ("a send
at a box that is not free is held") · fixtures `omp--v18-12-6-idle-w200.txt`, `omp--v18-12-6-idle-w60.txt`,
`omp--v18-12-6-stale-row-over-live-draft.txt`.

## Addendum, 2026-10-26: the hold queue reads Collie's residue as an empty box, and plain sends keep their order

The live checks of 1.24.1 on the dev lane, omp 18.6.1 started by hand in a shell pane, a stub model,
sends at +0.3 s and +0.7 s, 14 runs (findings W1, W3 and W4). The addendum above put the hold rules here;
these follow them.

1. **Collie's residue is never a draft, in the hold queue too (W1, 8 of 14).** A send at +0.3 s left its
   probe `⌁` in a box that did not read keys yet. A send at +0.7 s was held, the poll then read `╰─ ⌁` as
   a draft, wrote the cause `draft_present`, and never released it; every later send joined behind it,
   for up to 30 minutes. A direct send already took the residue out (ADR 0107's addendum). Now
   `tickHolds` gets the poll's box text (`boxOf`) and reads an idle box whose whole text is the held
   send's probe character as an empty box: no draft cause is written, and the first free poll releases
   it. The release's run proves the box, takes out one character per marker, and goes on from a read
   that shows the box empty, before any key of the send.
2. **A held send whose cause cleared goes on the first free poll (W3, 2 of 14).** A pane's watch outlived
   the requests it watched: a release that went out, or a cancel, left it behind, and the next box hold
   on that pane inherited `cleared: false` from the release and waited for the quiet rule (five free
   polls over ten seconds, more when a poll read the box between). A pane's first held request now
   starts its watch afresh, and the poll drops the watch of a pane with no held request. A free read
   also rewrites a stale `draft_present` cause on a request no draft holds to `not_free`. A walky talky
   send held over a person's draft keeps its own rule.
3. **Plain sends to one pane go first in, first out (W4, 1 of 14).** `early-1` at +0.3 s was held,
   `early-2` at +0.7 s went out directly, and the journal had 2 before 1. The pane was still named a
   shell, so it had no profile of its own, and the join to the queue needs one. A plain send (`mode:
   send`) to such a pane that holds an earlier plain send now joins behind it with the profile that send
   was held with, and its receipt says "Earlier messages wait for this pane".

The note above stands for every other mode: a Replace, an Add to it, a Submit, a steer and a command on
a pane with no profile of its own still do not join, and ordering them is deferred (it would need a
reason such as `superseded`).

The borrowed profile never crosses agents (counsel review, 2026-10-26): only a held send taken for the
pane's generation now lends it. A held omp send on a pane omp has left is the poll's to end `pane_gone`;
a send that came before that poll took omp's profile on what was a shell by then. A pane that runs
another harness gives a new send that harness's own profile, as before. A pending probe character holds
the queue for at most 30 s from the moment it was typed (ADR 0107's addendum of the same day).

Trail: `bridge/surface/protocol.ts` (`tickHolds` with `boxOf`, `hold`, `heldPlainProfile`) ·
`bridge/index.ts` (the poll passes `surface.boxOf`) · `bridge/surface/protocol.deaf-box.test.ts` ("the
live checks of 1.24.1") · `protocol.test.ts` ("live check W3").

## Addendum, 2026-10-26: a command's Enter waits for two reads that agree

Omp gang three, tester 5 (W1), omp 18.6.1. A command-mode send of a path-like text (`/tmp/x`,
`/etc/hosts`, `/bin/sh`, `/exit/now`) ran `/loop` 4 of 4: omp drew a one-entry fuzzy list under the
box, `❯ ↻ loop   Loop: off`, and Enter picked it. The check before a command's Enter now reads the
list whatever the profile's `notForText` says (51088a268), and that refuses a list drawn by S1's first
read, 80 ms after the write. Under load omp draws its list later than that, so S1 passed on a read
with no list yet and Enter went out over the list that came next. The same holds for a late `/mo`
list. A read of the box proves what the screen showed at that moment. It never proves what the
program is about to draw.

1. **Enter on a command never goes out on the first read after typing.** A command (mode `command`)
   on a harness whose profile declares a command list (`idle.volatile.below.commandList`) needs two S1
   reads that both pass S1's test and agree on the rows under the box: the same rows below the frame,
   and the rows of a list drawn over it, or both reads with no list at all (no command list, no popup,
   no pointer cue under the box). The second read comes at least `COMMAND_SETTLE_MS` after the first.
2. **The settle interval is 160 ms.** This is S1's own second gap (twice `FIRST_GAP_MS`), so the read
   that agrees sits about 240 ms after the write. An S1 that missed its first read reads there too.
   The omp gang's receipts say how far a key's echo reaches. Of 684 probes (the probe key, then its
   Backspace, each polled from 80 ms), 529 took under 200 ms, and all but one took under 490 ms. That
   is each half seen by its second read at the latest, about 240 ms after its key. One took 570 ms. A
   list is drawn after the text, by an asynchronous lookup and the next frame. A read 160 ms after the
   first one gives it that same reach, at the cost of one poll step. The number is shared. No harness needs another yet, so the
   profile has no field for it. A harness that needs one adds it as profile data, never as a name in
   shared code.
3. **The second read judges as the first did.** A list there that points at another command refuses
   as before: `typed_not_submitted (modal_cue)` with the list notice, Enter not pressed. Rows that keep
   changing make each read a new first read, inside S1's bound (6 reads, 2500 ms). When the bound runs
   out with no agreeing pair, the send ends `typed_not_submitted (changed)` with the detail "The rows
   under the box did not hold still after the command was typed". Enter is never pressed on a moving
   list.
4. **The cost is measured.** `gapsMs.commandSettle` runs from the first of the two agreeing reads to
   the second; `gapsMs.s1` ends at the first. On a quiet pane it is the 160 ms interval plus one read.
   A plain send, a command on a harness with no command list, and a Submit of a typed command are
   untouched. A Submit's S0 already takes two reads 120 ms apart of a box typed long before.

Trail: `bridge/surface/protocol.ts` (`COMMAND_SETTLE_MS`, `commandSettles`, `settleKey`, `noListAtBox`,
`awaitTyped`, `poll` with `again`, `lapS1`) · `web/src/lib/surface/send.ts` (`SendStep`
`commandSettle`) · `bridge/surface/protocol.test.ts` ("a list drawn after S1's first read") · fixtures
`omp--v18-6-1-path-like-loop-list--w120.txt`, `omp--v18-12-6-path-like-no-list--w120.txt`,
`omp--v18-12-6-slash-mo-fuzzy--w120.txt`, `omp--v18-6-1-path-popup--w120.txt`.
