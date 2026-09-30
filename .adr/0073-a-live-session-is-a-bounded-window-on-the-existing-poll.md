# 0073 — A live session is a bounded window on the existing poll

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended:** 2026-10-01 (M41/12) — the live body gained `queued`. Additive, and the reasoning is a
  blockquote under point 4 rather than a new ADR, because it does not change a decision here; it
  answers a question this one did not ask.
- **Changes:** adds `GET /api/pane/:id/chat` and `bridge/journal/live.ts`. It closes off two options
  people will reasonably propose again: a WebSocket, and a `seq`-cursored delta.
  [ADR 0008](./0008-collie-does-not-run-a-terminal-emulator.md) is untouched — this reads the agent's
  own log, not a screen. [ADR 0031](./0031-freshness-is-a-declared-promise.md) is unchanged: this
  route declares nothing new about freshness, it rides the poll that is already declared.
- **Trail:** `bridge/journal/live.ts` · `bridge/journal/cursor.ts` · `bridge/journal/reduce.ts` ·
  `bridge/server.ts` (§ `paneChat`) · `bridge/crew/forward.ts` ·
  [CREW_PROTOCOL.md §5, §7.1, §9.1, §10.1](../CREW_PROTOCOL.md) ·
  `.tracker/M41-chat-reads-one-journal/08-the-live-window-and-the-cursor-route.md`

## Context

`GET /api/pane/:id/history` answers "show me this session". It reads a bounded tail of the log, parses
all of it, and caches the result until the file's size or mtime moves. That is the right shape for a
tap and the wrong shape for a screen that is watching: the sessions measured on 2026-09-29 were
186.8 MB, 89.8 MB and 64.9 MB, `files.ts` clamps a read to the last 32 MB, and one new turn therefore
costs a 32 MB read and a full re-parse of it. A Chat screen polling that route is doing that every
1.5 seconds.

Two facts constrain any answer.

**There is no live channel, and adding one is not a route.** `git grep` finds no `WebSocket` and no
`text/event-stream` anywhere in `bridge/`. A crew link aborts a read at 1200 ms
(`peer-client.ts` `DEFAULT_CREW_TIMEOUT_MS`), sized as a fraction of the lead's 1500 ms poll, so a
stream across a link is a new transport and a protocol decision. The PWA's poll already stops when the
tab is hidden and resumes on visibility; a stream would have to rebuild that as reconnect plus resume.

**A turn changes after it is emitted.** A tool result lands in a later row than its call and edits a
turn that went out long ago. Under a whole-file parse that is invisible, because the caller only sees
the finished array. Under a tail the caller is holding that turn on a screen.

## Decision

**A bounded live window per session, a cursor on the existing poll, and three positions that each do
one job.**

1. **The transport is the poll that already exists, answered 304 when nothing moved.** No WebSocket
   and no SSE. Both were declined for the two facts above, and the decline is cheap to reverse: SSE
   can be layered on this same cursor log later without changing what the cursor means.

2. **The window is bounded and the bound is the product.** At most `MAX_LIVE_BYTES` (2 MB) of composed
   turns and `MAX_LIVE_ENTRIES` (2000) of them, trimmed from the old end, with `MIN_LIVE_ENTRIES` (16)
   as a floor so one enormous turn cannot trim the window empty. A 186 MB session costs the same
   memory as a small one. Turns that fall off the front are not lost: they are the History read's job,
   reached through `?before=`, and `hasOlder` is how a client knows to offer it.

3. **`rev` is the cursor, not `seq`. The spec's own sketch was wrong here.** Three numbers, three
   jobs, and none of them can be merged into another:
   - `gen` — WHICH NUMBERING. It changes when the window rebuilt, which renumbers everything. A client
     holding another `gen` replaces what it holds; two numberings cannot be merged.
   - `rev` — WHEN. It moves once per tick that produced anything, and each entry carries the `rev` it
     was last touched at. `?after=<gen>:<rev>` asks for everything newer.
   - `seq` — WHERE. A turn's place, assigned once and never reassigned.

   A position watermark cannot answer "what is new", because the turn a tool result changed sits
   *below* the watermark and a `seq`-cursored answer would never mention it. One number cannot be both
   the place a turn sits and the moment it last moved.

