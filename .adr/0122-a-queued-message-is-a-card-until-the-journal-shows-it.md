# 0122: a queued message is a card until the journal shows it

- **Status:** Accepted
- **Date:** 2026-10-25
- **Shipped in:** unreleased (1.24.1 candidate)
- **Trail:** the OMP input gang, tester 03 (`~/.cache/collie-lab/omp-gang/03-running-turn/REPORT.md`, cases 0
  and 6a on OMP 18.6.1) · `bridge/surface/queued.ts` · `bridge/journal/receipt-queue.ts` ·
  `bridge/surface/protocol.ts` · `bridge/surface/stop.ts` · `bridge/journal/live.ts` ·
  `web/src/components/session-stream.tsx` · fixtures `omp--v18-6-1-queued-before-stop--w119.txt` and
  `omp--v18-6-1-stop-returned--w119.txt` · [ADR 0116](./0116-a-stop-is-a-persons-tap-with-a-receipt.md) ·
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
   that settled `sent` + `queued` in memory, with its text (`QueuedSends`). The live Chat window gets that
   list for its pane. A card drops when the journal holds a user prompt, written no earlier than the
   send's submit key less 2 s (`PROMPT_SKEW_MS`), whose text equals the send's text with white space
   folded. One prompt clears one card, oldest send first, the rule the Claude reducer uses for its own
   queue. A prompt edge that confirms the receipt (`effective`) also drops it.
2. **The bound is data.** A card counts as waiting for 30 minutes from its submit key
   (`QUEUED_SEND_MS`, the hold queue's precedent), and one protocol keeps at most 64 (`QUEUED_SENDS_MAX`).
   Past the bound the card goes, whatever the box or the journal says. A card that outlives the queue it
   stood for is the worse fault.
3. **The journal stays the source where it records the queue.** `JournalAdapter.recordsQueue` is set on
   the Claude Code and Muse adapters. For them the receipts add no queued card, so a message is never drawn
   twice. Every other adapter gets the queued cards from the receipts. The flag is the only switch; no
   harness name is read.
4. **The wire.** `ChatWindowBody.queued` (the plain texts) gains the receipt texts for an adapter without
   the flag, and `queuedFrom: "receipts"` says so. A new `queuedSends` lists each row as
   `{ requestId, state, text }`, with `state` `queued` or `returned`. Both fields are absent when empty,
   so other bodies stay byte for byte as before. The texts are masked with the rest of the body. An old
   phone reads `queued` and draws the cards it always drew.
5. **After a Stop, the box is read.** Two reads feed one rule: the Stop's own read-backs after its key
   (0.4 s, 1.4 s and 2.4 s), and the poll's Surface read of each agent pane. When the input box holds
   exactly the text of an open queued send, white space folded, that row is **returned**. Several queued
   texts given back together match as one in-order run. A box that holds anything else returns none.
   A read changes nothing when it found no box (a dialog over it), when it is older than the send's
   settle, or while another send holds the pane's lock, because during S1 the box holds that send's own
   text.
6. **The receipt gets a late mark.** A returned row writes `late: "returned"` onto its stored receipt,
   once. `outcome` stays `sent` and `queued` stays true: both were true when the receipt settled. The
   store takes only two changes after settle, `markEffective` and `markReturned`, each once.
7. **The Stop answer names what came back.** The Stop receipt gains `returned?: string[]`, the request
   ids a read-back saw in the box. It lists only what a read showed, never what may come back. The
   phone's Stop sentence gains a clause, for example "Stopped. 1 queued message is back in the box."
8. **The card has three states.** A queued card from the journal keeps its Send now button. A queued card
   from the receipts says it waits for the turn to end, with no button. A returned card says Stop put the
   message back in the agent's box, and offers **Send** and **Discard**. Send is a `submit` with
   `resendOf` set to the returned row; the bridge sends its own unmasked text, not the phone's copy, and
   the framed box that holds exactly that text lets the submit go without a rows hash. Discard is a
   `discard` the same way. A plain `resendOf` of a returned row is a 404: it is no held row. The row
   ends when a later read shows the box without the text, or when the journal shows the prompt.

## Limits

- **Text match only.** A card drops on a prompt with equal text. A person who types the same text at
  the desk, while the queued copy waits, clears the card early, and a draft of the same words reads as
  returned. A harness that rewrites the prompt before it logs it keeps the card until the bound.
- **No Cancel on a receipt-queued card.** Collie can only take a queued message back through the
  harness's own dequeue key. OMP has one (`app.message.dequeue`, Alt+Up or Shift+Up), but it pops the
  newest message into the box, and Collie does not press it yet. Until a profile names a dequeue key
  and a test proves it, the card offers no Cancel.
- **A multi-line send gets no card.** OMP takes a multi-line send in a running turn as a steer, and the
  receipt carries no `queued` flag (tester 03, case 10).
- **Memory first.** The texts live in memory. After a restart the open sends come back from their
  request files, text from the one line the Sent rule keeps. A send with no kept line (several lines, a
  secret shape, too long) is not drawn again, and a row already returned is not drawn again. Short is
  the safe side.
- **Ghost text.** The box read cuts suggestion text by the profile's colours. The captures behind this
  ADR are plain text, so that cut is proven by the existing corpus, not by these screens.
- **Not proven live.** No live OMP run backs this decision (no model turns were available on
  2026-10-25). OMP's box after a Stop with two queued texts, the journal's prompt text for a queued
  message, and the timing of the give-back against the 0.4 s read-back are read from tester 03's
  captures and the fake panes. A browser-leg run on OMP closes that gap.

## Consequences

- A Stop on OMP with a queued message now leaves a card that says where the text is, and two buttons
  that act on it. The next send's `draft_present` refusal has a visible cause.
- pi, Codex and OpenCode get receipt-queued cards too. Their reducers answered no queue; now the
  phone draws what Collie queued.
- The Claude Code and Muse Chat is unchanged for queued cards. They gain a returned card only if their
  box ever holds a queued text after a Stop.
