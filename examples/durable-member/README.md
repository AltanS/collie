# Durable member: a Pi Durable program in your crew

A small Bun program built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).
It triages made-up support tickets with a scripted model and shows each conversation to Collie over
the durable socket wire. A Collie peer with `COLLIE_MUX=durable` lists those conversations as panes,
so you can read them on the phone and answer their questions there. The wire is experimental and may
change in any minor release of Collie ([`WIRE.md`](../../bridge/mux/durable/WIRE.md)). This folder is
example code to read and copy. It is not a package.

## Run it

You need Linux and Bun 1.4 or later. From a clone of collie:

```sh
cd examples/durable-member
bun install --frozen-lockfile
bun run app
```

The app prints the socket it listens on, for example
`listening /run/user/1000/durable-member/app.sock`. It needs no key and no settings. Without a real model
it says so on the next line: "Using the scripted model. Set REAL_MODEL and OPENROUTER_API_KEY for a real
one." See [A real model](#a-real-model).

On the first start the app opens one ticket. The scripted model asks to run `write_note`, and the
ticket waits for your answer. The app keeps its conversations in `~/.local/state/durable-member/`, so
the next start shows them again. Delete that folder to start over. Stop the app with Ctrl-C.

The app installs on its own. The collie root install does not pull in Pi Durable, and this folder
has its own `bun.lock`. Pi Durable, `chord` and `pi-ai` are pinned to exact versions.

## Point a Collie peer at it

A peer is one Collie instance, and one instance mirrors one backend. So the durable program needs a
peer of its own, even on a host that already runs Collie with Herdr. The peer needs two settings:

```sh
COLLIE_MUX=durable
COLLIE_DURABLE_SOCKET=/run/user/1000/durable-member/app.sock   # the path the app printed
```

On a host that already runs Collie, make a second instance with its own port and state folder, in
`~/.config/herdr/plugins/config/herdr.collie-durable/.env`:

```sh
COLLIE_INSTANCE=durable
COLLIE_PORT=8795
COLLIE_STATE_DIR=/home/you/.local/state/collie-durable
COLLIE_MUX=durable
COLLIE_DURABLE_SOCKET=/run/user/1000/durable-member/app.sock
```

