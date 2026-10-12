# 0100: an ask travels as data and is answered by id

- **Status:** Proposed
- **Date:** 2026-10-12
- **Shipped in:** pending
- **Trail:** a durable agent program (Pi Durable) whose tool calls wait for a person ·
  `web/src/lib/harness/prompt-model.ts` (`PromptModel`, `promptsEqual`) · `bridge/prompt-binding.ts` ·
  `bridge/types.ts` (`PaneWire`) · `bridge/server.ts` (the `prompt_changed` refusal) ·
  `bridge/launch-receipts.ts` · `bridge/worktree-receipts.ts` (`ReceiptFileStore`) ·
  `bridge/crew/forward.ts` (`FORWARDABLE`) · `bridge/crew/enrollment.ts`
  (`CREW_PROTOCOL_VERSION`) · `web/src/lib/api.ts` (`fetchChat`, the `stale` outcome) ·
  [ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md) ·
  [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md) ·
  [ADR 0091](./0091-launch-by-id-with-a-request-id.md) ·
  [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md) ·
  [ADR 0101](./0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) ·
  [ADR 0102](./0102-starters-are-launcher-rows.md)

## Context

When an agent in a terminal asks a person something, Collie reads it off the screen. The reader
builds a `PromptModel`. It has no id. Its identity is the text of the dialog, and the bridge binds
an answer by re-reading the same region and comparing text (`prompt_changed`, 409). That works
because the screen is all there is.

A durable program does not paint a dialog. It holds the question as data: a tool call, its input,
the options, and an id. If Collie turned that data into screen text, then read it back, it would
lose the id and gain a parser that can be wrong. If the phone answered with keys, there would be no
keys to send, because the pane has no screen.

Three more facts shape the answer.

- The screen routes `reply` and `keys` carry no request id. A lost response and a second tap can
  send two answers. For a tool call that runs a command, a second answer is not harmless. Launch
  solved this with a request id and a receipt (ADR 0091).
- A program restarts. After a restart it may ask the same question again, for the same tool call,
  under a new ask id.
- A phone push that says "needs you" is noisy if one tool call can raise it again and again.

## Decision

**An ask is part of the pane's data, and it is answered by its id. The screen reader is not
involved.**

1. **The pane carries the asks.** `PaneWire` gains `asks?: Ask[]`. It is additive and optional. Each
   ask has an ask id, a revision and the tool call id, plus what the card shows: the cleaned
   input and the options. Only a `durable` pane produces it. The screen reader is untouched, so every ask has one
   owner by construction.
2. **A person answers with `POST /api/pane/:id/answer`.** The body names the ask id, the revision
   the phone saw, the chosen option, and a request id minted on the phone. A body without them is refused. A revision that is no longer current is refused with 409, as `prompt_changed`
   is.
3. **A receipt comes first.** The bridge writes the receipt for the request id before the answer
   leaves for the program. A repeat with the same request id returns the stored outcome and sends
   nothing. It uses the store of ADR 0091. If the write of the receipt fails, nothing is sent.
4. **Only a person's tap answers.** The route runs for a paired device acting on a tap. A program,
   a hook or a model output cannot answer its own ask. This is ADR 0024 applied to a channel that
   is structured: data from the emitter is a hint to show, and it is never a command.
5. **The push guard lives in the bridge, on disk.** It is keyed on `(host, toolCallId)` and kept in
   the state dir, so a bridge restart pushes nothing twice. The caps are 3 pushes per pane per
   minute, 10 per host, and 5 open asks shown at once. An ask over a cap is still listed on the
   pane. It only skips the push.
6. **A restart re-ask is shown, not pushed.** The same tool call id arrives under a new ask id. The
   phone shows the new ask. The guard sees the key it already pushed and stays quiet. The old ask
   id answers `too-late`.
7. **The crew carries it with no version bump.** `CREW_PROTOCOL_VERSION` stays 2. `/answer` joins
   `FORWARDABLE`, so a lead forwards it to the member that owns the pane. An old lead drops `asks`
   and shows the pane as `waiting`. An old peer answers 404 to `/answer`, and the phone maps that
   to `stale`, as it does for Chat, with a line that says the machine needs an update.

## Consequences

- An ask on a durable pane has an id, so there is nothing to bind by text and nothing to walk
  with keys. ADR 0055 and ADR 0080 stay the rule for every pane that has a screen.
- Two taps, or a retry after a lost reply, answer once. The phone does not re-send on its own. It
  offers "Try again" with the same request id, as in ADR 0091.
- The state dir gains the guard file and uses the receipt store. Both are written only when a
  durable pane exists.
- A hostile program can send many asks. The caps bound the noise, and the string cleaning of
  ADR 0099 bounds what each one can show. They do not make a bad ask safe to accept. A person still
  reads the card.
- The phone shows `waiting` on an old lead, with no card. The person has to open the program to
  answer. That is the cost of not bumping the protocol, and it is a short skew while a crew levels.
- A second producer of asks, for example a screen reader that also emits ids, would need a new
  decision about which owner wins. This one avoids the question by having exactly one.
