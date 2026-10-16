# Durable member: a durable agent built on Pi Durable, in your crew

Two durable agents that speak the durable socket wire to Collie. `hello.ts` is 10 lines of code and asks one question.
`app.ts` is a small support desk built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable):
it answers made-up support tickets for an online shop and shows each conversation to Collie. A Collie you
attach it to lists those conversations, so you can read them on the phone and answer their questions
there. The wire is experimental and may change in any minor release of Collie
([`WIRE.md`](../../bridge/mux/durable/WIRE.md)). This folder is example code to read and copy. The SDK it uses is
the npm package [`@colliepwa/durable-sdk`](../../packages/durable-sdk/README.md).

## Start here: hello.ts

You need Linux and Bun 1.4 or later. From a clone of collie:

```sh
cd examples/durable-member
bun install --frozen-lockfile
bun hello.ts
```

The durable agent prints `listening /run/user/1000/hello/app.sock` and waits. This is all of it, with the import a
durable agent of your own writes:

```ts
import { openCollie } from "@colliepwa/durable-sdk";

const socket = process.env.COLLIE_DURABLE_SOCKET ?? `${process.env.XDG_RUNTIME_DIR}/hello/app.sock`;
const collie = await openCollie({ socket, hostName: "hello", caps: { asks: true } });
const pane = collie.workspace("hello", { title: "Hello" }).tab("main", { title: "Questions" }).pane("deploy", { title: "Deploy", harness: "hello" });
collie.ready();
console.log(`listening ${collie.address}`);
const options = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
const answer = await pane.ask({ kind: "choice", toolCallId: "deploy-1", itemId: "deploy-1", title: "Deploy to staging?", options });
console.log(`answer: ${answer.optionIds[0]}`);
await collie.close();
```