4. **`upserts` is one list, and there is no replace verb.** A client holds turns by `uuid`; an entry it
   already has is written over in place and one it does not is inserted at its `seq`. The two cases are
   the same write, so a second list would have nothing to say. A `?before=` page carries `upserts`
   too, for that reason.

   > **Amended (2026-10-01, M41/12).** The live body also carries `queued`: what the operator typed
   > that the agent has not started on. It is a FIELD and not entries in `upserts`, and the absence of
   > a replace verb above is exactly why. A queued message appears and then is gone. Carried as turns
   > it could only be un-drawn by bumping `gen`, which throws away the client's whole thread and its
   > scroll position to retract one line. So the rule stands unchanged and the queue sits beside it:
   > `upserts` is the thread and it only grows, `queued` is state and arrives WHOLE on every answer.
   >
   > It needs no `rev` of its own, and that is point 6 paying off rather than a gap. A
   > `queue-operation` row adds no turn, so `rev` does not move for it, and a reader watching `rev`
   > alone would never be told. The ETag is hashed over the serialised body, so a queue that changed
   > is a different body and a queue that did not is the same one.
   >
   > One harness fills it. Claude Code records the queue in its log; the other five record none and
   > answer `[]`. A member one release behind sends no field at all, and a client reads that as
   > nothing waiting, which is point 7's rule applied to one field instead of the whole route.

5. **A tick happens because somebody asked.** There is no timer in `live.ts`. `stat` is the pre-check,
   so a quiet session costs one `stat`; `TICK_FLOOR_MS` (250 ms) makes several readers of one session
   share one read; a window nobody has asked about for `WINDOW_IDLE_MS` is dropped whole. That is the
   rule `use-polling.ts` already follows on the other side of the wire.

6. **The ETag is hashed over the serialised body, not composed from its fields.** A composed tag can
   drift from what was sent, and it cannot vary with the request — two clients at different revisions
   ask for different answers and would be handed the same validator. An unchanged poll re-serialises
   to the same bytes, so it is a 304 either way.

7. **The route is additive-optional over a crew link and bumps no protocol version**
   (CREW_PROTOCOL.md §7.1). It is a READ, so it is attempted against a stale member rather than refused
   (§10.3), and `if-none-match` is already forwarded, so the peer answers its own 304 and the lead
   re-emits it. **A peer that predates the route answers 404, and a 404 here means "update this
   member", never "this pane has nothing to show."** `available:false` is the answer for a pane with no
   session; the two must not be drawn alike.

8. **`JournalAdapter.reducer()` becomes required.** Spec 02 built the six reducers and deliberately
   left the seam out, because a seam with no caller is a guess. This window is the caller. One reducer
   per generation, built when its first row arrives, thrown away with the rows on a reset — a reducer
   remembers the tool calls it is waiting on, and after a reset those calls are in rows nobody holds.

9. **`ReadSince` gained `fromStart`**, for the same reason and under the same rule: only the source can
   say whether a reset read began at the source's own first row, because a bounded tail and a whole
   small session look identical from above. Without it `hasOlder` would be a guess, and a guess either
   offers turns that do not exist or hides turns that do.

## Consequences

- **A session that gained one turn costs one turn.** That is the whole point, and it is what makes a
  Chat screen affordable on a 1.5 s poll over a tailnet link.
- **Two readers of one session share one window**, keyed by the resolved log path or database key, for
  the reason `TranscriptStore` caches by path: the session is the thing and the pane is a way of
  looking at it.
- **A `?before=` page goes through the same `TranscriptStore` the History route uses**, so a "load
  older" tap after a History visit is a cache hit rather than a second 32 MB read. It also means the
  live path and the History path can never disagree about a turn's content.
- **`RowReducer` grew a second snapshot method, and both are required.** `unknowns()` answers what a
  reducer could not read; `queued()` answers what the operator is waiting on. Both are per-session
  rather than per-row for the same two reasons: the question has one answer per session, and
  `Reduction` is the hot path that hands back one frozen object from forty early returns. Required,
  not optional, because the fallback a caller would write for an absent method reads "nothing queued",
  and a wrong default is worse than a compile error in six files.
