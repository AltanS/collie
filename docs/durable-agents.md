# Durable agents (experimental)

> **Experimental.** The wire, the SDK and this page may change, or the feature may be removed, in a
> later minor release. Today only Collie's own examples speak the wire. [The exit](#the-exit) says
> what decides whether it stays. If you attach no durable agent, Collie looks and works as before.

If you built a durable agent with Pi Durable, with Vercel's durable-harness, or any program that serves
the wire, Collie can show it on your phone. It gets approval prompts, history and a chat view without any UI code.

A durable agent is one place a [session](sessions.md) can come from, and each of its conversations is one
session. The words are in [Terminology](terminology.md). Collie holds no model key: a durable agent uses
its own API key or a ChatGPT sign-in, and an Anthropic subscription may not be used through a
third-party harness.

## Quickstart

A ten-line durable agent, one `collie durable attach`, and a question card on your phone.

You need Collie 1.22.0 or later running on this machine, with your phone paired
([Install](install.md)).

A durable agent runs on Linux or macOS, with Node 22.19 or later or Bun 1.4 or later. Install the SDK in
your durable agent's folder:

```bash
npm install @colliepwa/durable-sdk@experimental
# or
bun add @colliepwa/durable-sdk@experimental
```

The package is published under the npm dist-tag `experimental`, never `latest`, and it follows the
exit in [ADR 0104](../.adr/0104-a-program-is-a-session.md): if the durable wire goes, the package
is deprecated ([ADR 0105](../.adr/0105-the-durable-sdk-is-an-npm-package.md)).

The SDK's Pi Durable entry is tested with Pi Durable 1.1.0 and 1.2.0. Node 22.19 is the floor of
Pi Durable 1.2.0.

Save this durable agent as `hello.mjs`. It is ten lines:

