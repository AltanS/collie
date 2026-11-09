# 0130: Pinned messages are a copy, keyed on the session, kept by the bridge that owns the pane

- **Status:** Accepted
- **Date:** 2026-11-06
- **Shipped in:** pending
- **Relates to:** [ADR 0070](./0070-a-pin-is-a-place-the-operator-chose.md) (pinned panes are a device's
  places; pinned messages are a different thing and share no store),
  [ADR 0073](./0073-a-live-session-is-a-bounded-window-on-the-existing-poll.md) (the live window a pin
  must outlive), [ADR 0082](./0082-chat-is-the-default-view-of-an-agent-pane.md) (Chat is the view that
  draws a pinnable block), [ADR 0128](./0128-background-jobs-are-journal-facts.md) (the belt marks the
  Pins mark stands beside).
- **Trail:** Altan's request of 2026-11-06 (milestone M90) · `bridge/pins/store.ts` ·
  `bridge/pins/routes.ts` · `bridge/pins/lookup.ts` · `bridge/pins/key.ts` ·
  `web/src/components/stream-block.tsx` · `web/src/components/block-actions-sheet.tsx` ·
  `web/src/components/pins-sheet.tsx` · `web/src/hooks/use-message-pins.ts` ·
  `docs/configure.md` → "Chat view"

## Context

Altan asked to pin a message in a session so that it is extracted and he can view it elsewhere: an icon
in the belt where the active agents show, a full sheet of the pins with an easy unpin, and a detail view
for a long one.

Three facts shape the answer. Chat draws a bounded window of the session's log (ADR 0073), so an old
block leaves the phone as the log grows or is paged. A pane id is reused once a pane closes, while the
conversation lives on in the harness. And a crew has one bridge for each machine, and the machine that
owns a pane is the only one that reads its log.

"Extracted" can mean a pointer to the block or a copy of its text. The pointer is the cheaper build and
the weaker promise.

## Decision

**A pin is a copy of one Chat block, keyed on the session, written and read by the bridge that owns the
pane.**

The numbers follow the milestone's README. Its decision 7 is a rule about when the UI ships, not a design choice.

1. **A copy, not a pointer.** The bridge stores the block's text, and for a tool card its name, its
   input summary and its result text as Chat shows them, in `<stateDir>/pins/<sessionKey>.json` (folder
   0700, file 0600). A pin outlives the pane, a bridge restart and the journal window, and a reopened
   session shows its pins again.
2. **The bridge copies from its own journal.** The phone names the block by its Chat item id. The bridge
   finds the block in the entries the pane's Chat reads (`findPinnable`) and stores its own copy. A
   block it cannot find is refused (404 `pin.item_not_found`). The phone's text is never stored.
3. **The key is the session, not the pane.** `pinSessionKey` is the agent and the session ref, hashed
   where the ref is not file-safe. The store is per session, so a view across sessions (Dashboard,
   Home) can come later without a migration. M90 reaches pins from the pane's belt only.
4. **The words.** Pin, Pins, Unpin, Pinned. New keys live under `pins.*`, never under `chat.pin.*` (the
   prompt pin) or `paneActions.pin.*` (Pin to top, ADR 0070). The two meet on no screen.
5. **What is pinnable.** A message, a reply, a thinking block, a notice and a tool card. Not an image
   (409 `pin.not_pinnable`), not the compaction marker, and not an entry the program is still writing
   (409 `pin.not_settled`), because a pin is a copy and the block would change under it.
6. **Caps.** 100 pins a session. The 101st is refused (409 `pin.cap`) and the oldest is never dropped in
   silence. A pinned text is capped as Chat caps a text part, and a tool result as Chat caps it.
8. **A visible way in.** A long press on text fights native selection on iOS and Android, so a pinnable
   block wears a small muted `⋯` button, "Message actions", that opens the block actions sheet. The hold
   and the right click open the same sheet as a second way, and the hold never takes selection away.
9. **The list carries excerpts, the detail fetches the text.** `GET pins` returns each pin with its first
   400 characters and the text length. `GET pins?pin=<id>` returns one pin whole. A hundred pins of
   20,000 characters would otherwise be 2 MB a list.
10. **One pin for each block, one writer.** Pinning a pinned block returns the existing pin (200).
    Unpin is idempotent (204). Every write is synchronous in the one process that owns the file, so
    there is no lost update and no lock. A lead never writes a member's file; it forwards the request to
    the member that owns the pane, as for every pane route.
11. **Old bridges and distinct codes.** Refusals carry the same `pin.*` word in `error` and `code`, so the
    phone tells them from the plain 404 of an older member that lacks the route. The phone hides Pin and
    the Pins mark for a host older than 1.28.0 (the crew snapshot carries the version) and reads a 404
    with no `pin.*` code as "that machine's Collie is older".
