# 0122: a queued message is a card until the journal shows it

- **Status:** Accepted
- **Date:** 2026-10-25
- **Shipped in:** 1.24.1
- **Trail:** the OMP input gang, tester 03 (`~/.cache/collie-lab/omp-gang/03-running-turn/REPORT.md`, cases 0
  and 6a on OMP 18.6.1) · counsel on 2026-10-25 (two advisors, "proceed with adjustments"; the
  adjustments are folded in below) · `bridge/surface/queued.ts` · `bridge/journal/receipt-queue.ts` ·
  `bridge/surface/protocol.ts` · `bridge/surface/stop.ts` · `bridge/journal/live.ts` ·
  `web/src/components/session-stream.tsx` · `web/e2e/rig/queued.spec.ts` · fixtures
  `omp--v18-6-1-queued-before-stop--w119.txt` and `omp--v18-6-1-stop-returned--w119.txt` ·
  [ADR 0116](./0116-a-stop-is-a-persons-tap-with-a-receipt.md) ·
  [ADR 0117](./0117-a-steer-is-the-persons-choice-never-the-default.md)

## Context

A send into a running turn uses the profile's queue key. On OMP that is Ctrl+Q, and OMP lists the text
under `After yield · 1` until the turn ends. The receipt settles `sent` with `queued: true`.

Two things then went wrong (tester 03, case 0, OMP 18.6.1):

1. **The Chat never drew the message.** The Chat's queued cards come from the journal reducer. Claude
   Code and Muse write their queue into the session log, so their reducers answer a queue. pi, OMP and
   the other harnesses write nothing about the wait until the turn yields, so their reducers answer none.
   The phone showed no trace of a message the agent was holding.
2. **Stop lost it.** Stop presses Escape (ADR 0116). OMP ends the turn and moves the queued text back
   into its input box. It never becomes a prompt. The receipt still said `sent` + `queued`, the Chat had
   nothing to show, and the next plain send was refused `draft_present` for a draft nobody could see on
   the phone.

Collie's own receipts know about every queued send. The fix uses them, without a harness name in shared
code.

## Decision

1. **A queued send is a card until the journal shows it as a prompt.** The Send Protocol keeps each send
   that settled `sent` + `queued` in memory, with its text (`QueuedSends`). The live Chat window gets the
   pane's cards. A card drops when the journal holds a user prompt, written no earlier than the send's
   submit key less 2 s (`PROMPT_SKEW_MS`), whose text equals the card's text with white space folded.
   One prompt clears one card, oldest send first, the rule the Claude reducer uses for its own queue. A
   prompt edge that confirms the receipt (`effective`) also drops it.
2. **Three states, and no card vanishes without an exit.**

   | State | Means | Card | Ends |
   | --- | --- | --- | --- |
   | `queued` | The harness holds the text. | "Waiting to send", a line that it waits for the turn, and a line that Stop is the way to take it back. No button. | The journal shows the prompt; a read shows it back in the box (`returned`); Collie can no longer tell (`unconfirmed`). |
   | `returned` | A read of the box showed exactly this text. | "Back in the box", Send and Discard. | A later read shows the box without it; its Send or Discard; the journal shows the prompt. |
   | `unconfirmed` | Collie cannot tell where the message went. | "Collie cannot tell where this message went. Check the agent." Discard only. | Its Discard (drops the card, presses nothing); the journal shows the prompt after all; one more bound. |

   A queued card turns `unconfirmed` when the pane reads idle with an empty box on two polls in a row
   (`IDLE_EMPTY_POLLS`): the text left the queue and did not come back to the box, and no prompt matched
   it, or the window would not draw the card at all. A Stop's own read-backs do not count toward the
   two: they come 0.4 s apart, before a harness may have put the text back. Any card whose text a read
   finds in the box turns `returned`, an unconfirmed one too.
3. **The clock and the cap are data, and neither drops a card.** `QUEUED_SEND_MS` is 30 minutes, the
   hold queue's precedent. A queued card counts it from the last read that saw the pane's turn running,
   not from the submit key, so a long turn keeps its card. A returned card counts it from the last read
   that saw it in the box. Past the bound either turns `unconfirmed`, and an unconfirmed card ends one
   more bound later. Past `QUEUED_SENDS_MAX` (64) open cards, the oldest turn `unconfirmed`; past twice
   that, the oldest unconfirmed ones go, because memory has an end.
4. **The journal stays the source where it records the queue, and nothing is drawn twice.**
   `JournalAdapter.recordsQueue` is set on the Claude Code and Muse adapters. For them the receipts add
   only returned cards. That flag is an optimisation. The guard is the text: a receipt card whose folded
   text equals a text the journal lists as queued is never drawn, whatever the flag says, so the rule
   holds if an adapter starts recording its queue. No harness name is read.