```js
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

Run it with `node hello.mjs` or `bun hello.mjs`. It prints
`listening /run/user/1000/hello/app.sock` and waits. The same durable agent is
`examples/durable-member/hello.ts` in a clone of Collie.

On Node it first writes one more line: Node cannot read who connects to the durable agent's socket, so
any process of your user can answer its question. Bun on Linux can, and refuses an answer from the
durable agent itself or from a process it started.

On macOS, run it with Node. Bun there needs `callerCheck: "off"`, which this durable agent does not set.
macOS has no `XDG_RUNTIME_DIR`, so set `COLLIE_DURABLE_SOCKET` to an absolute path first.

In a second terminal, attach it to your Collie, then restart so Collie reads the new entry:

```bash
collie durable attach hello --socket /run/user/1000/hello/app.sock
collie restart
```

Use the path your durable agent printed. Add `--restart` to the first command to restart in the same
step. `--restart` restarts the Collie bridge: your phone reconnects in a few seconds, and your
terminal sessions keep running.

Open Collie on your phone. A Durable agents section shows one row, `hello`, with an Experimental badge and
one question waiting. Tap the row: it opens on the durable agent's conversation list, where the
conversation Deploy waits with "Deploy to staging?". Open it and tap Yes or No. The durable agent prints
your answer and exits.

To write a durable agent of your own, read [The durable SDK](durable-sdk.md) and
[The durable wire](durable-wire.md).
To show an agent built on durable-harness, see
[A durable agent on durable-harness](#a-durable-agent-on-durable-harness).

## A durable agent on durable-harness

If your durable agent runs on Vercel's `durable-harness`, one wrapper and one route put it on your phone.

> **Experimental.** This path is tested self-hosted, in one Node process on a local World. It is untested
> on Vercel: no preview deployment has run it yet. Until one has, treat Vercel as a plan, not
> as a promise. The entry is `@colliepwa/durable-sdk/durable-harness`, and it serves a Pi agent only. A stop ends the turn, but a tool that is already running finishes and does its work.

[durable-harness](https://www.npmjs.com/package/durable-harness) keeps a Pi agent's state in a log it
calls a World. The agent has no process of its own to dial. So the route reads the log on every request,
answers, and keeps nothing. Two instances behind one URL give the same answer. The questions, the answers
and the request ids go in a second log beside each session, called the journal.

There are two parts. `withCollie` wraps the function that opens your Harness, so a risky tool call asks
your phone first. `collieRoute` is the web route that Collie dials. Both read the same World.

The SDK pins `durable-harness` 0.0.1-beta.6 and `@workflow/world` 5.0.5 exactly, and tests them with
`@workflow/world-local` 5.1.2 and Pi 1.2.0. The route checks both versions on its first request. When
either differs, every request answers 500 with one line that names the two versions.

### Self-hosted

One Node process runs the agent, the queue and the route. You need Node 22.19 or later, and the Pi
packages your agent already uses.

1. Install the SDK and its pinned peers:

   ```bash
   npm install @colliepwa/durable-sdk@experimental durable-harness@0.0.1-beta.6 \
     @workflow/world@5.0.5 @workflow/world-local@5.1.2
   ```

2. Make a token of 32 random bytes and keep it in the environment:

   ```bash
   export COLLIE_TOKEN="$(openssl rand -hex 32)"
   ```

3. Wrap your opener, and make the route. Save this as `collie.js`:

   ```js
   import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
   import { Harness } from "@earendil-works/pi-durable";
   import { collieRoute, withCollie } from "@colliepwa/durable-sdk/durable-harness";
   import { resumeWith } from "durable-harness/pi-durable";
   // Your models, and the registry that holds your tools.
   import { models, registry } from "./agent.js";

   const open = withCollie(
     (storage, reg) => Harness.open(storage, { models, registry: reg }, ctx),
     { registry, risky: new Set(["deploy"]) },
   );
   export const opener = resumeWith(open);
   export const collie = collieRoute({ open: opener, token: process.env.COLLIE_TOKEN });
   ```

4. Serve the route from the same process that runs the agent. Save this as `server.js`:

   ```js
   import { createServer } from "node:http";
   import { getWorld } from "durable-harness";
   import { collie } from "./collie.js";

   // On a local World this starts the queue in this process.
   await getWorld();
   createServer(async (req, res) => {
     const chunks = [];
     for await (const chunk of req) chunks.push(chunk);
     const headers = new Headers();
     for (const [k, v] of Object.entries(req.headers)) {
       if (typeof v === "string") headers.set(k, v);
     }
     const init = { method: req.method, headers };
     if (chunks.length > 0) init.body = Buffer.concat(chunks);
     const reply = await collie(new Request(`http://localhost${req.url}`, init));
     res.writeHead(reply.status, Object.fromEntries(reply.headers));
     res.end(Buffer.from(await reply.arrayBuffer()));
   }).listen(8080, "127.0.0.1");
   ```

   Your own chat route starts sessions as before, with `opener`.

5. Start it with the local World:

   ```bash
   WORKFLOW_TARGET_WORLD=local WORKFLOW_LOCAL_DATA_DIR=.workflow-data node server.js
   ```

6. Attach it to your Collie, then restart:

   ```bash
   collie durable attach desk --url http://127.0.0.1:8080/collie --token-env COLLIE_TOKEN
   collie restart
   ```

Open Collie on your phone. The row `desk` shows one conversation for each session of the agent. When the
agent calls a tool in `risky`, a card asks you first, and the tool runs only after you tap Allow.

The route must run in the process that runs the queue. A local World keeps its queue in the memory of
one process. A send that a second process writes is never picked up, until the first process restarts.

### On Vercel

The same code is meant to run as a function with Vercel's World in place of the local one. Nothing has run on
Vercel yet. The steps appear here after one preview deployment has attached, listed a session, answered one card and
sent once the session was idle.

What it rests on, untested:

- The queue is shared between functions, so a send from any function reaches the session.
- The World identity (the project and environment) is the same for every function of one deployment, so the epoch is stable.
- A function's maximum duration is longer than the time a question waits. Otherwise the silence rule hands the session to a new function after 120 s, which reruns the hook.
- A stop's takeover commits before the function returns.

### What the phone can do

Read, answer, send when idle, stop, and read the history. Nothing else.

| the phone can | how it works here |
| --- | --- |
| Answer a question | The guard writes the question in the journal. Your tap writes the answer there. The tool runs only on an Allow for the same arguments |
| Send text | Only while the session is idle. The route takes the session over, submits the text and lets go. While the agent works, the phone does not offer Send |
| Stop | The route takes the session over and aborts it. Every question the turn left open closes as decided by the agent. Nothing resumes the turn |
| Read history | Every run of the agent is a conversation. A run that ended is a closed one |

Anything that can write the run's journal stream in the World can write an answer, so write access to the World is approval authority; the bearer token guards the route, not the World, and the guard is not a sandbox: a tool not named in `risky` runs without asking.

Steer, rename, close, reopen, belt buttons and starters are off. A conversation that the World drops
by its retention rule leaves the list.

> **Caution.** A stop does not kill a tool that is already running. The old process keeps going to the
> end of the tool and does its side effect, while the log says the tool was aborted. A tool that has
> started cannot be called back. A process that was killed while a tool ran is different: the next start does not run that tool again.

### Why a question waits in the log

A question must survive a crash, a takeover and a new function, so the guard keeps nothing in memory.

On every run of a risky call the guard reads the journal. It writes the question only when the journal
has none for this call. Then it reads the journal again, after 1 s, then 2 s, 4 s, and every 5 s, until
you answer, the question expires or someone stops the turn. A rerun of the call finds its own question
and waits for the same one, with the same expiry. A read that fails while it waits is tried again at the next wait, and never decides the call. If the first read fails, the call is blocked and nothing is written.

durable-harness's `recoverAfterMs` is the silence after which a new process may take a session over. It belongs to
each open, and its default is 120 s. While the hook waits, the session writes nothing, so on Vercel a
new function may take the session after 120 s and rerun the hook; the spike proved this on a local World after a restart, not on Vercel. The rerun keeps the same tool call id. A restart
of a self-hosted process does the same at once. The
question stays one question. If you pass a shorter `recoverAfterMs` to your open, a second live process
can take the session from a live owner. Keep the default.

Add `timeoutMs` to `withCollie` to give the phone a deadline. Past it, the question closes as timed
out and the call is blocked.

### What it costs

An open phone asks every 2 s and an idle one every 10 s. Each ask is one call to your route.

| | rate | per hour | per day |
| --- | --- | --- | --- |
| A phone that watches | one call every 2 s | 1,800 | 43,200 |
| A phone that does not | one call every 10 s | 360 | 8,640 |
| One waiting question | one journal read every 5 s, after the first 7 s | about 720 | |

The first two rows are arithmetic on the poll intervals, and the third on the guard's waits. None is a
measured bill. Each call reads the list of runs and one journal for each open session from the World.

What the spike measured, on a local World, with nothing cached: one session of 200 entries reads in
96 ms at p95. Ten such sessions read in 988 ms at p95. The cost follows the number of events in a
session, not its entries, because a streamed reply commits many partial events. Nothing is measured on
Vercel. Check what your plan allows for the calls above.

## Attach a durable agent

Each durable agent is one entry in `sources.json`, and `collie durable attach` writes it.

```bash
collie durable attach desk --socket /run/user/1000/desk/app.sock
export EDGE_TOKEN=your-32-byte-random-token-here
collie durable attach edge --url https://edge.example.com --token-env EDGE_TOKEN
collie restart
```

On Windows only the HTTPS form is available: `attach --socket` refuses with exit code 2 and says to use
`--url` and `--token-env`, because a private socket needs Unix user ids.

`sources.json` sits in the config folder beside your `.env`: the Herdr plugin config folder
(`~/.config/herdr/plugins/config/herdr.collie/`) on a Herdr-managed install, else
`~/.config/collie/`. `attach` prints the path it wrote. The two commands above write this file:

```json
[
  { "name": "desk", "kind": "durable", "socket": "/run/user/1000/desk/app.sock" },
  {
    "name": "edge",
    "kind": "durable",
    "url": "https://edge.example.com",
    "token": "your-32-byte-random-token-here"
  }
]
```

| field | what it holds |
| --- | --- |
| `name` | The durable agent's name on the phone and the name of its log folder. 1 to 32 characters: lower case letters, digits and hyphens, starting with a letter or a digit. Unique in the file |
| `kind` | `durable`, the one kind today |
| `socket` | The absolute path of the durable agent's private Unix socket on this machine. Not with `url` |
| `url` | The address of a durable agent you deployed behind TLS. Not with `socket`, and always with `token` |
| `token` | The bearer token Collie sends to `url`. Only with `url` ([Tokens](#tokens)) |

The bridge reads the file at start, so an entry takes effect after a restart. Your terminals look
and work as before, beside the durable agents.

Collie is strict about the file, because a durable agent it skipped in silence would never appear:

- **A field the table does not name stops the bridge.** So does a wrong `kind`, a name that breaks
  the rule, a name used twice, both `socket` and `url`, neither, or a `url` with no `token`.
- **A bad file stops the bridge at start with one line.** The line starts `[bridge] FATAL:` and
  names the entry and the field. `collie logs` shows it. `attach` and `detach` also refuse to
  overwrite a file they cannot read, so a typo never costs your other entries.
- **The file is held at mode `0600`.** `attach` writes it that way. When the file is wider, the
  bridge tightens it at start and says so in its log.
- **A name may not be your terminal session's.** That is `default` on most installs, and on a
  durable-only instance `default` is the name of its own durable agent. The bridge stops at start and names the
  entry.
- **A durable agent keeps its name against a Herdr session.** When a Herdr session has the name of a
  durable agent, the phone shows the durable agent, hides that Herdr session, and the log says so once.

`attach` checks the socket path, the URL and the token by the rules below. An entry written by hand
is checked when the bridge reaches the durable agent: a broken rule then shows the durable agent as unreachable
with the reason.

### Two ways to reach a durable agent

| | private socket | https with a token |
| --- | --- | --- |
| Where the durable agent runs | this machine, as your user | anywhere you deploy it |
| What keeps others out | the socket is yours, mode `0600` | the token, and only the token |
| Who can act as your phone | any process of your user | anyone who has the token |
| How often Collie asks | every 1 s while a phone watches, else every 3 s | every 2 s while a phone watches, else every 10 s |

The socket transport is for Linux and macOS. On Windows use the URL and the token. The socket path
must be absolute and at most 103 bytes. Keep it under `$XDG_RUNTIME_DIR`, not `/tmp`: the Collie
service on Linux runs with a private `/tmp`.

Collie connects to a socket only when the whole path is private, because the socket carries no
token. The socket is yours with no group or other permission. Its folder is yours with mode `0700`.
No part of the path is a symlink, and no folder above it is writable by group or other, except a
sticky one such as `/tmp`. The SDK makes the socket's folder with mode `0700` when it is not there.

The URL must start with `https://`. The one exception is `http://127.0.0.1:<port>` or
`http://localhost:<port>`, with a port, for a durable agent on the same machine. Collie refuses any other
`http://` address, because the token would cross the network unencrypted.

