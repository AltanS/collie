# The inside wire, version 1

> **Experimental.** This wire may change in any release until Collie 2.0. A part and a bridge agree on
> the version in `hello`; there is no other compatibility promise yet.
>
> The protocol says "part"; text a person reads says "plugin".

The inside wire is the one local protocol between an **inside part** (a small piece that runs inside an
agent program through the vendor's own extension point; today the only part is the Claude Code mod) and the
Collie bridge on the same machine. The bridge listens; the part dials. It is HTTP/1.1 with JSON bodies
over a Unix socket. The parser is `wire.ts`, the socket `server.ts`, the binding `registry.ts` and
`place.ts`, the command queue `queue.ts`, and `hub.ts` joins them for the rest of the bridge.

## Where the socket is

One socket per bridge: `<stateDir>/inside/sock`, mode `0600`, in a folder of mode `0700` that the
bridge's own user owns and that is not a link. The bridge refuses to listen otherwise.

The socket is opt-in. A bridge opens it only while a harness is linked on the machine (`collie harness
link <harness>` writes a record beside the parts, `<config home>/collie/inside/<harness>.link.json`;
`bridge/inside/links.ts`, `bridge/inside/gate.ts`). A link made while the bridge runs opens the socket
at the next read of the records (every 15 seconds) and rewrites the hook target file; an unlink turns
the data road off at the next read. `COLLIE_INSIDE` (`inside` in `[bridge]`) overrides: `off` is the
kill switch, a link or not (no socket, no `inside` field in the hook target file, every session keeps
the screen path), and `on` opens the wire with no link (a test, a leg). Windows keeps the screen path
in this version.

A part finds every live bridge of the machine through the hook target folder
(`$XDG_STATE_HOME/collie/hook-targets/`, else `~/.local/state/collie/hook-targets/`). Each bridge that
serves the wire writes its socket into its own file there:

```json
{ "schemaVersion": 1, "stateDir": "/home/a/.local/state/collie-next", "pid": 1234, "pidStartTime": 5678,
  "bootedAt": 1763000000000, "mux": "herdr", "instance": "next", "port": 8788,
  "inside": { "wire": 1, "socket": "/home/a/.local/state/collie-next/inside/sock" } }
```

A part reads at most 32 `<16 hex>.json` files, dials only a socket whose `wire` it speaks, and treats a
socket that refuses the connection as gone. A file without `inside` is a bridge that serves no wire.

## The three routes

| Route | Body | Answer |
| --- | --- | --- |
| `POST /v1/hello` | the hello, up to 16 KiB | `200` mine or not mine, `400` refused, `429` slow down |
| `POST /v1/event` | one event, up to 64 KiB | `204`, `200` for `ask.open`, `410` unknown part |
| `GET /v1/next?part=<id>[&ask=<id>][&wait=<ms>]` | none | `200` one command, `204` none in time, `410` unknown part |

`GET /v1/ping` answers `{"wire":1}` and nothing else. Every other route answers `404`. Every body past
its cap is refused with `413`, never cut. A request that the bridge cannot parse answers `400` with a
short reason and changes nothing. Unknown fields are ignored everywhere, so a newer part may add one.

### hello

```json
{ "wire": 1, "harness": "claude", "harnessVersion": "2.1.323", "partVersion": "1.29.0",
  "session": "<the harness's own session id>", "cwd": "/home/a/project",
  "pid": 4242, "pidStartTime": 77,
  "env": { "HERDR_PANE_ID": "w1:p1", "HERDR_SOCKET_PATH": "/run/user/1000/herdr.sock" },
  "capabilities": ["send", "mail", "draft", "draft.state", "wake"], "asks": ["permission"] }
```

- `harness` is an open lower-case word. Shared code never matches it; it is kept for the log.
- `pid` is the agent program's process id. `pidStartTime` is field 22 of `/proc/<pid>/stat`, or null
  where the part cannot read it; the bridge then reads it itself.
- `env` carries the raw values of the multiplexer marker variables, the ones the hook emitter reads
  (`bridge/beacon/env-markers.ts`, `MARKER_ENV_NAMES`): `TMUX_PANE` `TMUX`, `TERN_PANE`
  `TERN_PANE_SOCKET`, `ZELLIJ_PANE_ID` `ZELLIJ_SESSION_NAME`, `HERDR_PANE_ID` `HERDR_SOCKET_PATH`,
  `HC_TERMINAL_ID` `HC_TERMINAL_SOCKET`. Any other name is dropped unread. A part never shapes a
  marker; the bridge runs the one marker table over these values.
- `capabilities` lists what the part can do: `send` (a prompt), `steer` (text into a running turn),
  `mail` (a WalkyTalky message), `draft` (read the input box), `draft.state` (say whether the input
  box holds a draft), `wake` (turn and row events). `asks`
  lists the ask kinds it answers: `permission`, `question`. An unknown word is dropped. The bridge takes
  the data path only for a declared word; anything absent keeps the screen path.

The bridge places the hello exactly as it places a hook edge (`bridge/surface/edges.ts`, `placeEdge`):
exactly one pane of its sessions matches one marker, the pid is alive with that start time, and where
the multiplexer reports the pane's foreground processes, the pid is among them.

```json
{ "wire": 1, "mine": true, "part": "<22 url-safe characters>", "capabilities": ["send", "mail", "draft", "draft.state", "wake"], "asks": ["permission"] }
{ "wire": 1, "mine": false, "reason": "no-pane" }
```

`reason` is one of `no-markers`, `no-pane`, `foreign-mux`, `ambiguous`, `dead-pid`, `not-foreground`.
A part that hears "not mine" leaves that socket alone for a while (the Claude mod: five minutes, or
until its session starts again). A hello with another `wire` is refused with `400` and the bridge's own
version in the reason.

One part per pane. A newer hello for the same pane replaces the older part: it passed the placement, so
it is the pane's foreground program now. The older part id answers `410` from then on, and its open
polls end at once.

### event

Every event carries `part` and `kind`.

| kind | fields | meaning |
| --- | --- | --- |
| `turn.start` | `turn`?, `seq`? | a turn started (wake, state working) |
| `turn.end` | `turn`?, `reason`?, `seq`? | a turn ended (wake, state idle) |
| `row` | `door`, `row`? | the session stored a row: its door and id, never its text |
| `ask.open` | `ask`, `askKind`, `tool`?, `input`? | an ask opened; the answer says whether to wait |
| `ask.close` | `ask`, `how`? | the ask ended on the part's side |
| `taken` | `cmd` | the part read the command (confirmation only) |
| `sent` | `cmd` | the part did what the command asked |
| `failed` | `cmd`, `reason`?, `detail`? | the part could not; `detail` is its own words (below) |
| `draft` | `cmd`, `text`, `caret`? | the answer to a `draft` question: the input box as it stands |
| `draft.state` | `present`, `seq`? | whether the input box holds a draft, a boolean; never the text |
| `bye` | | the part stops; the pane falls back to the screen path at once |

`turn.start`, `turn.end` and `row` reach the rest of the bridge only from a part that declared `wake`.
They are a wake and a state, never items: chat rows still come from the session file (README
decision 10).

`draft.state` reaches the rest of the bridge only from a part that declared `draft.state`. A part says
it after each `hello`, before its turn word, and again each time the box goes from empty to a draft
or back. Any text sent with it is not read.

**State words: their count, their age, and saying them again** (M100 spec 05). `turn.start`,
`turn.end` and `draft.state` are the part's state words, and any one post of them can be lost: no
answer in time, a `429` past the burst, a `5xx`. Three rules cover that.

- **`seq`, the count.** A whole number from 0. The part takes the next number for each new state word
  (one count for all three kinds) and keeps that number when it says the same word again. The bridge
  keeps the count of the last word of each kind it took, per part id, and drops a word with a lower
  count, unread and unpassed: a late retry never undoes a newer word. A word with no `seq` (a part from
  before this field) is taken in arrival order, as before. A new hello is a new part id, so a reloaded
  part's count may start over. A `seq` that is not a whole number from 0 refuses the event (`400`).
- **The age.** The bridge believes a `running` turn or a `present: true` box for 60 seconds from the
  word that said it (`WORD_FRESH_MS` in `hub.ts`); a stored `row` keeps a running turn fresh. Past that,
  the word reads as unknown, and unknown takes the screen road, which reads the turn and the box
  itself. `idle` and `present: false` do not age. A Deliver now, which never sends on an unknown turn,
  reads a running turn of any age as busy.
- **Saying it again.** The part says every state word again after each hello, the box first. A post
  that got no answer, a `429` or a `5xx` is said again after 1, 5 and 15 seconds, then no more until
  the next state word, the next change of the box, or the next hello; a new word starts the waits over.
  The part posts at most four words in a row; a word still unsaid after them goes through the same waits.
  The part keeps per bridge which words that bridge took, so a word whose post failed is never
  deduplicated away. A `410` says hello instead, and the hello says the words.

**`failed`, its reason and its detail.** `reason` is a lower-case word; a reason that is not one
refuses the whole event (`400`), so a part never puts free text there. `detail` (added 2026-11-16,
optional) carries the part's own words: one line, an error's class and message or the agent's reason
for a refusal, never the command's text. The bridge reads it leniently, so it can never cost the word:
control characters and runs of space become one space, it is cut at 160 characters, and anything that
is not a string is dropped. The bridge logs `sent` and `failed` with the command id, the reason and
the detail (`[inside] failed part=… cmd=… reason=… detail="…"`), and the detail reaches the send's
receipt. An older bridge ignores the field. The words the bridge acts on:

| reason | for | meaning | the bridge |
| --- | --- | --- | --- |
| `dropped` | `prompt` | the agent answered the submit "did not enter" | the screen road runs it once |
| `draft` | `mail` | the box held a draft; nothing was submitted | holds the message again |
| `desk` | `answer` | the desk answered first | the hold settles `desk` |

A part says `dropped` only where its agent's contract guarantees the refused submit entered nothing.
For the Claude Code mod that is the `{ drop }` answer of `$.prompt.submit`, whose contract is "the
prompt did not enter: a hook's refusal, a settings hook's block beneath, or the engine's own". A submit
that throws is `submit`, and any other fault while the part handles the command is `error`: the
contract promises nothing for them, so the bridge reads them as "may have arrived".

`ask.close` also withdraws an answer still queued for that ask.

`ask.open` answers `{"wait": false}`, or `{"wait": true, "waitMs": <ms>}` when the bridge wants the
part's hook to wait for the phone's answer (at most 15 minutes). With no answer in time, the part lets
the desk dialog decide, as if it were not there.

### next

A long poll for one command. It waits up to 25 seconds (`?wait=` asks for less, at least 1 second) and
answers `204` when nothing came. `?ask=<id>` waits only for the answer to that open ask; without it the
poll takes everything but answers. One poll per part and filter: a newer one ends the older with `204`.

```json
{ "wire": 1, "id": "req-…", "kind": "prompt", "text": "…" }
{ "wire": 1, "id": "req-…", "kind": "mail", "text": "…" }
{ "wire": 1, "id": "req-…", "kind": "steer", "text": "…" }
{ "wire": 1, "id": "req-…", "kind": "answer", "ask": "<ask id>", "decision": "allow" }
{ "wire": 1, "id": "req-…", "kind": "draft" }
```

`id` has the shape of a phone request id (`[A-Za-z0-9_-]{8,64}`). A text is at most 48 KiB.

## What the bridge sends by data

A phone send goes to a part as `prompt` only when the wire is on, the pane's part declared both `send`
and `wake`, and the send is a plain new message: no steer, no slash command, shell line or mention
(`/`, `!`, `@`), no uploaded image (`bridge/surface/path.ts`, `pickSendPath`). Every other send runs
the Send Protocol on the screen. The bridge, not the part, holds a send while the part reports a turn
running, and releases it at the part's `turn.end`; the held card, Cancel and Dismiss are the screen
road's own. A part that has not reported a turn since it bound (a bridge restart, a reload mid turn)
leaves the turn unknown, and the send takes the screen road until its first turn event; so does a
`running` word grown old (*State words* above), whose `turn.end` may have been lost. The send
keeps the phone's request id as the command id, and its receipt: `sent` on the part's `sent`; `unknown`
(it may have arrived) on `failed` or no word in 15 seconds, with the part's reason and detail in the
receipt's `detail` after a `failed`. One `failed` proves nothing was submitted: `dropped` on a
`prompt` (above). The same request then runs the screen road once, with the screen road's own checks,
and stays on it for the rest of its life (a release from the hold queue included). The send record
and the audit entry carry `path: "data"`, or `path: "screen"` after a data try that no part took or
that the agent dropped.

**A part shadowed by another agent process** (2026-11-16). The bridge places a part by its pid, which
must be the pane's foreground. A Claude Code session moved to a background job breaks the pairing: the
job's agent runs in a process of its own and writes the session's hooks, while the process left in
the pane, the viewer, stays the foreground and keeps the part it bound before. That part sees none of
the job's turns, and its submits do not reach the session. The bridge knows the case by the hook
edges: an edge whose markers name the pane but whose live pid is not the foreground is dropped
`not-foreground`, and its pid is told to the hub (`noteForeignEdge`). From the first such edge of a
pid other than the part's own, the part is shadowed: phone sends and WalkyTalky messages to its pane
take the screen road (a Deliver now stays held, as for a pane with no part), and the log says
`[inside] shadowed part=… pane=… part-pid=… agent-pid=…`. The other process's end edge, or a new
hello, lifts it. A subagent's edge is the same process and shadows nothing.

## Asks and wake by data

**One owner per dialog.** A part owns a permission dialog only while its own hold for that pane and
that dialog is live (`bridge/inside/asks.ts`, `ownsDialog`): the same pane, tool and shown input, on
the main session. A hello alone owns nothing. A part's `ask.open` becomes the settings hook's own hold
request, built with the same profile (`partHoldRequest`), and goes through the session's `takeHold`,
so the card, its hash check, its receipt and its timing are today's; the part is asked to wait the
hold's limit plus its grace. While the part's hold is live, a settings hook's request for the same
dialog is let go at once with no decision (`bridge/inside/owner.ts`). A hook that came first keeps its
card until the part's hold opens; the hold book then ends the hook's hold with no decision, so there
is one card, never none. A subagent's request is never the part's: the Claude mod reports only its
main session's asks. When the part's hold ends with no decision (the limit, a hash that moved, the
part's close, the part gone) while the dialog is still open, the screen reader owns it again and makes
a keys ask, as when a hook lets go early. An ask the hold does not take (a cut input, a screen-only
tool, a pane with no known agent) gets `{"wait": false}` and leaves the hook and the keys ask as they
are. A part closes every ask it opened, one refused a wait too (`how: "no-wait"`).

**Only a tap answers, and the part's word settles it.** Only the hold book's `decide`, after a
person's tap, queues an `answer` command. The hold settles from that command's end: the part's `sent`
is `phone`; its `failed` with reason `desk` (the desk answered first) is `desk`; any other failure, or
a withdrawal (the ask closed first), voids the hold.

**Wake and state.** `turn.start` folds the `prompt` edge (working) into the pane's Surface, `turn.end`
the `stop` edge (idle), and both poke the session's read now; a `row` only pokes
(`bridge/inside/wake.ts`). No event of a part is ever an item: the session file gives the rows.

**Questions (AskUserQuestion) stay on the screen road.** Claude Code's types (2.1.323) say a
`tool.call` hook's `next(e)` opens the desk dialog, and that a hook which returns `{ result }` while
`next` is still pending aborts what runs beneath. So a hook could leave the desk dialog open and
still answer from the phone. This is read from the types and not proven live; no code uses it yet.

## WalkyTalky by data

A WalkyTalky delivery to a pane whose part declared `mail`, `draft.state` and `wake` goes to the part
as `mail` (M99 spec 05). Only the last step changes: the off rule, the border, the limits, the resting
rule and `--wake` run before it as before, and the text handed over is the envelope the screen road
would type. A part that took it and gave no word leaves the receipt "may have arrived, will not be sent
again"; it is never typed after.

**A draft holds it, as on the screen** (decision of 2026-11-13). Another agent's words never go in
over the person's draft. The bridge holds the message while the part reports a turn running or a
draft in the box, with the screen road's own held reasons (`turn running`, `draft present`), its mark,
Cancel and Drop. It goes once, with no key typed, when the part's `turn.end`, or its `draft.state`
with `present: false` while the turn is known, finds both the turn idle and the box empty; the
session's poll may release it too, and every release asks the part's state again first. A part that
did not declare `draft.state`, or has not said it since it bound, leaves the draft unknown, and
unknown takes the screen road, which reads the box itself. Unknown is never taken for "no draft". A
`present: true` grown old is unknown too (*State words* above): its "no draft" may have been lost.

**The window.** The part's word can be late: the person may start to type after the bridge read "no
draft" and before the `mail` arrives. So the part reads the box again right before it submits; a box
with any text, or one it cannot read, ends the command `failed` with reason `draft` and nothing
submitted, and the bridge holds the message again (`draft present`). A later try goes under a new
command id. What is left is the gap between that read and the submit inside the agent program, one
step of its own event loop, and the submit does not touch the box: a key the person types in that gap
stays in the draft, and the message goes in beside it, never over it.

**Deliver now** (decision of 2026-11-13). The person may hand ONE held message to the agent over
their own draft: the pane owner's `POST /api/pane/<pane>/walky/<id>/deliver`, under the browser write
gate and the audit like Drop. The bridge sends it as `mail` with `"overDraft": true`, and the part
submits it without reading the box; the draft stays where it is, and the bridge never reads its text.
Only a message held for the draft (`draft present`), on this machine's own pane, whose part declares
`mail` and `wake`, is asked for. It runs through the hold queue's own release under the same request
id, so the person's tap, the part's "no draft" and the poll take it at most once between them. It
never runs while the part reports a turn running or a question open, or while the turn is unknown;
it never falls back to the screen. A miss (busy, no part, not taken, or a part too old to know
`overDraft`, which answers `failed` with `draft`) leaves the message held for the draft, its try not
counted. A part that took it and gave no word leaves "may have arrived", and nothing sends it again.
The receipt of its end carries `overDraft: true`. A part that does not know the field reads the box as
for any `mail`.

## One id, one path, never twice

A command's life is `queued`, then `taken`, then `sent` or `failed`; or `queued`, then `withdrawn`.

- **Taken is the handoff.** A command is taken the moment the bridge writes it into a `next` answer.
  From then on it is never withdrawn, never handed out again, and the screen path never sends it,
  with one exception: a phone `prompt` whose part answered `failed` with `dropped`, the agent's word
  that nothing entered. Nothing was submitted by data, so the screen road may run it once.
- **Withdraw only while queued.** The bridge may withdraw a command no part took and send it the old
  way, once. A command nobody takes in 60 seconds is withdrawn by age.
- **The part's word decides after take.** `sent` or `failed`, once, from the pane it was for. With no
  word, or a `failed` that does not prove nothing was submitted, the receipt says it may have arrived,
  and nothing is sent again.
- A command id the queue has seen, in any state, is refused when queued again.

A part keeps the ids it acted on across a reload of its own code too (the Claude mod: in `$.state`), so
a command reaches the agent once even if a bridge bug handed it out twice.

## Limits

| What | Limit |
| --- | --- |
| Any body | 64 KiB, else `413` |
| `hello` | 16 KiB |
| Command text | 48 KiB |
| Draft text | 32 KiB, refused past it, never cut |
| Ask input | 16 KiB of JSON |
| Requests per part | 20 a second on average, bursts of 60, else `429` |
| Hellos, whole socket | 5 a second, bursts of 30 |
| Requests, whole socket | 200 a second, bursts of 400 |
| Commands waiting per pane | 16 |
| Asks open per part | 16 |
| Parts per bridge | 256 |
| A part with no request and no open poll | gone after 60 seconds |

## Threat model

The socket is a same-user border. Its folder is `0700` and owned by the bridge's user, so a process of
another user cannot reach it. Any process of the same user can: the same user can already type into
the multiplexer, read the session files and edit the agent's settings, so the socket gives such a
process nothing new it could not do another way. What it could do on this socket:

- **Claim a pane.** It must name a pid that is alive, has the start time it names, is the pane's
  foreground process where the multiplexer reports one, and markers that match exactly one pane. A
  claim replaces the real part. It then receives the prompts and WalkyTalky messages for that pane
  (text the same user can read in the session file and the WalkyTalky log anyway).
- **Report false outcomes.** A `sent` for a command it took makes that receipt say sent. A false
  `ask.open` shows an ask whose answer goes back to it alone.
- **Not more.** No event makes the bridge type a key, run a program, read a file or reach the network.
  Events are a wake and a state. A command goes only to the part bound to that pane, only for a word it
  declared, only with the id the bridge minted.

What the bridge does about the rest: every body is capped and parsed by a total parser, unknown words
are dropped, a part id is 128 random bits, a new part id replaces the old one on every hello, rates are
capped, and no body text (a prompt, a draft, an ask's input) is ever written to the log. Peer
credentials of the connecting process (`SO_PEERCRED`) are not checked: Bun's server does not expose
them. That check would tie a connection to its pid; it is a follow-up, not a border this version
claims.

## Known limits

- **Claude Code marks a data prompt at the desk.** A prompt the Claude mod submits, also with
  `asUser`, shows "Prompt from the collie plugin" above it in the desk transcript. That is Claude
  Code's own mark; the mod cannot remove it.
- **Peer credentials are not checked** (see the threat model). Each replacement of a part by a hello
  that names the same pid and start time is logged (`[inside] replaced by the same pid`), so a claim
  by another process of the same user leaves a trace. This stays on the follow-up list.
- **A socket file with a holder that does not answer in 2 seconds is left alone.** The bridge then
  starts without a socket; only a socket that refuses the connection (a dead bridge) is removed.
- **The desk answering while the phone waits is tested only as a pure function.** The test kit of
  the Claude mod cannot abort a hook's signal, so `phoneAnswerWord` (inside/claude/hooks/core.ts)
  carries that case. The live case, a desk answer while the phone's poll is open, belongs to M99
  spec 13 (the legs).
- **A lost `turn.start` is not aged.** When every retry of a `turn.start` fails, the bridge keeps
  the turn `idle` until the part's next word, and a phone send in that turn goes to the part, which
  submits it as the engine takes a prompt during a turn. Only `running` and a draft age, because only
  they hold a send (M100 spec 05).
- **A part limits every request.** The Claude mod gives each hello and event 5 seconds and each poll
  its wait plus 5 seconds; a bridge that does not answer in time counts as down.

## Versions

`wire` is `1`. A change that an older part or bridge would misread takes a new number, and the bridge
then refuses the old one in `hello` with its own number in the reason. An added optional field does not.
