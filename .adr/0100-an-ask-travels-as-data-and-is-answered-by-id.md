# 0100: an ask travels as data and is answered by id

- **Status:** Accepted
- **Date:** 2026-10-12
- **Shipped in:** pending (1.21.0)
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
5. **The push guard lives in the bridge, on disk, and caps pushes, never what is shown.** It is
   keyed on `(host, toolCallId)` and kept in the state dir, so a bridge restart pushes nothing
   twice. The caps are 3 pushes per pane per minute, 10 per host per minute, and 30 per host per
   hour. The hourly cap is a breaker: the push past it becomes one summary, "A program on <host> is
   raising many asks", and the host stays silent until the hour is over. Every open ask, up to the
   program's 50 per pane, is listed on the pane; the phone shows five and opens the rest on a tap.
   A key is forgotten an hour after it was last seen open, and the file keeps at most 2000 keys.
   The push for an ask says "Permission needed in <pane>", where <pane> is the pane's push name,
   never the ask's title, its reason or a command line, unless the program chose the words of its own
   push (an ask's `push`, 60 and 120 characters, cleaned again by the bridge, the pane's name still in
   front); that changes what a push says and never whether it is sent. The guard runs where the push is sent: a
   solo collie for its own panes, the lead for a peer's panes (CREW_PROTOCOL.md §5).
6. **A restart re-ask is shown, not pushed.** The same tool call id arrives again after a restart.
   The phone shows the ask. The guard sees the key it already pushed and stays quiet. With a random
   ask id the old id answers `too-late`; with a derived one (below) it is the same ask, and the
   answer lands.
7. **The crew carries it with no version bump.** `CREW_PROTOCOL_VERSION` stays 2. `/answer` joins
   `FORWARDABLE`, so a lead forwards it to the member that owns the pane. An old lead passes `asks`
   through unchanged, because the merge spreads the whole pane; it draws nothing from the field and
   shows the pane as waiting. An old peer answers 404 to `/answer`, and the phone maps that
   to `stale`, as it does for Chat, with a line that says the machine needs an update.

**A program SHOULD derive the ask id from the tool call it stands for (amended 2026-10-13, M50
spec 14).** The example SDK takes SHA-256 over the pane id, a newline and the tool call id, and keeps
the first 32 hex characters. A program that raises the same tool call again after a restart then
raises the same ask id, with revision 1, and it raises every waiting ask before it says `ready`. An
answer the phone sent across the restart names an id that is open again, so it is `taken` and the
tool runs once, where a random id made it `too-late` with nothing run. A changed title or set of
options still raises the revision. The guard of point 5 already keys on `(host, toolCallId)`, so
it needs no change. WIRE.md section 6 states the rule; a random id stays allowed.

## Consequences

- An ask on a durable pane has an id, so there is nothing to bind by text and nothing to walk
  with keys. ADR 0055 and ADR 0080 stay the rule for every pane that has a screen.
- Two taps, or a retry after a lost reply, answer once. The phone does not re-send on its own. It
  offers "Try again" with the same request id, as in ADR 0091.
- The state dir gains the guard file and uses the receipt store. Both are written only when a
  durable pane exists.
- A hostile program can send many asks. The caps bound the noise, and the string cleaning of
  ADR 0099 bounds what each one can show. They do not make a bad ask safe to accept. A person still
  reads the card. The card's buttons take their words and weight from the option's `effect`, in
  Collie's own words, with the program's label as small text under them, and `allow-always` needs
  a second tap that names the tool.
- The socket does not stop a process of the same user, and a tool the agent runs is such a
  process: it can open the socket and answer an ask, so a durable program SHOULD refuse callers
  that are its own descendants or run its tools in a sandbox (WIRE.md, "What the socket does not
  protect against"). Collie cannot make that check for it, and `allow-always` is the grant that
  needs the most care.
- A retry whose outcome Collie cannot know (the first try left with no reply, and the retry finds
  the ask closed) reads "may have gone through" (`maybe-applied`), never "too late". A receipt is
  bound to a digest of its payload, so one request id can never carry two different answers.
- The phone shows `waiting` on an old lead, with no card. The person has to open the program to
  answer. That is the cost of not bumping the protocol, and it is a short skew while a crew levels.
- A second producer of asks, for example a screen reader that also emits ids, would need a new
  decision about which owner wins. This one avoids the question by having exactly one.