> **Caution.** Over https the token is the only gate. Anyone who has it can read every conversation
> and answer every question, and the host sees the text. A durable agent reached this way should offer
> Allow and Deny only, never an always-allow.

[Durable agents security](durable-agents-security.md) says what a durable agent can do and what Collie logs.

Every poll over https is a request that your host may bill, and a "nothing changed" answer counts
too. With no phone open the idle poll runs every 10 s, so Collie asks 8,640 times a day. Check what
your host's plan allows for that.

A durable agent behind a URL must serve the Collie wire and check the bearer token. A stock Pi Durable
demo does neither, so Collie cannot attach it as it is.

Collie polls a hosted durable agent. It asks every 2 s while a phone watches, else every 10 s. Each poll
wakes a hibernating Durable Object, so a hosted object stays awake while Collie watches. The wire
has no WebSocket, so the hibernation and WebSocket features of Durable Objects do not help here.

The Cloudflare example is parked and is not part of a release. It is in
`experiments/durable-member-cloudflare/`.

## The three verbs

`attach`, `detach` and `list` change or read `sources.json`, and they restart nothing unless asked.

```bash
collie durable attach <name> --socket <path> [--restart]
collie durable attach <name> --url <url> --token-env <VAR> [--restart]
collie durable detach <name> [--restart]
collie durable list
```

