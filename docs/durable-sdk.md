# The durable SDK (experimental)

> **Experimental.** The package, its API and the wire it speaks may change, or the feature may be
> removed, in a later minor release. [Versions](#versions) says what that means for your durable agent.

`@colliepwa/durable-sdk` is the npm package a durable agent uses to show itself on your phone through
Collie. This page lists every part of it. [Durable agents](durable-agents.md) has the quickstart and the
setup on the Collie side, and [The durable wire](durable-wire.md) explains what travels between the
two.

## Install and entries

One install gives six entries: the root import for most durable agents, and five for a narrower need.

```bash
npm install @colliepwa/durable-sdk@experimental
# or
bun add @colliepwa/durable-sdk@experimental
```

| import | what it holds |
| --- | --- |
| `@colliepwa/durable-sdk` | `openCollie` and the whole API. On Bun it serves the socket with the Bun server, elsewhere with the `node:http` server |
| `@colliepwa/durable-sdk/bun` | The same API, always with the Bun server |
| `@colliepwa/durable-sdk/node` | The same API, always with the `node:http` server, plus `NO_DESCENDANT_CHECK`, the line it writes at start |
| `@colliepwa/durable-sdk/core` | The layout and the wire as one function, `handle(request)`, for a durable agent that brings its own transport. No runtime import, so it runs wherever a web `Request` does |
| `@colliepwa/durable-sdk/pi` | The glue for a durable agent built on Pi Durable ([The Pi helpers](#the-pi-helpers)) |
| `@colliepwa/durable-sdk/durable-harness` | Experimental. A Pi agent on Vercel's durable-harness: a web route that reads the wire from the World on every request, and the wrapper that asks your phone before a risky tool ([The durable-harness entry](#the-durable-harness-entry)) |

The package needs Node 22.19 or later, or Bun 1.4 or later, and has no runtime dependency. `./pi`
needs `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord`, 1.1 or later
and below 2. The entry is tested with Pi Durable 1.1.0 and 1.2.0. The three are optional peer dependencies: a durable agent that never imports `./pi` installs none.
`./durable-harness` needs the same three Pi packages, and two more optional peers at the exact versions it is
tested on: `durable-harness` 0.0.1-beta.6 and `@workflow/world` 5.0.5. It is tested with
`@workflow/world-local` 5.1.2, Pi 1.2.0 and Node 22 or later. A beta moves its API between releases, so the
route checks both versions at its first request. When either differs, every request answers 500 with one line that names both.

The runtime decides whether the durable agent can tell who answers. The descendant check refuses an act
from the durable agent itself or from a process it started, with 403 `caller-refused`. It covers answer,
send, stop, action, rename, close, reopen and starter. Reads stay open.

| runtime | the descendant check | what you set |
| --- | --- | --- |
| Bun on Linux | On by default. Bun reads the caller's process id off the socket | Nothing. `callerCheck: "off"` turns it off |
| Bun on macOS, or any other system but Linux | Cannot run. The start fails with an error that names `callerCheck` | `callerCheck: "off"` |
| Node, any system | Cannot run: Node cannot read the caller of a socket. The durable agent writes one line at start that says so | Nothing. `callerCheck` is not read |

Without the check, any process of your user can answer a card, a tool the agent runs included. Run
the agent's tools in a sandbox that cannot reach the socket. The socket needs a system with file
owners, so on Windows `openCollie` stops at start. A durable agent there serves `./core` behind TLS with a
token instead ([Two ways to reach a durable agent](durable-agents.md#two-ways-to-reach-a-durable-agent)).

## Open a connection

`openCollie` makes the private socket, and the handle it returns lays out what the phone shows.

```js
import { openCollie } from "@colliepwa/durable-sdk";

const collie = await openCollie({ hostName: "desk" });
const space = collie.workspace("support", { title: "Support" });
const tab = space.tab("main", { title: "Tickets" });
const pane = tab.pane("ticket-1", { title: "Maria Lopez", harness: "desk" });
collie.ready();
```

With no `socket` option, the path comes from `COLLIE_DURABLE_SOCKET`, the variable Collie reads too.

| option | what it does | default |
| --- | --- | --- |
| `socket` | The socket path: absolute, at most 103 bytes. Its folder is made with mode `0700`, or must already be yours with mode `0700` | The `COLLIE_DURABLE_SOCKET` variable. Neither set: the start fails |
| `hostName` | The durable agent's own name in its hello, cut to 64 bytes. Required | None |
| `tailLimit` | How many raw events each pane keeps for Collie's reads | 500, at most 1000 |
| `caps` | What the durable agent says it can do ([Caps](#caps)) | Everything the SDK can do |
| `callerCheck` | `descendant` or `off`. Read on Bun only | `descendant` |
| `hooks` | One named place for each act the phone sends ([Hooks and history](#hooks-and-history)) | None |
| `warn` | Where the SDK writes its one-line notes, for example about a Collie that speaks another wire version | `console.warn` |
| `onRename` | Deprecated. The old name of `hooks.onRename`, kept for one release, without the request id | None |

Two more options exist on `createCore` only, not on `openCollie`: `receipts` and `allowAlways`
([Questions](#questions)).

| on the handle | what it is |
| --- | --- |
| `address` | The socket path it listens on |
| `epoch` | New and random on every start, 128 bits |
| `core` | The core behind the socket. A test, or a second transport, calls `core.handle` directly |
| `workspace(id, { title, cwd? })` | A workspace, made once per id. Its `tab(id, { title })` gives a tab, and the tab's `pane(id, options)` a pane |
| `starters(list)` | What the phone can start from the New page, at most 50. Each is `{ id, label, run }`, and `run` resolves to `{ paneId }` of the pane it showed |
| `history(provider)` | Serve the durable agent's own record of its conversations ([Hooks and history](#hooks-and-history)) |
| `ready()` | Call once every pane is shown, and after a restart once every open ask is raised again. Until then every route but hello answers 503 `starting` |
| `close()` | Stop the server. Replies already on their way still go out, for at most 2 s, then the socket file goes |

`close()` leaves open asks open on purpose: a shutdown is not an answer, and the durable agent decides
what happens to the work that waits on one.

`tab.pane(id, { title, harness, cwd?, sessionId? })` returns the pane that has that id when there is
one, so a durable agent can show a conversation twice without a second pane. Titles are cut to 256 bytes
and `harness` to 64. `cwd` is an absolute path, else it is left out.

Every id follows the id rule: 1 to 128 bytes, no control character, no whitespace, and none of `/`,
`?` or `#`. A bad id is a `TypeError`. A workspace or tab id may not hold `:`, because the wire names
a tab `<workspace>:<tab>`.

## Panes

A pane is one conversation, and its methods set what the phone shows for it.

| method | what the phone shows | limit |
| --- | --- | --- |
| `state(s)` | `working`, `waiting` or `idle`. A change to `working` starts a new turn | While any ask is open the pane reads `waiting` |
| `event(e)` | Chat's items: `item`, `remove`, `settled`, `reset` and `synced` events | See the item table below |
| `subtitle(text)` | One line under the title. `null` clears it | 120 characters |
| `badge(value)` | `{ count }` or `{ text }` next to the title. `null` clears it | A count from 0 to 9999, a text of 12 characters |
| `progress(value)` | `{ kind: "steps", steps }` or `{ kind: "percent", value, label? }`, drawn while the pane works or waits. `null` clears it | 12 steps, each label 60 characters, a value from 0 to 100 |
| `actions(list)` | Buttons in the durable agent's section of the belt: `{ id, label, icon?, busy?, disabled? }`. `null` clears them | 4 buttons, a label of 16 characters |
| `onAction(fn)` | Runs a tap on one of those buttons. Return `false` to refuse it | The phone sends no tap for a `busy` or `disabled` button |
| `onSend(fn)` | Takes the phone's text, as `fn(text, { steer, requestId })` | 32 KiB of text |
| `onAbort(fn)` | Takes Stop, as `fn({ requestId })` | None |
| `ask(input, { signal? })` | A question card ([Questions](#questions)) | 50 open asks per pane |
| `updateAsk`, `decideAsk`, `outcomeOf` | Change, decide or read back an ask ([Questions](#questions)) | None |
| `close()` | Takes the pane out of the layout. Its open asks close as stopped | None |

A pane also has four read-only fields: `id`, `sessionId`, `turnId` (the running turn, or the last one)
and `openAsks`. The `icon` of an action is one of `play`, `pause`, `check`, `x`, `refresh`, `archive`,
`flag`, `star`, `send`, `note`, `search` and `more`. Another name draws no icon.

An `item` event carries one item with an `id` and an optional `ts`. An item with a known id replaces
the earlier one in place.

| kind | what it holds | limit |
| --- | --- | --- |
| `user` | A line the person sent. `requestId` names the send it came from, so the phone swaps its own line for it | 64 KiB of text |
| `reply`, `thinking`, `notice` | The agent's words | 64 KiB of text |
| `markdown` | Text the phone renders as markdown: headings, lists, emphasis, code spans and links | 32 KiB of text |
| `code` | A code block, with `lang` such as `ts` | 32 KiB of text. `lang` is 1 to 24 letters, digits or `_ + # . -` |
| `link` | An `href` and an optional `label` | `href` is `https://` only, at most 2048 characters. `label` is 120 characters |
| `tool` | A tool call: `tool: { kind: "other", name, summary, output? }` and a `status` of `running`, `done`, `failed` or `denied` | `name` 128 bytes, `summary` 1 KiB, `output` 16 KiB |

A `reply`, `thinking`, `notice` or `markdown` item may carry `partial: true` while its text grows.
Write the same id again as it grows, at most every 250 ms, then once more with the final text and no
`partial`, before the pane leaves `working`.

Text over its limit is cut, and controls and invisible characters are removed. A bad `lang`, a bad
`href`, a bad badge or a bad progress is a `TypeError` or a `RangeError` instead, because Collie would
drop it. A durable agent may not append `ask`, `ask-closed` or `state` events itself: `ask()` and `state()`
write those.

## Questions

`pane.ask` shows a card and resolves with the answer, and `requireApproval` asks about one tool call
in one line.

```js
import { requireApproval } from "@colliepwa/durable-sdk";

const args = { order: "5521", amount: 40 };
const approval = await requireApproval("refund", args, {
  pane,
  toolCallId: "call-1",
  timeoutMs: 10 * 60_000,
});
if (!approval.approved) throw new Error(`refund not approved: ${approval.decidedBy}`);
```

`requireApproval(toolName, args, options)` builds the card from what the call is, never from the
model's words about it. The title is "refund wants to run", the tool line is
`refund(order: "5521", amount: 40)`, the push says "refund needs a yes", and the buttons are Allow and
Deny. It returns `{ approved, decidedBy, decidedAt, askId }`. A deny, a timeout, a stop and an abort
all return `approved: false`.

| option of `requireApproval` | what it does | default |
| --- | --- | --- |
| `pane` | The pane that asks. Required | None |
| `toolCallId` | The tool call's own id, the same across a restart. Any string: one that breaks the id rule is made safe | Required |
| `itemId` | The item the card sits under | The tool call id |
| `timeoutMs` | How long the phone has. Past it the call is denied, decided by `timeout` | No limit |
| `signal` | An `AbortSignal`. Aborting denies the call, decided by `program` | None |
| `labels` | The words of the two buttons, `{ allow?, deny? }` | Allow and Deny |

`callSummary(name, args)` and `argumentsView(args)` are the two pieces it uses: the call in one line,
and the arguments as `key: value` pairs with each value as JSON.

`pane.ask(input)` takes one of four kinds. The promise resolves with the answer in the shape of the
kind.

| `kind` | what the card shows | the answer | limit |
| --- | --- | --- | --- |
| `permission` | One button per option, each with an `effect`: `allow`, `allow-always`, `deny` or `cancel` | `{ optionId, note? }` | 1 to 6 options |
| `choice` | One button per option. With `multiple: true` the person picks several | `{ optionIds }` | 1 to 8 options |
| `text` | One text field, with an optional `placeholder` | `{ text }` | `maxLength` from 1 to 2000, default 500. The placeholder is 60 characters |
| `form` | 1 to 6 fields, each of kind `text`, `choice` or `toggle`, some `required` | `{ values }`, keyed by field id | A choice field has 1 to 8 options |

Every kind takes `toolCallId`, `itemId` and `title` (256 bytes). It may take `reason` (2 KiB), `tool`,
`push: { title?, line? }` (60 and 120 characters, the words of the notification) and `expiresAt` (a
`Date` or an ISO 8601 string with a zone).

Leave `id` out. The SDK derives it with `askIdFor(paneId, toolCallId)`: SHA-256 over the two ids,
the first 32 hex characters. The same tool call raised again after a restart therefore gets the same
id, and an answer the phone sent across the restart lands. Raising an id that is already open is a
`TypeError`.

| on the pane | what it does |
| --- | --- |
| `updateAsk(askId, patch)` | Changes an open ask in place: `title`, `reason`, `tool`, `options`, `placeholder`, `maxLength` or `fields`. Its revision rises by one, so an answer to the old form gets 409 `stale` and the phone asks for a fresh tap. False when the ask is not open |
| `decideAsk(askId, answer?)` | The durable agent decided the ask itself, somewhere other than the phone. With `answer`, the waiting `ask()` resolves with it. Without, it rejects with `AskClosed`. A later tap on the phone gets 409 `decided`, and the card says "Decided in the durable agent." False when the ask is not open |
| `outcomeOf(askId)` | The first decision: `{ decidedBy, decidedAt, optionId?, effect? }`. The pane remembers its last 500. Undefined for an ask it never raised or forgot |

`decidedBy` is `phone`, `program` or `timeout`. An ask passes its `expiresAt` and closes as decided
by `timeout`: `ask()` rejects with `AskClosed`, whose `decidedBy` is `timeout`. The card shows the time
left until then. A question that timed out or was decided in the durable agent leaves one line in Chat,
such as "Timed out before an answer: refund wants to run".

An aborted `signal`, `pane.close()` and a close from the phone close the ask as decided by `program`,
and `ask()` rejects with `AskClosed`.

> **Caution.** An `allow-always` option lets every later call through after one answer. Over https the
> token is the only gate, so a durable agent there offers Allow and Deny only. `createCore` with
> `allowAlways: false` makes an `allow-always` option a `TypeError`. The phone offers no
> `allow-always` on an ask whose words were cut or cleaned, or that names no tool.

Every act from the phone carries a request id, and the core keeps its receipt: a repeat runs nothing
and gets the first reply again with `replayed: true`. The default `MemoryReceiptStore` keeps the
newest `RECEIPTS_PER_GROUP` (1000) per pane, and per group for starters, renames, closes and reopens.
A repeat of an id it dropped gets 500 `receipt-dropped` and runs nothing. The store is gone with the
process.

To keep receipts across a restart, write a `ReceiptStore` with `get(requestId)` and
`put(requestId, record, group)`, and pass it to `createCore` as `receipts`. `openCollie` always keeps
them in memory.

## Hooks and history

A hook is the one named place for an act the phone sends, and a history provider serves your own
record.

| hook | when it runs | how it refuses |
| --- | --- | --- |
| `onSend(pane, { text, steer, turnId, requestId })` | Text for a pane that has no `pane.onSend` | Throw: 500 `internal`, an unknown outcome for the phone |
| `onAbort(pane, { turnId, requestId })` | Stop for a pane that has no `pane.onAbort` | Throw, as above |
| `onAction(pane, { actionId, turnId?, requestId })` | A belt tap on a pane that has no `pane.onAction` | Return `false`: 422 `action-refused` |
| `onRename({ kind, id, title }, requestId)` | A new title for a workspace or a tab | Return `false`: 422 `rename-refused` |
| `onClose({ kind, id, paneIds }, requestId)` | The phone closes a pane, a tab or a workspace | Return `false`: 422 `close-refused` |
| `onReopen({ id, paneId? }, requestId)` | The phone reopens a closed conversation | Return `false`: 422 `reopen-refused` |

A hook runs only when its cap is on and its request id is new. A refusal stores nothing, so the same
request id may try again. The per-pane handlers win over a hook. A pane with neither answers 409
`not-supported` to a send, a stop or a tap.

The SDK applies an accepted act itself. A rename sets the title. A close removes the target and
everything inside it, and closes their open asks as stopped. A reopen without a hook puts back a pane
this process closed; a conversation closed before a restart needs `onReopen`. The layout is made
again on every start, so a durable agent that wants a title or a close to outlive the process stores it in
its hook.

`collie.history(provider)` serves every conversation, open and closed, from the durable agent's own store.
It turns the `history` cap on when `caps` is left out or names `history: true`.

| `HistoryProvider` | returns |
| --- | --- |
| `list(after, limit)` | `{ items, next? }`: conversation rows, newest first, at most `limit` (100) |
| `items(id, after, limit)` | `{ items, next? }`: the conversation's items, oldest first, each in its latest version, at most `limit` (1000). `undefined` for an id it does not know |

A row is `{ id, title, subtitle?, workspaceId?, tabId?, startedAt, endedAt?, state, items }`, with
`state` `open` or `closed` and `items` the count. A cursor (`after`, `next`) is your own string, 1 to
512 bytes of printable ASCII with no space. `next` absent ends the list.

Once a provider is set, each pane's `sessionId` is its pane id, and the history serves the pane's
conversation under it. Pass `sessionId` to `tab.pane()` to name another id, or `null` when it cannot
stay the same across a restart.

`tailLimit` is not history. It is the raw tail each pane keeps for Collie's event reads, 500 events by
default. A reader that fell behind it gets the pane's whole current view instead, at most the newest
2000 items.

## Caps

A cap says the durable agent can do one thing, and the phone draws a control only for a cap the durable agent
declared.

| cap | what the durable agent takes |
| --- | --- |
| `asks` | Raises questions and takes answers |
| `starters` | Lists starters and runs one from the New page |
| `send` | Takes text from the phone |
| `steer` | Takes text into a running turn. Needs `send` |
| `abort` | Stops a running turn |
| `rename` | Takes a new title for a workspace or a tab |
| `close` | Closes a pane, a tab or a workspace |
| `actions` | Lists belt buttons on a pane and runs one |
| `history` | Serves its conversations, open and closed |
| `reopen` | Shows a closed conversation again |

Left out, `caps` turns on everything the SDK can do, and `history` once `history()` has a provider.
Given, it is the whole list: a cap it does not name is off, so `{ asks: true }` declares asks alone.
To turn one off and keep the rest, spread `ALL_CAPS`: `{ ...ALL_CAPS, steer: false }`. A route whose
cap is off answers 409 `not-supported`. `terminal` is always false.

## Helpers and constants

The root import also exports the parts `openCollie` is made of, and the rules it applies.

| export | what it is |
| --- | --- |
| `createCore(options)` | The core without a server. It takes the `openCollie` options but `socket` and `callerCheck`, plus `receipts` and `allowAlways`. It returns `epoch`, `workspace`, `starters`, `history`, `ready`, `isReady` and `handle(request)` |
| `handle` | The wire as one function, a web `Request` in and a `Response` out. `core.handle(request)` is the usual way in |
| `wireListener(core)` | `core.handle` as a `node:http` request listener, with `drained()` for a clean close |
| `hello`, `versionLine` | The hello reply, and the one line a durable agent writes for a version refusal |
| `mintId()` | A new random id, 128 bits as 32 hex characters |
| `askIdFor(paneId, toolCallId)` | The derived ask id |
| `AskClosed` | The error `ask()` rejects with when no answer came. It carries `by` and `decidedBy` |
| `idOk(id)`, `assertId(id, what)`, `safeId(raw)` | The id rule: a check, a check that throws, and a safe id made from any string, the same one every time |
| `cursorOk(cursor)` | The history cursor rule |
| `cut(text, max, multiline?)` | Clean a string and cut it to `max` bytes, with `…` at the end |
| `hrefOf`, `langOf`, `badgeOf`, `progressOf` | A link target, a code language, a badge and a progress, checked as the pane checks them |
| `subtitleOf`, `pushTextOf`, `renameTitleOf` | A subtitle, the push words of an ask and a rename title, cleaned and cut |
| `CAPS`, `LIMITS` | Every cap per field in bytes, and every cap per list |
| `ACTION_LABEL_MAX`, `BADGE_TEXT_MAX`, `BADGE_COUNT_MAX` | 16, 12 and 9999 |
| `SUBTITLE_MAX`, `LINK_LABEL_MAX`, `RENAME_TITLE_MAX` | 120 characters each |
| `PROGRESS_STEPS_MAX`, `PROGRESS_LABEL_MAX` | 12 steps, 60 characters |
| `PUSH_TITLE_MAX`, `PUSH_LINE_MAX`, `PLACEHOLDER_MAX` | 60, 120 and 60 characters |
| `ANSWER_TEXT_MAX`, `ANSWER_TEXT_DEFAULT`, `ANSWER_TEXT_BYTES` | 2000 and 500 characters, and 8000 bytes |
| `ALL_CAPS`, `PROTOCOL_RANGE`, `SOCKET_ENV` | Every cap on, the wire versions the SDK speaks, and the name `COLLIE_DURABLE_SOCKET` |
| `MemoryReceiptStore`, `RECEIPTS_PER_GROUP` | The default receipt store, and its 1000 per group |

Every type on the wire and every hook payload is exported too, from `src/core/types.ts`.

## The Pi helpers

`./pi` turns a Pi Durable conversation into a pane, a risky tool call into a card, and Pi's store into
history.

| export | what it does |
| --- | --- |
| `showConversation(loc, harness, conversation, o)` | Shows a conversation as a pane, history first, then live events. Send goes to Pi's `submit` with the request id, and Stop to its abort. Safe to call twice |
| `PaneRegistry` | Which pane shows which conversation. After a restart, `reRaised(risky)` waits until each risky call without a result has asked again, so `ready()` comes after the asks |
| `riskGuard({ panes, risky, words?, timeoutMs?, onTimeout? })` | A Pi extension whose `beforeTool` hook turns a call to a tool in `risky` into an Allow and Deny card. A denied call is blocked. With `timeoutMs`, the card expires, a call nobody answered is blocked, and `onTimeout(tool, title)` lets the durable agent log it |
| `askTools({ panes, words, timeoutMs?, onTimeout? })` | The support desk's two asking tools: `ask_queue`, a choice, and `ask_customer`, a text ask. With `timeoutMs`, an unanswered ask expires and the tool returns "timed out" |
| `spawnHelperTool(o)` | The tool `spawn_helper`: a child conversation shown as a new pane, which returns the helper's answer |
| `piHistory({ harness, panes, describe })` | A `HistoryProvider` that reads every entry of every Pi conversation |
| `firstMessageOf(conversation)` | The text of a conversation's first message, to name its pane |
| `paneIdOf(id)`, `conversationOfPaneId(paneId)` | A Pi conversation's pane id, `conv-<id>`, and back |
| `summaryOf(args, name?)` | A tool call's arguments in words, at most 200 characters |
| `Mapper` | Pi entries and agent events as items. A growing reply keeps one item id |
| `PARTIAL_MS`, `RE_RAISE_MS` | 250 ms between two writes of a growing reply, and the 5000 ms `reRaised` waits at most |
| `ESCALATED` | Example vocabulary: the support desk's notice for the Escalate button that `showConversation` adds with `escalate: true` |
| `ASKING_TOOLS` | Example vocabulary: the names of the support desk's two asking tools |
| `Submit`, `ReplyExtras` | The types of a custom `submit`, and of the items a durable agent adds under a finished reply |

The words a card shows come in as options, so `./pi` holds no text of the example but those two
constants. It is written against Pi Durable 1.1.0. The support desk in `examples/durable-member/`
puts every part together.

## The durable-harness entry

`./durable-harness` shows a Pi agent that runs on Vercel's durable-harness. The steps are in
[A durable agent on durable-harness](durable-agents.md#a-durable-agent-on-durable-harness).

> **Experimental.** It is tested self-hosted. It is untested on Vercel until a preview deployment has run it.

| export | what it does |
| --- | --- |
| `withCollie(open, options)` | Wraps the opener you give `resumeWith`. Each session it opens gets a guard that asks the phone before a risky call. Returns the opener |
| `collieRoute(options)` | Returns `(request: Request) => Promise<Response>`, the wire over a bearer token. It builds its answer from the World on every request and keeps nothing |
| `takeoverControls(open, { port })` | The route's default send and stop. They take the session over, act and let go |
| `createRoute`, `WireSource` | The route over any source, for a source that is not Pi. `collieRoute` is `createRoute` with the Pi source |

The opener you pass to `withCollie` takes `(storage, registry)`, and must open the Harness with that registry.
An opener that does not read it makes `withCollie` throw, because no call would ask.

| option of `withCollie` | what it does | default |
| --- | --- | --- |
| `registry` | Your registry. Required. What you install in it later reaches every open session | None |
| `risky` | The tool names that need the phone's yes. Required | None |
| `words` | The words of a call's question, as for `riskGuard` | "<tool> wants to run", Allow and Deny |
| `timeoutMs` | How long the phone has. Past it the question closes as timed out and the call is blocked | No limit |
| `onTimeout` | Called with the tool name and the question's title when a question timed out | None |
| `journal` | The journal to use. For a test | The session's own World |
| `pollMs` | `{ first, max }`, the first and the longest wait between two reads of the journal | `{ first: 1000, max: 5000 }` |

| option of `collieRoute` | what it does | default |
| --- | --- | --- |
| `open` | The opener `withCollie` returned. With it, send and stop take the session over | None. Without it and without `controls`, the phone reads and answers only |
| `token` | The bearer token. At least 32 bytes. A missing or short one matches no request | None |
| `tokenNext` | A second token accepted while you rotate | None |
| `name` | The name you gave `resumeWith(open, { name })` | `pi-durable` |
| `hostName` | What Collie calls this host | The `name` |
| `caps` | What the host declares | `asks`, `send`, `abort` and `history` |
| `controls` | Your own `send` and `abort`, in place of the takeover ones | `takeoverControls(open)` |
| `epoch` | The epoch to say in hello | `COLLIE_EPOCH`, else a hash of the wire version, the mapper schema, the World and the name |
| `staleMs` | How long a GET may be answered from the last good answer while the World errs. Then 503 `starting` | 5000 |
| `world` | The World to read | The environment's World |
| `port` | The whole World port, for a test | One on `world` and `open` |

The epoch is never random on this host. It changes only when the meaning of a cursor changes, so two
instances of one deployment say the same one. A wrong or missing token gets a bare 401 before the World is read.

The journal that holds the questions is one World stream per run, named `<runId>_collie`. The core exports
`foldJournal` and `parseJournal` for it, and
[`WIRE.md`](../bridge/mux/durable/WIRE.md) has the records in its appendix "A host with no process".

## Versions

The package has its own version, apart from Collie's, and names the wire version it speaks.

| | today | what it means |
| --- | --- | --- |
| `SDK_VERSION` | 0.1.0 | The package version. Until the package leaves the dist-tag experimental, a minor release may change the API |
| `WIRE_VERSION` | 1 | The durable wire version the package speaks |

Collie speaks one wire version and accepts the one before it for one minor release after a new one
ships. When a Collie speaks none of your versions, the core writes one line through `warn`, once per
version, for example
`collie: Collie speaks wire v2, this durable agent speaks v1. Update the agent's SDK, or Collie.` The phone says the mismatch
on the durable agent's home, in Collie's own words. Update the older side.

The package is published under the npm dist-tag experimental, never latest. If the durable wire goes
at [the exit](durable-agents.md#the-exit), the package is deprecated
([ADR 0105](../.adr/0105-the-durable-sdk-is-an-npm-package.md)).