- **The queue reading is deliberately allowed to be SHORT, never long.** A tail read can begin between
  an enqueue and its dequeue, so the reducer can be told to take an item off a list that never had it.
  It then takes the wrong one, and the answer is missing a message. Every message it DOES report came
  off a row the reducer read. A queue short on screen says less than it could; a queue long on screen
  says something untrue.
- **hermes can lose a turn and no reducer can tell.** Its query filters on `active` and `compacted`,
  which are mutable per row, so a turn can DISAPPEAR between reads. `Reduction` has no `removed` and
  must not grow one: a reducer reads forward and cannot know a row vanished. The window's answer to
  that is the one verb it has, a `gen` bump on reset, and until a reset happens a compacted turn stays
  on screen. That is a known hole with a test rather than a paragraph.
- **opencode re-emits rather than folds.** Two reads of a streaming reply both arrive as `added` under
  the same `uuid`, because its cursor compares `>=` and it mutates a row in place. That is exactly why
  `upserts` must be merged by `uuid` and never appended.
- **A client's first paint is a screenful, not the window.** `DEFAULT_CHAT_LIMIT` is 40 and the
  ceiling is 200; past that a first paint is a History page and should ask for one. An INCREMENTAL
  answer is bounded by the window instead, never by `limit` — capping it would drop turns in the
  middle, and `?before=` walks backwards from what a client holds, which is the wrong end to fill a
  gap from.
- **`seq` numbering starts at `SEQ_BASE` (1,000,000), not at zero.** A thread grows at both ends, and
  a backward page numbers down. Starting in the middle of the space keeps the wire free of signs.
- **No client reads this route yet.** The first consumer is the prototype in
  `experiments/session-stream/` (M41/03). The 404 reading in point 7 is written into
  `PaneChatResponse`'s own doc comment and into CREW_PROTOCOL §5, which is where a client author will
  meet it.

## Revisit

- **When a stream is genuinely wanted.** Point 1 is a decline with a reason, not a principle. The
  cursor log this builds is the thing SSE would be layered on, and `gen`/`rev` would not change. What
  would have to be answered first is the crew link's 1200 ms abort.
- **If `MAX_LIVE_BYTES` turns out to be the wrong size.** It is one constant with a test at each
  bound, and the floor beside it is the part that is easy to get wrong.
- If a harness appears whose rows can be DELETED as an ordinary event rather than as a compaction.
  Then `Reduction` would need a `removed`, and the argument in the consequence above is the one to
  reopen.

## Addendum — 2026-09-30: a turn that leaves the branch is a turn that changed

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum answers the
last Revisit bullet without reopening the `removed` argument.

pi keeps every branch in ONE append-only log and each row names its parent, so a rewind is
**announced by the row that arrives**, not hidden in a flag that flips on disk. That is the
distinction the consequence above turns on: in hermes a row vanishes and no row says so, which is why
a forward reader genuinely cannot know. `Reduction` still has no `removed`, because in pi nothing is
removed.

A turn that left the current branch is marked `abandoned` in place on the `TranscriptEntry` and
reported through `changed`, exactly like a tool result folding onto an earlier call. The window sends
it as an upsert at the `seq` it already had, and a view hides it. **A rewind BACK onto a marked turn
clears the mark the same way**, which a remove verb could never have done, and which real sessions do:
8 of 44 measured on 2026-09-30 fork, and one of them returns to a branch it had left.

It is a flag rather than a filter because `?before=` pages come off the store and `pageEntries`
resolves the client's cursor by finding its uuid. A hidden turn's uuid must still resolve there, so
dropping it in `parse` would break paging and make the live path and the History path disagree about
one session. Both paths carry the flag; the views hide it.

The hermes hole is unchanged, and so is its answer: a reset. A flipped uuid the window has already
trimmed is dropped, the same bound a late tool result meets.

**One thing this audit also found in the window itself, and fixed:** a source may hand the same turn
back WHOLE as `added` rather than mutating it in place, which opencode does on every read of a
streaming reply and hermes does by re-composing. The window was taking that as a new turn, putting one
turn at a second `seq` and leaving the client's merge to move a turn that never moved. An `added`
whose uuid is already held is now a change in place, keeping its `seq`.