| verb | flags | what it prints | exit code |
| --- | --- | --- | --- |
| `attach <name>` | `--socket <path>`, or `--url <url>` with `--token-env <VAR>`. `--restart`. A flag takes its value as the next word or after `=` | `added <name> in <path>`, or `updated <name> in <path>` for a name already there. Then `restart to apply: collie restart` and the URL to open on your phone | `0` written. `2` a usage error, or a path, URL or token that breaks a rule. `1` the file cannot be read. With `--restart`, the code of the restart |
| `detach <name>` | `--restart` | `removed <name> from <path>`, then `restart to apply: collie restart` | `0` removed. `2` a usage error. `3` no durable agent by that name. `1` the file cannot be read. With `--restart`, the code of the restart |
| `list` | none | One line per durable agent: its name, `socket <path>` or `url <url> (token set)`, and its state. `no durable agents attached (<path>)` when the file is empty or missing | `0`. `1` the file cannot be read |

`collie durable` with no verb, or with an unknown one, prints the usage and exits `2`. With
`--restart`, `attach` and `detach` run the same restart as `collie restart`.

`list` asks the running bridge about each entry and waits at most 3 s for it:

| state | what it means |
| --- | --- |
| `loaded` | The running bridge has loaded this entry. It is the bridge's word, not the durable agent's: the durable agent may still be unreachable. `collie doctor` asks the durable agent |
| `not loaded (restart to apply)` | The bridge started before you attached it. Run `collie restart` |
| `refused (<status>)` | The bridge answered with this HTTP status instead of a state |
| `bridge not answering` | No answer within 3 s: Collie is stopped, or busy. `collie status` shows whether it runs |

