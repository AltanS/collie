# 0101: a control on a screenless pane names the turn it saw

- **Status:** Accepted
- **Date:** 2026-10-12
- **Shipped in:** pending (1.21.0)
- **Trail:** a durable agent program (Pi Durable) where a steer can land on the wrong turn ·
  `bridge/server.ts` (the `reply` and `keys` routes, the `prompt_changed` refusal) ·
  `bridge/prompt-binding.ts` · `bridge/launch-receipts.ts` · `bridge/worktree-receipts.ts`
  (`ReceiptFileStore`) · `bridge/crew/forward.ts` (`FORWARDABLE`) ·
  `web/src/lib/chat-gate.ts` · [ADR 0091](./0091-launch-by-id-with-a-request-id.md) ·
  [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md) ·
  [ADR 0100](./0100-an-ask-travels-as-data-and-is-answered-by-id.md) ·
  [ADR 0102](./0102-starters-are-launcher-rows.md)

## Context

On a pane with a screen, a reply is typed into the pane and Collie reads the screen back before it
presses Enter. The read-back is the guard. If the agent moved on, the screen is different and the
send is refused.

A pane with no screen has no read-back. A person writes "steer left" while the agent finishes a
turn. The program starts a new turn. The text lands on that new turn, which the person never saw.
An abort has the same fault, and it is worse: it stops work the person did not mean to stop. A
retry after a lost reply can also send the same text twice.

The phone does know what it showed. Chat has the newest turn id, and an open ask has an ask id.
The program knows what is current. Compare the two, and the stale case is visible.

## Decision

**A send or an abort on a screenless pane names the turn or the ask the phone saw, and carries a
request id. A stale name is refused.**

1. **The pane wire carries the newest turn id,** and each open ask carries its id (ADR 0100). The
   phone puts what it last saw into the control.
2. **Send** carries the turn id the phone saw, or an ask id when it answers inside an ask, and a
   request id. **Abort** carries the same. Free text with neither is refused. The bridge does
   not guess a turn.
3. **A stale name gets 409.** If the newest turn is not the one named, or the ask is no longer
   open, the bridge refuses before anything reaches the program. The phone reloads the pane and
   shows what changed. The words the person typed stay in the composer.
4. **The request id works as in ADR 0091.** The phone mints it per intent. The bridge writes a
   receipt first, then passes the request id to the program on the socket. The program may use it
   to drop a repeat. A repeat on the bridge returns the stored outcome and sends nothing.
5. **The check runs in the bridge,** before the socket write, as one function used by both
   controls. The program is not trusted to make it, because a program written by someone else may
   not.
6. **Both routes are forwarded** by the crew like the other pane routes, and an old peer's 404
   maps to `stale` on the phone (ADR 0100).
7. **Raw keys do not exist here.** `sendKeys` and `typeText` are false for this adapter
   (ADR 0099), so the key routes refuse with `unsupported`. The only text path is the guarded send.

## Consequences

- A steer cannot land on a turn the person did not see. The cost is a 409 when the agent moves
  quickly, and one more tap after the reload.
- An abort cannot stop a newer turn. A person who wants to stop whatever is running can reload and
  abort again.
- Panes with a screen keep their read-back. Nothing about them changes.
- The phone has to carry the turn id from the data it showed to the control. A composer that sends
  a stale id by a bug shows as a stream of 409 responses, and that is visible in the first test.
- The turn id is only as good as the program's own idea of a turn. A program with no stable turn
  boundary cannot be guarded this way, and would need a different rule.
- Retry safety rests on two layers: the bridge receipt, and the program's use of the request id. If
  the program ignores it, the bridge still prevents a repeat from the same phone intent.