5. **The wire.** A new `ChatWindowBody.queuedSends` lists each card as `{ requestId, state, text }`,
   masked with the rest of the body, absent when empty, so other bodies stay byte for byte as before.
   The receipt cards ride only there. They never join the legacy `queued` list: a phone one release
   behind draws that list with a Send now button, which cannot work for a harness that names no such
   key. An old phone shows no receipt card; a new phone shows them all.
6. **A returned run is one card.** A harness may give several queued texts back into one box. The
   texts that together are exactly the box, in order, are one card, with the joined text, one Send and
   one Discard. Its first request id is the card's; every receipt in the run takes the late mark.
   - **A steer is a candidate too** (tester 14, OMP 18.12.6, 2026-10-25). With a steer and a queued
     send both pending, Stop makes OMP give back both: the steer text, a blank row, the queued text
     (`restoreQueuedMessagesToEditor` joins the steering messages, then the follow-ups, with a blank
     row). A send whose receipt settled `steered` is kept for the turn it was sent in, with no card of
     its own, and the run is matched in order over the candidates, steers first (in send order), then
     the queued sends (in send order), whichever was sent first. A matched steer row takes the same
     `late: "returned"` and joins the same one card; it needs no new state. A steer nobody saw in the
     box is dropped without a card after two polls that read the turn idle, or at the queued bound: it
     landed (the journal shows its prompt) or the turn ended without it, and it can never match a
     draft typed later. A steer is not read back from the request files after a restart.
7. **After a Stop, the box is read.** Two reads feed one rule: the Stop's own read-backs after its key
   (0.4 s, 1.4 s and 2.4 s), and the poll's Surface read of each agent pane. A read changes nothing when
   it is older than the send's settle, or while another send holds the pane's lock, because during S1
   the box holds that send's own text. A read that found no box (a dialog over it) says nothing about
   the box.
8. **The receipt gets a late mark.** A returned send writes `late: "returned"` onto its stored receipt,
   once. `outcome` stays `sent` and `queued` stays true: both were true when the receipt settled. The
   store takes only two changes after settle, `markEffective` and `markReturned`, each once.
9. **The Stop answer names only what a read-back saw.** The Stop receipt gains `returned?: string[]`,
   the request ids a read-back saw back in the box. The phone's sentence then says, for example,
   "Stopped. 1 queued message is back in the agent as a draft." When no read-back saw one, the Stop
   says nothing about queued messages: the poll's later read turns the card returned, and the sentence
   and the card must never contradict each other.
10. **Send and Discard read the box again, under the pane lock, right before the key.** Both go
    through `POST /api/send` with `resendOf` set to the returned card and the bridge's own unmasked text,
    never the phone's copy. The run's S0 is that fresh read.
    - **Send** (`submit`) goes only when the read shows an idle turn and the box holds exactly the text.
      Then the profile's submit key goes in alone: no retype, so the text lands once. A box that no longer
      holds the text (a submit at the desk, an edit) refuses with the normal reason, `not_free`, and
      presses nothing; a running turn refuses the same way. A stale card never sends twice.
    - **Discard** clears the box with the profile's clear key (the existing clear step) only when the
      read shows exactly that text. When the box changed, nothing is pressed, only the card goes, and the
      answer says so.
    - The submit with no rows hash is the older typed-box rule (M56): any submit whose framed box holds
      exactly the text goes without one. The returned card adds no new road; its idle check is the only
      rule that is its own, set by the route for `resendOf` of a returned card and never read off a body.
    - A plain `resendOf` of a returned card is a 404: it is no held row.
    - **A returned row is a reading, not a proof.** A pane can keep a stale bottom frame: the editor row
      at the screen's foot still shows a text while the live editor is empty and drawn higher up (a
      resize that never reached a background pane, Altan's OMP 18.6.1 pane, 2026-10-25). So a returned
      card can be stale until a request probes the box. Its Send and Discard take the protocol's normal
      submit and clear roads, never a road of their own: each ends on a read that must see the box
      change, so a frame that never changes ends `unknown(no_evidence)`, never `sent` or `discarded`
      (`protocol.test.ts`, "a returned row is a reading"). A probe before a clear, when one lands, is
      the clear road's and covers Discard too. 2026-10-25, landed: Send and Discard on a card probe the
      box first, as every request that acts on a draft does ([ADR 0048](./0048-the-input-box-is-found-by-its-own-frame.md),
      the 2026-10-25 addendum). On a frame that never changes they now end `refused(probe_failed)` with
      the cause `stale_screen` before any other key, not `unknown(no_evidence)`.
11. **The `draft_present` refusal points at the card.** When a send is refused because the box holds a
    draft and the pane has a returned card, the phone says "Your queued message is back in the agent as
    a draft. Use its card."
12. **Stop is the only way to take a queued message back.** A queued card has no Cancel: Collie can
    only take a message out of the harness's queue with the harness's own dequeue key. OMP has one
    (`app.message.dequeue`, Alt+Up or Shift+Up), but it pops the newest message into the box, and Collie
    does not press it yet. Until a profile names a dequeue key and a test proves it, the card says, in
    one short line, that stopping the turn is how to take it back.

