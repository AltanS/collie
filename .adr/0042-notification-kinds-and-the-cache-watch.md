# 0042 — Notification kinds, and the cache watch

Status: **Accepted** (2026-09-13)

Related: [ADR 0041](./0041-cache-rules-are-sourced-claims.md) (the reading this alerts on, and why a
number with no dated page behind it is a rumour) ·
[ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (an opt-in is the ceiling, which is why
the fourth switch defaults off) ·
[ADR 0030](./0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md) (push strings are not
translated) ·
[ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (a peer is not a front door, so the
lead is the only machine that can raise a crew's alert) ·
[ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) (what may and may not cross the crew
link)

## Context

**Collie had three kinds of alert and no written rule about what a kind is.** Needs input, Finished
and App updates grew one at a time: the first two are agent statuses and flow through
`NotifyPrefs.isNotifiable`, the third is not a status at all and is read directly by its own producer.
Nothing recorded which of those two shapes a fourth kind should take, and nothing recorded that a kind
is bridge-wide rather than per-device, even though both existing mechanisms are.

**The fourth kind is the first one that is not about the whole bridge.** "Warn me before this cache
goes cold" is a question an operator asks about ONE pane, usually the one they are working in. A
switch that can only be all-or-nothing turns a useful alert into forty alerts, and a phone that buzzes
forty times has taught its owner to ignore it.

**Per-pane means the preference needs an identity, and the obvious one churns.** A pane id is the
multiplexer's, and it is renumbered when panes move. The harness's own session ref does not move, and
it is already what the prompt-cache ledger is keyed by (ADR 0041). But that ref is server-side only:
for pi it is an absolute filesystem path, so it is stripped before a pane goes on any wire
(`bridge/types.ts` § `PaneWire`).

**And a crew makes "where does the preference live" a real question.** CREW_PROTOCOL.md §5 keeps
`subscribe`, `notifications/snooze` and `notifications/prefs` off the crew surface: push registration
and quiet hours are the lead's, because the lead is the only machine holding a subscription. A
per-pane switch hung off the per-pane route family would be forwarded to the peer that owns the pane
and stored there, where nothing can ever send it.

## Decision

**Four rules, and they bind anything that later adds a kind of alert or a per-pane preference.**

**1. A notification kind is a bridge-wide boolean in `NotifyPrefs`, and an opt-in defaults off.**
`cache` joins `blocked`, `done` and `updates` as a fourth optional key, default **false**. It is not
an agent status, so it does not flow through `isNotifiable`; its producer reads it directly, exactly
as the update monitor reads `updates`. Bridge-wide is not a shortcut: a push fans out to every
subscribed device, so a per-device kind would need the subscription endpoint as a key and a new
dimension in `bridge/push.ts`.

**2. Global OR per-pane, and there is no per-pane off.** A pane is warned when `prefs.cache` is true
**or** its session is on the watch list. The two states add up; neither overrides the other. The cost
of that simplicity is that a list can hide under a switch, so it is paid in the UI rather than in the
rule: the global switch's hint says it also covers panes watched one by one, and the watched panes are
listed under it, with a Remove button each. A hidden second state would be the bug; a visible one is a
feature.

**3. The watch is keyed by the identity the BRIDGE has, and the key never leaves it.** For a pane on
this collie that is the harness session ref, `"<kind>:<value>"`, because pane ids churn. For a pane on
a crew member the lead holds no ref — it was stripped before the wire, and putting it on the wire
would publish an agent-reported filesystem path across a machine boundary — so a peer's pane is keyed
`pane:<paneId>`, the same identity `bridge/crew/notify.ts` already keys a member's alerts by. What a
phone sees is neither: the list publishes an opaque eight-character hash of the key, and that handle
is the only thing it may send back. The remaining rough edge is named rather than hidden — a
renumbered pane on a member, like a moved pi project directory, orphans its entry, which then ages out
after 24 hours and is re-tapped.

**4. A preference about a pane lives on the collie the phone is talking to, so its routes are never
forwardable.** `GET|POST /api/notifications/cache-watch`, `GET …/list` and `POST …/forget` sit in the
`notifications` family and take the pane as a query argument. `?host=` there names where the PANE
lives; it does not address the request. All three are absent from `bridge/crew/forward.ts` and 404
across a crew link, beside the three routes §5 already excludes.

**The state file is written by two events and by nothing else.** `<stateDir>/cache-watch.json` holds
the entries and the `(key, expiresAt)` pairs already pushed. An operator toggle writes it, and so does
a warning actually going out; a poll does not, and neither does asking what the list holds. A bridge
nobody asks therefore still writes exactly the four entries `bridge/solo-baseline.test.ts` asserts.

**The pairs are persisted because a restart is ordinary.** `make deploy` restarts the dev bridge most
days, and an in-memory set would re-warn every watched pane whose deadline is still ahead: a duplicate
buzz on a real phone, on a schedule. The array is pruned on every save to the deadlines still in the
future, so it is bounded by the warm cycles in flight. It is deliberately **not** pruned by "still
watched": the global switch warns panes that have no entry, and dropping their marks would un-dedupe
the exact case the persistence exists for.

**One warning per warm cycle, and the copy says "about".** The unit of suppression is the
`(key, expiresAt)` pair, so the agent's next request moves the deadline and only then may the pane
warn again. A cycle whose whole TTL is shorter than the warn window never warns at all, because it is
never outside that window. The title says "about 5 min" because the deadline is inferred from a
transcript tail with a stated confidence (ADR 0041) and the clock is the mux poll, which is 12 s
coarse when idle.

**The snooze applies, and a muted bridge records nothing.** An update push bypasses the snooze on
purpose; a cache warning does not, because it is exactly quiet-hours material. Nothing is recorded
while muted either, so a snooze that ends inside the window still warns.

## Consequences

**A fifth kind has a shape to copy.** A boolean in `NotifyPrefs`, a default that is off unless the
alert is about Collie itself, a producer that reads the pref directly if it is not an agent status, and
one row in `ROWS` in `web/src/components/notify-prefs-control.tsx`. The notification-type table in
`docs/voice-and-push.md` is where it is announced.

**A per-pane preference has a shape to copy too, and it is not `PANE_ROUTE`.** The route family stays
at seven actions, pinned character for character by `bridge/crew/forward.test.ts`. A preference goes
in the family that owns it, takes the pane as a query argument, and is resolved to a stored key by the
bridge — because the client can only ever name `(host, session, paneId)`.

**The pane settings sheet is now the place a per-pane preference goes.** The pane header's budget is
spent (`web/src/components/agent-chat.tsx` states it: one Leave, one flexible Identity, at most two
Actions), so the entry point is a row in the ⋮ sheet, and the second preference joins the first sheet
rather than inventing a second surface.

**What this does not decide.** No per-pane threshold: one `COLLIE_CACHE_WARN_SECONDS` for every
watched pane, and a per-pane window would need a number per entry, a control on the sheet and a story
for what the global switch means when entries disagree. No second nudge at one minute. No per-device
list. No CLI verb: `collie push list`/`forget` manage subscriptions, and the watch list is the
phone's.

## Alternatives considered

**A segment on `PANE_ROUTE` (`/api/pane/:id/cache-watch`).** Rejected on two counts, either of which
is enough. It is mirrored onto the crew wire and would be forwarded to the peer that owns the pane,
storing a preference where no subscription lives; and `bridge/crew/forward.test.ts` reads the route
literal out of `bridge/server.ts` and compares the two alternations character for character with a
parser that cannot read a hyphenated segment, so the test would error rather than fail. A query string
on a preference route is the small cost; a forwarded preference and a broken wire mirror are the large
ones.

**Keying the list by pane id everywhere.** Rejected for a local pane: a renumbered pane would inherit
a watch it was never given, and the cache ledger next to it is keyed by session ref for exactly that
reason. Accepted for a peer's pane only, and only because the alternative is putting the ref on the
crew wire.

**A per-pane OFF that overrides the global switch.** Rejected. It doubles the state space for one
behaviour nobody has asked for, and it makes "why is this pane quiet" a question with two answers in
two places. The visible watched list is what the simpler rule buys.

**Holding the sent pairs in memory.** Rejected on the restart, above. The alternative cost is a fifth
file in the state dir that is absent until something actually happens.

**A second file for the sent pairs.** Rejected: one writer, one atomic save, one version number. A
warning going out does rewrite the file that holds the operator's choices, and the rename is atomic,
so a crash cannot lose an entry.

**Sending through `makeNotifySink`.** Rejected. That wrapper exists for the coordinator's single-slot
herd summary, and a cache warning is not part of that summary: two watched panes must never overwrite
each other. The warden sends through `push.send` directly and calls the same snooze gate itself, with
one tag per watched pane and `renotify: true`, so within one pane a new cycle replaces the last
warning instead of stacking on it.