12. **Lifecycle and privacy.** A file goes with its last pin, and a boot sweep removes a file nobody wrote
    for 180 days. **A pin keeps a copy of what Chat showed, tool results included. The copy outlives the
    journal and every paired device can read it.** The mask (`COLLIE_REDACT`) applies to what leaves the
    bridge, as for Chat, and the file keeps the copy. Each pin keeps an 80-character anchor of its text,
    so Show in Chat finds a block whose id changed. Pin and unpin write an audit line.
13. **The UI.** The Pins mark is a pinned mark beside Agents and Jobs, with the count, hidden at zero.
    A tap opens a tall sheet, newest first, an Unpin on each row. A tap on a row opens a detail layer
    with the whole text, Unpin and Show in Chat. A wide screen queues the tap like the other marks.

## Alternatives considered

- **A pointer into the journal** (store the item id, read the block again). Cheapest, and no copy of
  secrets rests on disk. Rejected: it fails exactly where the request lives. The block leaves the
  window, the harness compacts or rewrites its log, an id changes, and the pin becomes a dead row. A
  pin that cannot show its text is not "extracted".
- **A device-local store, like pinned panes (ADR 0070).** A pinned pane is a place one device chose, so
  the device may keep it. A pinned message is conversation content that must read the same from every
  paired device, and on a crew the pane lives on another machine. A local store would show different
  pins on each phone and lose them with the browser's storage.
- **The phone's text.** The phone already holds the rendered block, so it could send it. Rejected: the
  bridge would store whatever a paired device sends, the text would not match the log, and the mask and
  the caps would not apply to it. The bridge copies from its own log, so a pin is a fact of the session.

## Consequences

- **A secret can rest on disk.** A tool result that printed one is kept until it is unpinned, outside the
  journal's own life. The docs say so. The file is 0600, the mask covers what leaves, and Unpin deletes
  the copy.
- **A pin cannot be made when the log cannot be read.** The route answers `pin.item_not_found`.
- **A reply is pinnable when it settles.** The ⋯ is there, and the bridge refuses `pin.not_settled`
  until then.
- **The count on the wire is a number.** Each pane row carries `pins` while its session has any. A lead
  keeps a member's count only as a whole number above zero.
- **Pins are per machine.** Moving a session to another machine does not move its pins.
- **Two bridges on one state folder do not serialize pin writes.** The one writer is one process; a second bridge sharing the folder (a release and a dev lane) can overwrite a file the first just wrote, and the last writer wins. A known limit.
- **Not built.** A view of the pins across sessions, a search in them, a pin of an image, an edit of a
  pinned text.

## Amendment 2026-11-06: the ⋯ shows on a tap

Status is unchanged: **Accepted**. Point 8 above described the first cut, and it shipped in 1.28.0 that way:
every pinnable block wore a muted `⋯` all the time. On the phone that read as a column of dots down the thread,
and the float that kept text clear of it wrapped every first line. Altan asked for a block that shows nothing at
rest.

- **At rest a block shows nothing.** A tap on the block, or the hold, shows its `⋯` as a small chip over the
  block's top right; neither gesture opens the sheet. The `⋯` opens it, as before.
- **The way in stays visible after one tap.** That is what point 8 was protecting: the hold alone was not a way
  in a person would find, and it fights selection. A tap is the gesture a person tries first, and it reveals
  rather than acts, so a tap that only meant to read costs nothing.
- **A right click on a desk still opens the sheet at once**, and a mouse over the block shows the `⋯` too.
- **On a touch screen a block takes no selection at rest, and the hold opens the sheet.** Point 8's "the hold
  never takes selection away" is reversed for touch. A phone's browser starts a selection at about 500 ms and
  cancels the pointer, so the 650 ms hold never fired on text; revealing from Android's `contextmenu` after
  that hung on its timing, and on Altan's Android phone the hold did nothing at all. So under `pointer: coarse`
  a pinnable block has `user-select: none` and no callout, the timer fires every time (iOS included), and the
  hold opens the sheet directly, as the first cut did. The tap still only reveals the `⋯`. A mouse and a desk
  keep selection as ever, and a right click over selected text keeps the native menu.
- **Select text is a row of the sheet.** It gives that one block's text back to the native selection and says
  how in a status line. While it is on, the block's own hold and tap stand down; it ends on a press outside the
  block, when the sheet opens again, or when the block leaves the stream. One block at a time. The row is in
  the sheet on a desk too: one sheet everywhere.
- **The tap that shows the `⋯` ends there.** The reading area's Tap to type no longer sees it, so it raises
  no keyboard.
- **The chip moves no box and covers no control.** It is an overlay, and it steps left of a copy button, a tool
  card's chevron or a status badge in its corner. It hides on a press elsewhere or after 4 s without a press, and stays through a scroll: the stream follows new output on its own while an agent works, and that is when a person wants to pin a reply.

`web/src/components/stream-block.tsx` holds the details.