When a durable agent does not appear, run `collie doctor`, which names the failing check. The three usual
causes are an entry not loaded yet (restart), a socket that is not private (`socket-not-private`),
and a stale socket file left by a crash (`connection refused`: delete it and start the durable agent).
[Durable agents troubleshooting](durable-agents-troubleshooting.md) covers the durable agent cases.
[Troubleshooting](troubleshooting.md) covers Collie as a whole.

## Tokens

A `url` entry carries its token, and the token is the whole gate.

```bash
openssl rand -hex 32
```

The result is 64 hex characters, above the 32-byte floor.

Make the token 32 random bytes or more, as above, and give the durable agent the same value. `attach`
reads it from the variable that `--token-env` names, so it is in no command line and no shell
history. That variable must be set when you run `attach`.

`attach` copies the value into `sources.json` in plain text. The file is therefore as secret as the
token: Collie holds it at mode `0600`, and a backup or a sync of the config folder carries the
token. Collie sends the token with every request, and never prints it: `list` says `(token set)`.

| | the rule |
| --- | --- |
| Token | 32 to 4096 bytes after trimming, printable ASCII with no space |
| URL | `https://`, or `http://127.0.0.1:<port>` or `http://localhost:<port>` with a port. At most 2048 bytes. No user name or password, no query, no fragment. The durable agent's base only: Collie adds `/session/v1` itself |

The token does not expire. To change it, re-run `attach` with the same name and the new token, then
restart:

```bash
export EDGE_TOKEN=your-new-32-byte-random-token-here
collie durable attach edge --url https://edge.example.com --token-env EDGE_TOKEN
collie restart
```

`attach` prints `updated edge`. Give the durable agent the new token before you restart Collie, or the
phone says the durable agent refused the token. A durable agent may accept a second token while a rotation
runs, so neither side is locked out. The parked Cloudflare example takes `COLLIE_TOKEN` and, while
it is set, `COLLIE_TOKEN_NEXT` ([ADR 0103](../.adr/0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md)).
Set the new token as `COLLIE_TOKEN_NEXT` on the durable agent, re-run `attach` and restart Collie, then
move the value to `COLLIE_TOKEN` and unset `COLLIE_TOKEN_NEXT`.

## A durable agent alone in one Collie

An instance with no terminal, such as a Windows host or a hosted durable agent, can drive one durable agent
from its `.env`.

```bash
# a durable agent on this machine, as you
COLLIE_MUX=durable
COLLIE_DURABLE_SOCKET=/run/user/1000/durable/session.sock

# or a durable agent you deployed behind TLS
COLLIE_MUX=durable
COLLIE_DURABLE_URL=https://durable-member.example.com
COLLIE_DURABLE_TOKEN=your-32-byte-random-token-here
```

Such an instance names its durable agent `default`, and that durable agent is its primary session. Entries in
`sources.json` still run beside it, under other names.

| `.env` | `config.toml` | what it holds |
| --- | --- | --- |
| `COLLIE_MUX=durable` | `[mux] mux` | Makes this instance durable-only |
| `COLLIE_DURABLE_SOCKET` | `[mux] durable_socket` | The durable agent's private socket. Not with the URL |
| `COLLIE_DURABLE_URL` | `[mux] durable_url` | The durable agent's address behind TLS. Always with the token |
| `COLLIE_DURABLE_TOKEN` | `[mux] durable_token` | The bearer token for the URL. A file holding it must be mode `0600` |

