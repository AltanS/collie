# Durable harness: a Pi agent on Vercel's durable-harness, in your Collie

A small shipping desk. It runs on [durable-harness](https://www.npmjs.com/package/durable-harness) (the Pi variant,
`durable-harness/pi-durable`) and shows on the phone through Collie. You read its conversations, answer its questions
as cards, send to a session that is idle, and stop a turn. The wire is experimental and may change in any minor release
of Collie ([`WIRE.md`](../../bridge/mux/durable/WIRE.md), appendix "A host with no process"). This folder is example
code to read and copy. The SDK it uses is [`@colliepwa/durable-sdk`](../../packages/durable-sdk/README.md).

## Run it yourself

You need Node 24 and Bun 1.4 or later. From a clone of collie:

```sh
cd examples/durable-harness
bun install --frozen-lockfile
export COLLIE_TOKEN=$(openssl rand -hex 32)
node --import ./tests/node/register.mjs server.ts
```

The server prints `desk listening on http://127.0.0.1:8420`. It refuses to start without a `COLLIE_TOKEN` of 32 bytes
or more.

The `--import` flag is there because the example reads the SDK from this clone. It sends Pi, durable-harness and
`@workflow/*` to this folder's install, so the program loads one copy of each. A project that installs
`@colliepwa/durable-sdk` from npm runs `node server.ts` with no flag.

In a second terminal, start two sessions:

```sh
cd examples/durable-harness
node seed.ts
```

One session asks to ship an order. The other looks up stock and finishes. Attach the desk to your Collie:

```sh
collie durable attach desk --url http://127.0.0.1:8420/collie --token-env COLLIE_TOKEN --restart
```

Collie takes plain `http` only for `127.0.0.1` and `localhost` with a port. For any other host, put HTTPS in front of
the server. Leave the `/session/v1` part out of the URL: the adapter adds it. Setup in full:
[Durable agents](../../docs/durable-agents.md).

Open Collie on the phone. The first session shows a card, "ship wants to run". Tap Allow. The tool appends one line to
`shipped.txt` and the session ends with a reply. Send a message to the other session. It answers.

Stop the server with Ctrl-C. A session that was mid-turn resumes at the next start. To start over:

```sh
rm -rf .workflow-data shipped.txt
```

## The three routes

| Route                                  | What it is                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `/api/chat`                            | durable-harness's own chat route. A person or a script talks to the agent.       |
| `/.well-known/durable-harness/v1/flow` | durable-harness's queue route. World-local does not call it. A Vercel deploy does. |
| `/collie/session/v1/*`                 | Collie's route. The phone reads, answers, sends and stops through it.            |

`/api/chat` and the flow route sit behind the same bearer token as Collie's route.

The Collie part of `lib/pi.ts` is one wrapper around the function that opens your Harness:

```ts
export const open = resumeWith(
  withCollie((storage, reg) => Harness.open(storage, { models, registry: reg }, ctx), { registry, risky: new Set(["ship"]) }),
  { name: "desk" },
);
```

`server.ts` mounts the route with `collieRoute({ open, name: "desk", token })`. A tool named in `risky` waits for a tap
before it runs. Every other tool runs at once.

## Settings

| Variable                  | Default                      | Meaning                                                                    |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `COLLIE_TOKEN`            | none                         | The bearer token. 32 bytes or more. No default, on purpose.                |
| `PORT`                    | `8420`                       | The port.                                                                  |
| `HOST`                    | `127.0.0.1`                  | The address to bind. Keep it on loopback unless a proxy with HTTPS is in front. |
| `WORKFLOW_LOCAL_DATA_DIR` | `.workflow-data` in this folder | The folder of the World's log. Two programs that share it share the sessions. |
| `PI_MODEL`                | unset                        | An OpenRouter model id. Unset: Pi's faux model, no key, no network.        |
| `OPENROUTER_API_KEY`      | unset                        | The key for `PI_MODEL`. Pi reads it. The example never does.               |
| `SEED_URL`                | `http://127.0.0.1:8420`      | The server `seed.ts` talks to.                                             |

## On Vercel

The same code is meant to run as a function with Vercel's World in place of the local one. Nothing has run on Vercel
yet. The steps appear here after one preview deployment has attached, listed a session, answered one card and sent
once the session was idle.

What it rests on, untested:

- The queue is shared between functions, so a send from any function reaches the session.
- The World identity (the project and environment) is the same for every function of one deployment, so the epoch is stable.
- A function's maximum duration is longer than the time a question waits. Otherwise the silence rule hands the session to a new function after 120 s, which reruns the hook.
- A stop's takeover commits before the function returns.

## What it costs

- **A cold read is the log.** Collie's route keeps nothing the phone sees between two requests. It reads the log of the
  World. One cold read of a session with 200 entries took about 100 ms in the spike. Once a process holds a reader, a
  poll reads only what is new: 50 polls of a 200-entry session took about 3 ms at p95 here.
- **Streaming makes it grow.** The cost follows the number of log events, not the number of entries.
  Ten sessions of about 1,400 events each took 1 s to list from cold.

## Two rules for self-hosting

- **A send reaches the session only through the process that runs the queue.** On world-local that is the server. A
  second process that serves Collie's route over the same folder takes your message into the log. Nothing runs it until
  a process that starts the World runs its recovery, which is the next server start. Until then the pane reads
  "working" with nobody behind it. Run one server per folder.
- **A tool that is already running finishes in the process that started it.** A stop ends the turn, and it takes the
  session over, but it cannot reach into the old process. If that process is still alive, the tool does its side effect
  (here, a line in `shipped.txt`) while the log says it was aborted. A process that was killed mid-tool is different:
  the next start does not run the tool again.

## Tests

```sh
bun test
bun run typecheck
```

`bun test` runs the protocol suite and the fake-World tests, then spawns Node to run a real session, with a process
killed mid-tool and a second process that serves only the route. The real-Harness tests skip below Node 23.
The adapter test, `bridge/mux/durable/example-durable-harness.test.ts`, starts `server.ts` and drives it with Collie's
own adapter over loopback HTTP.