Then run `COLLIE_INSTANCE=durable collie start`. `COLLIE_INSTANCE=durable collie doctor` checks the
socket and says what is wrong when the peer cannot reach the app. The full steps are in
[Multiple Collie instances on one host](../../docs/deployment.md#multiple-collie-instances-on-one-host),
and what the `durable` backend can do is in [durable notes](../../docs/multiplexers.md#durable-notes).

Run the peer as the same user as the app. Keep the socket under `$XDG_RUNTIME_DIR`: the Collie service
runs with a private `/tmp`, so it cannot see a socket in `/tmp`.

## Join the crew

Join the peer to your crew like any other machine: `collie crew invite` on the lead, then
`collie crew join` on this host with `COLLIE_INSTANCE=durable` set. The commands and their flags are in
[Crew commands](../../docs/crew.md#two-machines-one-crew). The peer then shows up in the list as a
machine of its own, beside your Herdr peer. With no crew, pair the phone with this instance directly.

A member's name defaults to the host name. If this host already runs the lead or a Herdr peer, name
the durable peer so the host chip can tell them apart:
`COLLIE_INSTANCE=durable collie crew join <lead-address> --label durable`. (`collie crew rename`
names the crew, not a member.) A lead older than 1.21.0 lists the pane but shows no ask card, only
"needs you". Update the lead first.

## What you see on the phone

- **The conversations.** The workspace is "Triage". Tickets are in the tab "Inbox", and the helper a
  ticket starts is in the tab "Helpers".
- **Chat only.** A conversation has no terminal, so there is no Terminal view and no typed keys.
- **The ask.** A card under the `write_note` step offers Allow and Deny. Allow writes one line to
  `notes.txt` in the data folder, a helper answers, and the ticket ends with a reply. Deny blocks the
  tool, and the ticket stops there. Only your tap answers. The app never answers its own ask.
- **Send, steer and Stop.** Text sent to an idle ticket starts a new turn. The scripted answer to a
  follow-up takes ten seconds, so you have time to steer it or press Stop. Stop ends the turn, and
  Chat shows a short "stopped" note.
- **Starters on the New page.** "New triage" opens another ticket. "Two notes at once" makes the
  model ask two questions at the same time.

## A real model

The scripted model is the default. To use a real model, set an OpenRouter model id and your key:

```sh
export OPENROUTER_API_KEY=sk-or-v1-your-key-here
REAL_MODEL=google/gemini-3.1-flash-lite bun run app
```

The id must be one that Pi's OpenRouter catalog knows, or the start stops with an error. Pi reads the
key, and the app never prints it. Every ticket now costs tokens, including the one a first start
opens. A real model may not follow the script, so a ticket can take a different path.

## The trust model

The socket keeps out other users. The app makes it mode `0600`, in a folder with mode `0700`, both
owned by you. There is no token and no TCP. Before each connect, Collie checks every folder on the
path and the socket itself ([`WIRE.md` section 1A](../../bridge/mux/durable/WIRE.md#1a-a-private-socket)).

The socket does not keep out you. Any process that runs as your user can open it, read every
conversation and answer an ask. That includes a tool the agent runs.

The app has one defence against that, the descendant check. It refuses an answer, a send, a stop or a
starter from itself and from any process below it in the process tree, with `403 caller-refused`.
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
| `DM_DATA` | `$XDG_STATE_HOME/durable-member`, else `~/.local/state/durable-member` | The folder for the conversations (`store/`) and the file `write_note` appends to (`notes.txt`). |
| `DM_CALLER_CHECK` | `descendant` | `off` turns the descendant check off. Needed on any system but Linux. |
| `DM_STEP_MS` | `400` | The pause before each scripted answer, so you can see the states change. |
| `DM_SLOW_MS` | `10000` | How long the scripted answer to a follow-up takes, so Stop has something to stop. |
| `DM_HELPER_MS` | the value of `DM_STEP_MS` | How long the helper's scripted answer takes. |
| `REAL_MODEL` | not set | An OpenRouter model id. Not set means the scripted model. |
| `OPENROUTER_API_KEY` | not set | Your OpenRouter key. Pi reads it only when `REAL_MODEL` is set. |

## Write your own program

The contract is [`WIRE.md`](../../bridge/mux/durable/WIRE.md). The decisions behind it are in
[ADR 0099](../../.adr/0099-a-durable-program-is-a-mux-with-no-screen.md) (the adapter),
[ADR 0100](../../.adr/0100-an-ask-travels-as-data-and-is-answered-by-id.md) (asks),
[ADR 0101](../../.adr/0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) (send and stop) and
[ADR 0102](../../.adr/0102-starters-are-launcher-rows.md) (starters).

The SDK in `sdk/` is not published, and there is no package. It ships here as example code until a
second program needs it. Copy the folder into your program. It imports nothing from Pi Durable:

- `openCollie({ socket, hostName })` opens the socket and returns handles for workspaces, tabs and
  panes. Call `ready()` once every pane is shown, so Collie never sees a half-empty layout.
- A pane takes `event()` for items, `state()` for working and idle, and `ask()`, which resolves with
  the phone's answer. `onSend()` and `onAbort()` take the phone's text and Stop.
- `starters()` lists what the phone can start from the New page.

The SDK has two parts. `sdk/core/` is the layout and the wire as one function, `handle(request)`: a web
`Request` in, a `Response` out. It cleans every string and cuts it to its byte cap, and keeps the request ids
so a repeat runs once, in a `ReceiptStore` you can swap for one that outlives the process. The store keeps
the newest 1000 per pane; a repeat of an older id gets a 500, an unknown outcome, and runs nothing. It imports no
runtime module, so the same core serves the
[Cloudflare example](../durable-member-cloudflare/README.md) from a Durable Object. `sdk/server.ts` is the
transport for Bun: the private socket and the descendant check. It accepts connections with `Bun.listen`
and parses them with `node:http`, because only a `Bun.listen` socket gives the file descriptor that
`SO_PEERCRED` needs. `Bun.serve({ unix })` shows no peer.

`pi-durable/index.ts` is the glue for Pi Durable. It shows a conversation as a pane, turns a risky tool
call into an ask, and runs a helper conversation as a tool. `script.ts` is the scripted model. Together they
are the only files that import Pi. A program on another framework writes its own glue against the same
handles. `app.ts` puts the parts together.

## Test

```sh
bun run typecheck
bun test
```

The suite covers the socket rules, the hello, the request ids, the cleaning and the caps, the
descendant check, a whole ticket, and restarts with real kills. The protocol tests run twice, over the
socket and straight against the core. It needs no key and makes no network
call. From the root of collie, `bun test bridge/mux/durable/example.test.ts` starts this app and
drives it with Collie's own adapter.