Set the socket, or the URL with its token, never both. Both set, a URL without a token, or a token
without a URL is a config error: Collie starts, names the error in its log, and shows the durable agent as
unreachable with that reason.

An older build kept a durable-only instance's logs directly in `<state>/durable/`. At the first
start of this build they move once into `durable/default/`, with one line in the log.

To change the token, deploy the new one to the durable agent, set it in the `.env`, and run
`collie restart`. A durable-only instance joins a [crew](crew.md) under its host name, so give it a
name with `collie crew join <lead-address> --label durable` when it shares a host with the lead.

To turn every durable agent from `sources.json` off for a while, set `COLLIE_PROGRAMS=off` in the `.env`
and run `collie restart`. The bridge then ignores the file, logs one line, and runs as an install
with no durable agents, so the phone shows no Durable agents section. `collie doctor` and `collie durable list`
say that durable agents are off. The file stays as it is: unset the variable and restart to bring the
durable agents back. The variable does not touch the old env form above.

## Where Collie keeps a durable agent's data

The durable agent keeps the record of its conversations. Collie keeps a cache, its receipts and its push
memory in its state folder.

The state folder is `~/.local/state/collie/`, or `COLLIE_STATE_DIR` when that is set. `<program>` is
the name in `sources.json`, or `default`. Each durable agent's folder is mode `0700`, and each log is
mode `0600`.

| file | what it holds | how long |
| --- | --- | --- |
| `durable/<program>/<id>.jsonl` | Chat's copy of one live conversation, with `<id>` the conversation's id in base64url | Past 8 MiB it is cut to the newest 2000 messages. All the logs together stay under 256 MiB: the oldest conversation goes first, with one line in the log |
| `durable/<program>/<id>.cursor.json` | Where Collie stopped reading, so it goes on there after a restart | As long as its log |
| `answer-receipts.json` | Each answer a phone sent: its request id, the ids it answered and the outcome. No typed text | A week, at most the newest 1000. An answer still on its way stays at least a day |
| `control-receipts.json` | Each send, steer, stop and belt action: its request id and the outcome. The text only as a digest | As above |
| `starter-receipts.json` | Each starter tap and the conversation it opened | As above |
| `durable-asks.json` | Which questions were pushed already, by host, durable agent and tool call, so a restart pushes nothing twice | An hour after the question closed. At most 2000 |

The cache is why Chat opens fast and works while the durable agent is slow. A closed conversation is
always read from the durable agent, never from the cache.

A durable agent keeps only the newest part of a long conversation. When it has dropped the start of a
conversation before Collie read it, Chat shows one line in its place: "Older messages were left
out: the durable agent no longer keeps them." Nothing on your phone was lost: Collie never had those
messages.

## What the phone shows

A Durable agents section on the dashboard, and for each durable agent a list of its conversations.

Each durable agent is one row in the Durable agents section, with its name, an Experimental badge, its runtime
and whether it runs here or elsewhere. On the right it counts its open conversations and, in the
needs-you colour, those that wait on you. The section moves above your spaces while a question
waits. A durable agent that is starting or unreachable says so in place of the counts. A refused token
and a refused wire version have their own words on the phone; `collie doctor` names every other
reason.

Tap a row to open the durable agent's conversation list, like the chat list of a messaging app. What waits
on you comes first, then the other open conversations, then the closed ones under the label Closed.
An open one opens in Chat, and a closed one opens read-only. A durable agent says in its hello what it can
do (`asks`, `starters`, `send`, `steer`, `abort`, `rename`, `close`, `actions`, `history`,
`reopen`), and the phone draws a control only for what it said. A durable agent has no screen, so it has
no Terminal view and no typed keys.