## What the queued path's S2 needs (addendum, 2026-10-26)

A send on the queued path (S0 read the turn running on a harness whose Enter queues, or the rows above
moved while Collie typed) needs **no positive evidence** of a queued message. After the key, S2 passes
when the found box reads empty. It fails, `unknown(dialog_after_enter)`, when the Surface claims any
modal other than `none` while the box is found (`unreadable` from a strong cue and `unknown` from a weak
one count alike), or when two reads in a row find no box. The profile's queued row (`keys.queuedRow`) is
a witness only for a send that S0 read idle: it sets `queued` there, and it never decides a send that S0
read running. So the queued path rests on one thing: the harness's queue drawing must not read as a
modal over the box.

On Claude Code that drawing is in the prompt echo's shape, so the echo rule (cues.ts
`withoutPromptEchoes`, `idle.promptEchoes`) carries it. Measured on 2.1.310 (2026-10-26, fixtures README,
"Several queued messages"): each queued message is its own block with a blank row before the next, and
only the last carries `ctrl+enter to send now`. A run over the box counts as a list only when its first
row is an option row (`❯ 1. Yes`); a text's own numbered or checkbox lines under its first line do not
count, so "Please do these:" over "1. …" and "2. …" settles `sent` + `queued`. Two limits stay:

- **A text whose first line is a numbered item** (`1. do x` over `2. do y`) draws a dialog's pointer row
  and still ends `unknown(dialog_after_enter)`. The text went in once and is never sent twice; only the
  receipt says less than it could.
- **The rule trusts that Claude Code never draws a pointer list over a live box.** Every Claude dialog in
  the corpus (208 captures, and the 2.1.310 `/resume` and rewind lists) replaces the box, so the echo rule,
  which reads only rows over a found box, never sees one. A Claude version that draws an unnumbered picker
  over its box (`❯ Title` over an indented metadata row) would read as an echo; the corpus test "no Claude
  dialog fixture reads otherwise without the echo rule" is the guard for each new capture.

## Assumptions

- **One clock.** The journal's prompt time and the receipt's submit time are compared with a 2 s skew.
  Both clocks are the same machine's: the bridge and the harness run on the same host. On a crew, a
  member's pane is read by the member's own bridge, so the member's journal and the member's receipts
  are compared, never the lead's clock against a member's journal.
- **The box read is the profile's.** The box text is the frame's interior under the profile, with
  suggestion text cut by the profile's colours. The captures behind this ADR are plain text, so that cut
  is proven by the existing corpus, not by these screens.

## Limits

- **Text match only.** A card drops on a prompt with equal text. A person who types the same text at
  the desk, while the queued copy waits, clears the card early, and a draft of the same words reads as
  returned. A harness that rewrites the prompt before it logs it keeps the card until it turns
  unconfirmed.
- **A multi-line send gets no card.** OMP takes a multi-line send in a running turn as a steer, and the
  receipt carries no `queued` flag (tester 03, case 10).
- **Memory first.** The texts live in memory. After a restart the open sends inside the bound come back
  from their request files, text from the one line the Sent rule keeps. A send with no kept line
  (several lines, a secret shape, too long) is not drawn again, and a card already returned is not drawn
  again.
- **Proven live in part.** On 2026-10-25 Altan's own OMP 18.6.1 pane confirmed the one-queued case: a
  send during a running turn (receipt `sent` + `queued`, Ctrl+Q), then Stop 18 s later, put the exact
  text back into OMP's editor, one line, no prefix. Still not proven live: OMP's box after a Stop with
  two queued texts (the one-card run), the journal's prompt text for a queued message, and the timing
  of the give-back against the 0.4 s read-back. Those are read from tester 03's captures and the fake
  panes. The browser leg's OMP case (case 29, `web/e2e/rig/queued.spec.ts`) closes part of the gap on
  its next run.

## Alternatives

- **Read the harness's own queue block as data (the long-term road).** OMP draws its queue on screen
  (`After yield · N`, one numbered row per text, `└ Alt+↑ to edit`), and pi and Codex draw theirs. A
  profile-defined queue region would read those rows the way the box is read, and the cards would show
  what the harness itself holds, including a message typed at the desk. That needs a region per profile
  and a corpus per version. The receipt cards are the bridge until then: they know only what Collie
  sent, and they say when they can no longer tell.
- **Drop a card at the bound.** Rejected by counsel: a card that disappears without a reason is a
  screen that lies by omission. The `unconfirmed` state says what Collie knows.

## Consequences

- A Stop on OMP with a queued message now leaves a card that says where the text is, and two buttons
  that act on it after a fresh read. The next send's `draft_present` refusal points to that card.
- pi, Codex and OpenCode get receipt-queued cards too. Their reducers answered no queue; now the phone
  draws what Collie queued, and says so when it can no longer tell.
- The Claude Code and Muse Chat is unchanged for queued cards. They gain a returned card only if their
  box ever holds a queued text after a Stop.
- A phone one release behind sees no receipt card, as before this decision.