It imports the SDK and nothing else, with no Pi Durable and no model. Attach it to your Collie
([below](#attach-it-to-your-collie)), open Collie on the phone, and the question "Deploy to staging?" waits
on a card with Yes and No. Tap one. The durable agent prints your answer and exits.

## The support desk: app.ts

The same install runs the desk:

```sh
bun run app
```

The app prints the socket it listens on, for example
`listening /run/user/1000/durable-member/app.sock`. It needs no key and no settings, because its default model is a scripted one: the desk is the fixture the
tests run and the demo the playground shows. Without a real model it says so on the next line: "Using the
scripted model. Set REAL_MODEL and a key or a sign-in for a real one (README, A real model)." See
[A real model](#a-real-model).

On the first start the app opens one ticket: Maria Lopez can't sign in after a password reset. The
scripted model asks to save a note to the ticket, and the ticket waits for your answer. The app keeps its conversations in `~/.local/state/durable-member/`, so
the next start shows them again. Delete that folder to start over. Stop the app with Ctrl-C.

The app installs on its own. The collie root install does not pull in Pi Durable, and this folder
has its own `bun.lock`. Pi Durable, `chord` and `pi-ai` are pinned to exact versions.

## Attach it to your Collie

```sh
collie durable attach desk --socket /run/user/1000/durable-member/app.sock
collie restart
```

Use the path the app printed. For `hello.ts` the path ends in `hello/app.sock`. Add `--restart` to
the first command to restart in the same step.

One Collie carries your terminal and the app together, so a host that already runs Collie with
Herdr needs no second instance. The app appears in the Durable agents section on the phone.
`collie durable list` shows each durable agent you attached, and `collie doctor` checks the socket and
says what is wrong when Collie cannot reach the app. The whole setup is on the
[Durable agents page](../../docs/durable-agents.md).

Run the app as the same user as Collie. Keep the socket under `$XDG_RUNTIME_DIR`: the Collie service
runs with a private `/tmp`, so it cannot see a socket in `/tmp`.

A Collie with no terminal, such as a Windows host, can drive the app alone from its `.env` instead
([A durable agent alone in one Collie](../../docs/durable-agents.md#a-durable-agent-alone-in-one-collie)):

```sh
COLLIE_MUX=durable
COLLIE_DURABLE_SOCKET=/run/user/1000/durable-member/app.sock
```

## Join the crew

On a machine of your crew, attach the app to that machine's Collie, as above. The commands that
make a crew are in [Crew commands](../../docs/crew.md#two-machines-one-crew).

A durable-only instance joins like any other machine: `collie crew invite` on the lead, then
`collie crew join` on this host. It then shows up in the list as a machine of its own. A member's
name defaults to the host name. If this host already runs the lead or a Herdr peer, name the
durable-only instance so the host chip can tell them apart:
`collie crew join <lead-address> --label durable`. (`collie crew rename` names the crew, not a
member.) A lead older than 1.21.0 lists the pane but shows no ask card, only "needs you". Update
the lead first.

## What you see on the phone

- **The conversations.** Each ticket is a conversation, named after its customer (Maria Lopez, Jonas
  Berg, Priya Shah, and so on), with its topic on the line under the name. When a question waits for you,
  that line shows the question instead. The workspace is "Support". Tickets are in the tab "Tickets", and the
  look-ups a ticket starts are in the tab "Look-ups".
- **Chat only.** A conversation has no terminal, so there is no Terminal view and no typed keys.
- **The question.** A card under the note asks "Save this note to the ticket?" and shows the note, with Save
  and Don't save. Save writes the note to `notes.txt` in the data folder, a look-up finds the cause, and the
  ticket ends with a reply. Don't save blocks the tool, and the ticket stops there. Only your tap answers. The
  app never answers its own question.
- **A look-up.** The sign-in ticket starts a second conversation, "Look-up for Maria Lopez", that asks why
  sign-in fails after a reset. It answers in one sentence, hands the answer back to the ticket and closes. The
  list shows it under Closed, and a tap opens it read-only.
- **A badge.** A badge next to the ticket's name counts the questions that wait for you.
- **A belt action.** Each ticket has an Escalate button in the belt. A tap writes one notice into the thread,
  dims the button, and the line under the name reads "Escalated to the on-call lead.".
- **Progress.** While a ticket works, Chat shows a thin row under the header with the running step ("Save a
  note, 2 of 3") and a bar, and the card gets a one-pixel line along its bottom edge. The three steps are "Read
  the ticket", "Save a note" and "Reply".
- **Markdown, code and a link.** When the sign-in ticket ends, its next steps (a list), the command that signs
  the customer out (a shell snippet) and a runbook link follow the reply. They are three item kinds, `markdown`,
  `code` and `link`. The link goes to `example.com`, so it leads nowhere real.
- **Send, steer and Stop.** Text sent to an idle ticket starts a new turn. The scripted answer to a
  follow-up is a long explanation that takes about ten seconds to write, so you have time to steer it or press
  Stop. Stop ends the turn where it is.
- **A reply that grows.** The model writes every answer in chunks, and the pane writes the reply item again under
  the same id as it grows, with `partial: true`, at most every 250 ms. The last version has no `partial`. Chat draws
  a cursor at the end while it grows, and Stop cuts the reply where it is. The `user` item carries the `requestId` of
  the send, so the phone swaps its own pending line for it (WIRE.md 7.15).
- **Starters on the New page.** Each starter opens a ticket from the next customer. "Sign-in problem" is the
  ticket above. "Double charge" saves a note, asks which team should take it (a `choice`, three buttons) and then
  what to tell the customer (a `text` ask). "Address change" asks to save two notes at the same time, one per
  order. A fourth kind of question, `form`, takes up to six fields; see `pane.ask()` in the SDK and WIRE.md
  section 7.14.
- **Renames.** The app takes a new name for its space or a tab (`POST /rename`) and keeps it in `titles.json` in
  its data folder, so a restart shows it again.
- **Closes.** Open a ticket's actions sheet and tap Close conversation. The app ends the ticket's run, writes it to
  `closed.json` in its data folder so a restart does not show it again, and the ticket moves to Closed. Its open
  question closes as stopped. The two tabs and the space are the app's own layout, in code, so it refuses to
  close those (422).

## A real model

The scripted model is the default. `REAL_MODEL` switches the desk to a real one, from one of two places. Collie
holds no key of its own. Use an API key or a ChatGPT sign-in. An Anthropic subscription (Pro or Max) may not be used
through a third-party harness, so do not sign in with one here.

**OpenRouter with an API key.** Set a model id from Pi's OpenRouter catalog and your key:

```sh
export OPENROUTER_API_KEY=sk-or-v1-your-key-here
REAL_MODEL=google/gemini-3.1-flash-lite bun run app
```

**OpenAI with an API key or a ChatGPT sign-in.** Set `REAL_PROVIDER=openai` and a model id from Pi's OpenAI
catalog. With an API key, set `OPENAI_API_KEY=your-key-here`. To use a ChatGPT Plus or Pro plan instead, sign in
once with Pi's login. The login saves `auth.json` in the folder you run it from, so run it in the data folder
(`DM_DATA`, by default `~/.local/state/durable-member`). Run the copy of Pi that `bun install` pinned in this
example folder, not a fresh download:

```sh
EXAMPLE=$PWD; mkdir -p ~/.local/state/durable-member && cd ~/.local/state/durable-member
bun "$EXAMPLE/node_modules/@earendil-works/pi-ai/dist/cli.js" login openai
chmod 600 auth.json
cd "$EXAMPLE" && REAL_PROVIDER=openai REAL_MODEL=gpt-5-nano bun run app
```

No menu appears. The login starts the browser flow at once and prints a URL to open. The browser must run on the
same machine as the login, because the callback is `127.0.0.1:1455`, the port the Codex CLI login also uses.
Close a Codex CLI login first, or the port is taken. Which models a ChatGPT plan reaches is OpenAI's list, not
Collie's. `gpt-5-nano` is the model the API-key test used, so change it if your plan does not include it.

The login writes `auth.json` with mode 0644, so run the `chmod 600` right after it. The app keeps the mode 0600
when it refreshes the tokens. The app reads `auth.json` from its data folder, and Pi keeps the tokens fresh
there. Guard that file like a password. The app never prints it. A stored sign-in wins over `OPENAI_API_KEY`, so
the key is used only when `auth.json` has no `openai` entry. With neither a key nor a sign-in the start stops
with an error.

The id must be one that the provider's Pi catalog knows, or the start stops with an error. Pi reads the key,
and the app never prints it. Every ticket now costs tokens, including the one a first start opens. A real model
may not follow the script, so a ticket can take a different path.

## The trust model

The socket keeps out other users. The app makes it mode `0600`, in a folder with mode `0700`, both
owned by you. There is no token and no TCP. Before each connect, Collie checks every folder on the
path and the socket itself ([`WIRE.md` section 1A](../../bridge/mux/durable/WIRE.md#1a-a-private-socket)).

The socket does not keep out you. Any process that runs as your user can open it, read every
conversation and answer an ask. That includes a tool the agent runs.

The app has one defence against that, the descendant check. It refuses every act (an answer, a send, a
stop, a belt action, a rename, a close, a reopen or a starter) from itself and from any process below it in
the process tree, with `403 caller-refused`.
Reads stay open. To find the caller, the app reads its pid from the socket (`SO_PEERCRED`, through
`bun:ffi`) and walks the parent links in `/proc`. A caller whose process is gone, or whose chain of
parents breaks, is refused too. Collie's adapter reports the 403 as a refusal that names the code, and
never retries it ([`WIRE.md` section 3, error codes](../../bridge/mux/durable/WIRE.md#error-codes)).

The check has holes:

- **A process reparented to init gets through.** A tool that starts a background process and lets
  its parent exit (`setsid`, a double fork) leaves the tree: init or the user's service manager
  adopts it, and it is no longer below the app. The test "a process that left the tree" shows this.
- **Every other process of your user gets through.** A shell you open, another program, a user
  service, or anything that a tool asks one of these to run.
- **Anything that runs as you can read what you can read,** Collie's own state folder included.

So the check stops the simple case only. The real defence is a sandbox for the agent's tools: run them
as another user, in a mount or network namespace that cannot reach the socket, or behind a seccomp
filter on `connect`. This example does not sandbox its tools, because they are toys. An
`allow-always` option needs the most care, because one answer from a hostile process lets every later
call through without a question. This example offers only Allow and Deny.

The descendant check needs `/proc` and `SO_PEERCRED`, and of the systems Bun runs on, only Linux has
both. On another system the app refuses to start unless you set `DM_CALLER_CHECK=off`. With that
setting there is no defence at all, and any process of your user can answer. On Windows the app does
not start, because a socket there has no owner to check.

## Environment variables

Every variable is optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `COLLIE_DURABLE_SOCKET` | `$XDG_RUNTIME_DIR/durable-member/app.sock`, or `/tmp/durable-member-<uid>/app.sock` when `XDG_RUNTIME_DIR` is not set | Where the app listens. An absolute path of at most 103 bytes. Collie reads the same variable to find it. |
| `DM_DATA` | `$XDG_STATE_HOME/durable-member`, else `~/.local/state/durable-member` | The folder for the conversations (`store/`), the file `write_note` appends to (`notes.txt`) the names the phone gave a workspace or a tab (`titles.json`) the conversations the phone closed (`closed.json`) and the ChatGPT sign-in (`auth.json`). |
| `DM_CALLER_CHECK` | `descendant` | `off` turns the descendant check off. Needed on any system but Linux. |
| `DM_STEP_MS` | `400` | The pause before each scripted answer, so you can see the states change. |
| `DM_SLOW_MS` | `10000` | How long the scripted answer to a follow-up takes to write, so Stop has something to stop. The answer is long, and streams in chunks. |
| `DM_HELPER_MS` | the value of `DM_STEP_MS` | How long the helper's scripted answer takes. |
| `DM_ASK_TIMEOUT_MS` | `600000` (ten minutes) | How long the phone has to answer each question. The ask carries an `expiresAt`, so the phone shows the time left. Past it the question closes as timed out, the app logs it as a deny and goes on. |
| `REAL_MODEL` | not set | A model id of the provider's Pi catalog. Not set means the scripted model. |
| `REAL_PROVIDER` | `openrouter` | `openrouter` or `openai`. Read only when `REAL_MODEL` is set. |
| `OPENROUTER_API_KEY` | not set | Your OpenRouter key. Pi reads it only when `REAL_MODEL` is set. |
| `OPENAI_API_KEY` | not set | Your OpenAI key, for `REAL_PROVIDER=openai`. A ChatGPT sign-in stored in `auth.json` wins over it. |

## Write your own durable agent

The contract is [`WIRE.md`](../../bridge/mux/durable/WIRE.md). The decisions behind it are in
[ADR 0099](../../.adr/0099-a-durable-program-is-a-mux-with-no-screen.md) (the adapter),
[ADR 0100](../../.adr/0100-an-ask-travels-as-data-and-is-answered-by-id.md) (asks),
[ADR 0101](../../.adr/0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) (send and stop) and
[ADR 0102](../../.adr/0102-starters-are-launcher-rows.md) (starters).

The SDK is the package `@colliepwa/durable-sdk`, experimental, under the npm dist-tag `experimental`:

```sh
npm install @colliepwa/durable-sdk@experimental    # or: bun add @colliepwa/durable-sdk@experimental
```

The durable agents in this folder import the package's source from `../../packages/durable-sdk/src` instead, so they run
from a clone with no build. The code below, and the paths in the rest of this section, are the package's.

### Quickstart: one approval

```ts
import { openCollie, requireApproval } from "@colliepwa/durable-sdk"; // one import for Node and Bun

// The socket path comes from COLLIE_DURABLE_SOCKET, the same variable the Collie peer reads.
const collie = await openCollie({ hostName: "my-agent", caps: { asks: true } });
const pane = collie.workspace("main", { title: "Main" }).tab("chat", { title: "Chat" }).pane("run-1", { title: "Run 1", harness: "my-agent" });
collie.ready();

// Before the tool runs. The card shows the tool's name and its arguments, never the model's words.
const approval = await requireApproval("refund", { order: "5521", amount: 40 }, { pane, toolCallId: "call-1", timeoutMs: 10 * 60_000 });
if (!approval.approved) throw new Error(`refund not approved: ${approval.decidedBy} at ${approval.decidedAt}`);
```

`requireApproval` waits for Allow or Deny on the phone. It returns `approved`, and a receipt: `decidedBy` is
`phone`, `program` or `timeout`, and `decidedAt` is when. Only Allow from the phone approves. A timeout, a
`signal` that aborts, and `pane.decideAsk(askId)` (the durable agent decided it elsewhere) all return
`approved: false`; `pane.decideAsk(askId, { optionId: "allow" })` approves from the durable agent's side. A second tap
on the phone gets 409 `decided` with the first outcome, and nothing runs twice.

`caps` is the whole list: a cap you do not name is off. Leave `caps` out to turn on everything the SDK can do.

### The parts

The SDK imports nothing from Pi Durable outside its `./pi` entry, and a test checks that:

- `openCollie({ socket, hostName })` opens the socket and returns handles for workspaces, tabs and
  panes. Call `ready()` once every pane is shown, so Collie never sees a half-empty layout.
- A pane takes `event()` for items, `state()` for working and idle, and `ask()`, which resolves with
  the phone's answer. `onSend()` and `onAbort()` take the phone's text and Stop.
- An item `{ kind: "reply" | "thinking" | "notice" | "markdown", partial: true }` is text still growing: write the same
  `id` again as it grows (not faster than every 250 ms), and once more with the final text and no `partial`. A
  `{ kind: "user", requestId }` item names the send it came from (WIRE.md 7.15). The `./pi` entry does both.
- `ask()` takes `expiresAt` (a `Date` or an ISO string). Past it the ask closes as decided by `timeout`, and the
  `ask()` promise rejects with `AskClosed` whose `decidedBy` is `timeout`. `pane.decideAsk(askId, answer?)` closes
  an open ask as decided by the durable agent: with an answer the `ask()` promise resolves with it, without one it rejects.
- `subtitle(text | null)` sets one line under the title (at most 120 characters), and `badge({ count } | { text } | null)`
  a small mark next to it (a count from 0 to 9999, or at most 12 characters). Each raises `rev` only when the value changes.
- `event({ type: "item", item })` also takes `{ kind: "markdown", text }`, `{ kind: "code", lang?, text }` (the
  language is a plain name such as `ts`) and `{ kind: "link", href, label? }` (`href` is an `https://` address).
  A bad language or address is a `TypeError`, so the wire never carries what the adapter would drop.
- `progress({ kind: "steps", steps } | { kind: "percent", value, label? } | null)` says how far a working
  conversation is: up to 12 steps (`done`, `running` or `todo`), or a value from 0 to 100. The durable agent clears it
  when the run ends, and the phone draws it only while the pane works or waits.
- `starters()` lists what the phone can start from the New page.
- `hooks` gives each act the phone can send one named place, with a typed payload and the request id:
  `onSend(pane, { text, steer, turnId, requestId })`, `onAbort(pane, { turnId, requestId })` and
  `onRename({ kind, id, title }, requestId)`, `onClose({ kind, id, paneIds }, requestId)` and
  `onReopen({ id, paneId? }, requestId)`. Pass `hooks` to `openCollie` or `createCore`. The per-pane
  handlers (`pane.onSend`, `pane.onAbort`) stay the first choice, and a hook is the fallback for a pane that
  has none: a pane with neither is 409 `not-supported`. Every payload type is exported from the package (`src/core/types.ts`).
- The phone can give a workspace or a tab a new name (`rename` cap, on by default). The SDK sets the title and
  raises `rev`. `hooks.onRename` can keep the name, or return `false` to refuse it with 422. Set
  `caps: { rename: false }` to take no rename at all. The layout is made again on every start, so a durable agent
  that wants a name to outlive the process keeps it itself and uses it when it lays out: `app.ts` keeps the
  names in `titles.json` in its data folder, and the Cloudflare example keeps them in SQLite.
  A pane keeps the title the conversation gives it. The old top-level `onRename(target)` option still works
  for one release as an alias for `hooks.onRename`, without the request id.
- The phone can close a pane, a tab or a workspace (`close` cap, on by default). What a close means is your call:
  archive the conversation, delete it, end its run. `hooks.onClose` does that and keeps it, so a restart does not
  show it again, or returns `false` to refuse with 422. Returning nothing accepts. The SDK then removes the target
  and everything inside it from the layout, raises `rev`, and closes every open ask on those panes as `stopped`.
  Set `caps: { close: false }` to take no close at all. A repeat of a request id answers from the receipt and runs
  the hook once.
- `history(provider)` serves the durable agent's own record (WIRE.md 7.16, `history` cap): `provider.list(after, limit)`
  returns its conversations, open and closed, newest first, and `provider.items(id, after, limit)` the items of
  one, oldest first, or `undefined` for one it does not know. Each hands back its own cursor as `next`, at most
  512 bytes of printable ASCII. Once a provider is set, each pane's `sessionId` is its pane id; pass
  `sessionId` to `tab.pane()` to name another, or `null` when it cannot stay the same across a restart.
  The `./pi` entry has `piHistory`, which reads every entry of every Pi conversation and maps it with the
  same mapper as the live pane, and `app.ts` and the Cloudflare example use it.
- The phone can bring a closed conversation back (`reopen` cap, on by default). `hooks.onReopen({ id, paneId? },
  requestId)` shows it again under the same pane id, or returns `false` to refuse with 422. Without a hook the SDK
  puts back a pane it closed in this process. `app.ts` takes the id off `closed.json` and shows it, and the
  Cloudflare example deletes it from its archive table. Set `caps: { reopen: false }` to take no reopen.

The SDK has two parts. `./core` (`src/core/`) is the layout and the wire as one function, `handle(request)`: a web
`Request` in, a `Response` out. It cleans every string and cuts it to its byte cap, and keeps the request ids
so a repeat runs once, in a `ReceiptStore` you can swap for one that outlives the process. The store keeps
the newest 1000 per pane; a repeat of an older id gets a 500, an unknown outcome, and runs nothing. It imports no
runtime module, so the same core serves the
[Cloudflare example](../../experiments/durable-member-cloudflare/README.md) (parked under experiments) from a Durable Object. `src/server.ts` is the
transport for Bun: the private socket and the descendant check. It accepts connections with `Bun.listen`
and parses them with `node:http`, because only a `Bun.listen` socket gives the file descriptor that
`SO_PEERCRED` needs. `Bun.serve({ unix })` shows no peer. `src/http.ts` is that `node:http` part on its own:
`wireListener(core)` is a request listener for any `node:http` server, and a host that serves web requests
itself passes `core.handle` straight to it. Closing the server lets the replies in flight go out first, for
at most 2 s.

`./node` (`src/node/index.ts`) is the same `openCollie` for Node 22.19 or later, and the root import picks it on Node. It
listens with `node:http` on the same private socket. It cannot run the descendant check, because Node cannot
read the caller of a socket, and it writes one line at start that says so (WIRE.md 1A). Run the agent's tools
in a sandbox that cannot reach the socket.

`./pi` (`src/pi/index.ts`) is the glue for Pi Durable. It shows a conversation as a pane, turns a risky tool call
into an ask, and runs a helper conversation as a tool. It imports nothing from this example: the words it
shows (the two questions, the items under a solved ticket) come in as options. It is written against
`@earendil-works/pi-durable` 1.1.0, because it uses `entries({ order })` and `scanConversations`; on 1.0.x
it does not type-check. `pi-durable/index.ts` is the old path, kept: it binds this example's words from
`script.ts` to the helper. `script.ts` is the scripted model. A durable agent on another framework writes its own
glue against the same handles. `app.ts` puts the parts together.

## Test

```sh
bun run typecheck
bun test
```

The suite covers `hello.ts` (it puts one ask on the wire, and the answer ends it), the pins of the Pi packages,
the socket rules, the hello, the request ids, the cleaning and the caps, the
descendant check, a whole ticket, and restarts with real kills. The protocol tests run twice, over the
socket and straight against the core. It needs no key and makes no network
call. From the root of collie, `bun test bridge/mux/durable/example.test.ts` starts the desk, and
`bun test bridge/mux/durable/example-hello.test.ts` starts `hello.ts`; both are driven by Collie's own adapter.