On a send to a durable agent, the label queued is Collie's own reading of the turn. Collie does not show
what waits in Pi's inbox. A task that sleeps until a deadline shows as idle or working, never as
waiting. [Sessions](sessions.md#what-the-phone-shows) has more.

A question card names the durable agent and shows the time left when the durable agent set one. A question
decided in the durable agent, or timed out, leaves a line in the chat.
[Durable agents on the phone](durable-agents-on-the-phone.md) shows each of these with a figure.

## Send and Ask through the bridge

A durable agent has no screen, so Collie reads no screen for it. The bridge reads its own state
instead. A durable agent gets the same Send and Ask as a terminal pane.

- **The state.** The turn comes from its pane state. A question comes from its oldest open
  ask. The input box is always empty, because a durable agent has no box. The phone gets this state with
  each pane, in the same shape as for a terminal pane.
- **A send.** `POST /api/send` takes a request id from the phone. The bridge writes the request to
  disk and locks the conversation. Then it sends the text to the durable agent once, for the turn it read.
  Its answer is the proof, and the receipt names the request id it took. During a
  turn the durable agent keeps the text for after that turn, and the receipt says `queued`.
- **The outcomes.** A send ends `sent`, `refused` with a reason, or `unknown`. `unknown` means the
  durable agent did not say it took the text. Read the chat before you send it again. A send becomes
  `effective` when the durable agent writes it into the conversation. Its `user` item names the
  request id of that send. A plain send is refused while any question is open, even one Collie
  cannot read. Answer the question, or use Steer or Stop. A turn that started after you looked
  refuses the send, and nothing reaches the durable agent.
- **A question.** `POST /api/ask/<id>` answers it. The ask id is for one use only. The answer carries
  the hash of the question you saw. The bridge compares it with the question the durable agent lists now. When the two differ, nothing reaches the durable agent.
  The reply shows the question as it is now. The answer goes to the durable agent by its own ask id. No key is ever sent. The receipt
  says `channel: program` and keeps the hash.
- **What stays on the card.** Some questions do not fit one tap, so the state shows them as a
  question Collie cannot read (`modal: unreadable`). You answer them on its own card.
  - A text question stays on the durable agent's own card, because the answer is a line you type.
  - A choice of several stays on the durable agent's own card, because the answer is more than one pick.
  - A form stays on the durable agent's own card, because the answer is a set of fields.
  - Always allow is never a contract option. Its grant lasts after this question. So the durable agent's
    card asks for a second tap first, and one tap through `/api/ask` must not skip that tap.
- **The counters.** `collie doctor` counts these reads and outcomes in one row, `program`.

On this machine the phone uses these routes. A plain send goes through `/api/send`, and a tap on the
question card goes through `/api/ask`. The composer tells the outcome at the thumb in the durable agent's
words. When a question blocks the send, a button goes to its card. The pane's Recent sends list
shows each receipt, and a queued send says so. Steer and Stop stay on the conversation's own routes,
because a steer is not part of the Send Protocol. A durable agent on a crew member keeps the
conversation's own routes for all writes. Each route checks the turn before the text reaches the
durable agent. All writes to one conversation share one lock. While a send runs, Steer and a
card answer are refused as busy. Stop waits for the lock, at most until its time limit, so a send
that hangs never keeps Stop out.

## Versions

Collie and a durable agent agree on a wire version in the hello, and today there is one: version 1.

Collie speaks `1..1`. When a version 2 ships, Collie will accept version 1 for one minor release
after it, and the minor after that drops it. Today there is no previous version to accept.

When the two ranges do not meet, Collie reads nothing more from the durable agent. Its log gets one line
for each range it refuses, such as
`[durable] The durable agent speaks wire v2, this Collie speaks v1. Update Collie, or the agent's SDK.` The home
of the durable agent on the phone shows the same sentence in a caution box, and its row on the dashboard says Version
mismatch in place of Unreachable. `collie doctor` shows both ranges on its `durable-hello` row:
`incompatible: the durable agent speaks 2..3, this Collie speaks 1..1`. Once per start of the durable agent, Collie
also sends it one `hello` with its own version, so the durable agent can log the mismatch on its side.
Update the older side.

## The exit

The feature stays only if someone outside this repository uses it.

By the 1.24.0 release, one of two things must be true: a public repository that speaks the wire
exists, or an outside issue or discussion about a durable agent exists. If neither does, the
durable code moves out of the release into `experiments/`, and this page goes
([ADR 0104](../.adr/0104-a-program-is-a-session.md#the-exit)). On removal, a `sources.json` entry is ignored with one log line for one release, the socket keeps
working for your durable agent, and the npm package is deprecated, not deleted
([ADR 0105](../.adr/0105-the-durable-sdk-is-an-npm-package.md#the-exit)).
