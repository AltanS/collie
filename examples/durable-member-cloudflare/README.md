# Durable member on Cloudflare: a Pi Durable program behind a token

A Cloudflare Worker with one Durable Object that runs the same ticket triage as
[`examples/durable-member`](../durable-member/README.md), with
[Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) keeping its conversations in the
Durable Object's SQLite storage. It serves Collie's durable wire over HTTPS, and a bearer token is the only
gate. A Collie peer with `COLLIE_MUX=durable` and `COLLIE_DURABLE_URL` lists the conversations as panes, and
you answer their questions from the phone. The wire is experimental and may change in any minor release of
Collie ([`WIRE.md` section 1B](../../bridge/mux/durable/WIRE.md#1b-tls-with-a-bearer-token)). Once deployed,
it runs on your Cloudflare account and costs money there: every poll from Collie is a billed request (see
[Cost](#cost)). This folder is example code to read and copy. It is not a package.

## Run it locally

You need Node 22 or later for wrangler and the tests, and Bun for `bun run smoke`. Nothing in this section
needs a Cloudflare account. `wrangler dev` runs the Worker in a local copy of the Workers runtime and keeps
the Durable Object's SQLite under `.wrangler/state`.

From a clone of collie:

```sh
cd examples/durable-member-cloudflare
npm ci
printf 'COLLIE_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars
bunx wrangler dev --port 8801 --ip 127.0.0.1
```

The second line writes a fresh random token to `.dev.vars`, a file git ignores
(`.dev.vars.example` shows its shape). The third serves the Worker on `http://127.0.0.1:8801`. Use port 8801
or any free port, but not 8787: that is wrangler's default port and also the port of a Collie install. Check
it from a second terminal:

```sh
curl -H "Authorization: Bearer $(sed -n 's/^COLLIE_TOKEN=//p' .dev.vars)" http://127.0.0.1:8801/session/v1/hello
```

The answer starts with `{"service":"collie-durable"`. Without the header, the answer is 401
`{"code":"unauthorized"}`. On the first start the program opens one ticket, and the scripted model asks to
run `write_note`. The ticket waits for your answer. Stop wrangler with Ctrl-C. Delete `.wrangler/state` to
start over.

## Point a Collie peer at it

A peer is one Collie instance, and one instance mirrors one backend, so the program needs a peer of its
own. The peer needs the address and the same token:

```sh
COLLIE_MUX=durable
COLLIE_DURABLE_URL=http://127.0.0.1:8801
COLLIE_DURABLE_TOKEN=your-32-byte-random-token-here   # the value in .dev.vars
```

Collie sends a token only over `https://`, with one exception: `http://127.0.0.1:<port>` or
`http://localhost:<port>`, for `wrangler dev` on the same machine. The token must be at least 32 bytes, for
example 64 hex characters from `openssl rand -hex 32`. Set the socket or the URL, never both. `collie doctor`
says whether the token is set and how long it is, and never prints it. The full peer settings are in
[durable notes](../../docs/multiplexers.md#durable-notes).

### First run on a host that already runs Collie

The program gets a second Collie instance with its own port and state folder. Put these lines in
`~/.config/herdr/plugins/config/herdr.collie-durable/.env`:

```sh
COLLIE_INSTANCE=durable
COLLIE_PORT=8795
COLLIE_STATE_DIR=/home/you/.local/state/collie-durable
COLLIE_MUX=durable
COLLIE_DURABLE_URL=http://127.0.0.1:8801
COLLIE_DURABLE_TOKEN=your-32-byte-random-token-here   # the value in .dev.vars
```

Then start it, check it, and join it to your crew under a name of its own, so the host chip can tell it
from the other instance on this host:

```sh
COLLIE_INSTANCE=durable collie start
COLLIE_INSTANCE=durable collie doctor
COLLIE_INSTANCE=durable collie crew join <lead-address> --label durable
```

`collie crew invite` on the lead gives the address and the code; the steps are in
[Join the crew](../durable-member/README.md#join-the-crew). A question the program asks reaches the phone as
a push when push is set up, the same as a question from any other pane.

## Deploy

You need a Cloudflare account and `bunx wrangler login` once. Then, in this folder:

```sh
openssl rand -hex 32                 # make a new token; copy it
bunx wrangler secret put COLLIE_TOKEN   # paste it when asked
bunx wrangler deploy
```

`wrangler deploy` prints the address, `https://collie-durable-member.<your-subdomain>.workers.dev`. The
subdomain is the `workers.dev` name of your account. Put the address and the token in the peer:

```sh
COLLIE_DURABLE_URL=https://collie-durable-member.<your-subdomain>.workers.dev
COLLIE_DURABLE_TOKEN=your-32-byte-random-token-here
```

Use a different token for the deployed program than for `wrangler dev`. A deploy restarts the Durable
Object, so Collie sees a new epoch and reads every pane again. An open question comes back with the same id
(see [Limits](#limits)).

## The trust model

The address is public. Anyone on the internet can send it a request, and the token is the only thing that
keeps them out.

- **Who holds the token acts as your phone.** They can read every conversation, answer every question,
  send text, stop a turn and run a starter. There is no second check. The local example's descendant
  check needs a caller on a local socket, and a request from the internet has none, so here it does not
  exist.
- **The Worker checks the token before anything else**, in constant time, before the version, `hello` and
  the Durable Object. A wrong or missing token gets 401 `{"code":"unauthorized"}` and nothing more, and
  wakes nothing. A token shorter than 32 bytes, or none at all, makes the Worker refuse every request.
- **Make the token random.** It must be at least 32 bytes, for example 64 hex characters from
  `openssl rand -hex 32`. Keep it in two places only: the Worker's secret and the peer's `.env`.
- **Rotate it without a lockout.** The Worker takes `COLLIE_TOKEN` and, while it is set,
  `COLLIE_TOKEN_NEXT`. Both are checked hashed and in constant time. Rotate in three steps:
  1. Set `COLLIE_TOKEN_NEXT` to the new value: `bunx wrangler secret put COLLIE_TOKEN_NEXT`. Both tokens
     now work.
  2. Put the new value in the peer's `COLLIE_DURABLE_TOKEN`, and restart the peer.
  3. Move the value to `COLLIE_TOKEN` (`bunx wrangler secret put COLLIE_TOKEN`), then unset
     `COLLIE_TOKEN_NEXT` (`bunx wrangler secret delete COLLIE_TOKEN_NEXT`). Only the new token works now.

  Each secret you set or delete deploys a new version of the Worker, which restarts the Durable Object.
- **Cloudflare sees the text.** TLS ends at Cloudflare's edge. Transcripts and tool output sit in the
  Durable Object's storage, and a real model's key sits in your Worker's secrets.
- **Everything in the Worker can read the secrets.** With `nodejs_compat`, each binding, the token
  included, is in `process.env`. The tools here are toys. A tool that runs code you did not write could
  read the token and the model key.
- **The next step is Cloudflare Access.** An Access policy with a service token would put a second gate in
  front of the Worker, at Cloudflare. Collie does not send Access's two headers yet, so this example
  stops at the bearer token.
- **Allow and Deny only.** With the token as the only gate, an always-allow answer from whoever holds it
  would let every later call through. The example offers no always-allow, and it refuses one: its core
  is made with `allowAlways: false`, so an ask with an `allow-always` option is a `TypeError` when the
  program raises it.

## Cost

Prices are from Cloudflare's pricing pages, read on 2026-10-13. Check them before you deploy.

- **Every poll is a billed request, twice.** One poll is one Worker request and one Durable Object
  request, and a "nothing changed" answer (304) counts too. Over HTTPS, Collie asks every 2 s while a
  phone watches the machine, and every 10 s when none does. The bridge's own safety-net poll reuses
  the last answer, so an idle peer asks once per 10 s: 8,640 Durable Object requests a day (about
  260,000 a month), plus the same number of Worker requests. While a phone watches, the 2 s poll
  makes 43,200 a day.
- **The Durable Object stays in memory while a peer polls.** An idle Durable Object leaves memory after
  10 s with no request, so a peer that polls every 2 s keeps it in memory. Cloudflare bills that time for
  the full 128 MB: 24 hours in memory is about 11,000 GB-s.
- **A wrong token is billed too.** A request that reaches the Worker is a Worker request, even when it
  gets a 401. It never reaches the Durable Object.
- **Workers Paid is the honest plan.** It costs at least 5 USD a month. It includes 10 million Worker
  requests and 30 million CPU milliseconds a month, and for Durable Objects 1 million requests and 400,000
  GB-s a month. Past that, Durable Object requests cost 0.15 USD per million and duration 12.50 USD per
  million GB-s. One idle peer fits inside these numbers.
- **Workers Free is tight.** It allows 100,000 Worker requests and 100,000 Durable Object requests a day,
  and 13,000 GB-s of Durable Object duration a day. A peer with a phone watching all day spends about
  43,000 of the requests and about 11,000 of the GB-s, so little is left for anything else. A flood of
  requests with a wrong token can use up the daily requests and lock out your own peer until 00:00 UTC.

## Limits

- **A question that waits survives a wake.** When the object leaves memory between your read and your
  tap, the question is raised again with the same id, and your tap lands on it. Local `wrangler dev`
  removes an idle object after 10 s, so you see the object wake often there. The object leaves memory on
  a deploy, on a new secret, and when it is evicted, and it raises every waiting question before it
  answers again.
- **Nothing runs while nothing asks.** The object has no alarm. A run that was cut off continues only when
  the next request, usually Collie's next poll, starts the object again.
- **Every start is a new epoch.** Collie then reads each pane again in full.
- **A Worker must start within 1 s.** Cloudflare's limit for the top-level code. A real deploy of this
  bundle was not tried, so its start time there is not measured.
- **Free gives a Worker 10 ms of CPU per request.** Whether the Durable Object's start (opening Pi and
  showing every conversation) fits in that was not measured.
- **Pi keeps no timer here.** The program sets Pi's `contextRetentionMs` to 0. With `nodejs_compat`,
  Pi takes the Workers runtime for Node and would keep a 10-minute timer after every run, and a pending
  timer keeps a Durable Object in memory, and billed, until it fires.

## Environment and secrets

| Name | Kind | Default | What it does |
| --- | --- | --- | --- |
| `COLLIE_TOKEN` | secret, required | none | The bearer token, at least 32 bytes. `.dev.vars` for `wrangler dev`, `wrangler secret put COLLIE_TOKEN` after a deploy. Missing or shorter: every request gets 401. |
| `COLLIE_TOKEN_NEXT` | secret | not set | The next token, while a rotation runs (see [The trust model](#the-trust-model)). A request with either token is taken. Shorter than 32 bytes: ignored. |
| `REAL_MODEL` | var | not set | An OpenRouter model id. Not set means the scripted model. |
| `OPENROUTER_API_KEY` | secret | not set | Your OpenRouter key, read only when `REAL_MODEL` is set. |
| `DM_STEP_MS` | var | `400` | The pause before each scripted answer. |
| `DM_SLOW_MS` | var | `10000` | How long the scripted answer to a follow-up takes, so Stop has something to stop. |
| `DM_HELPER_MS` | var | the value of `DM_STEP_MS` | How long the helper's scripted answer takes. |
| `DM_STORAGE` | var | `sqlite` | `memory` keeps Pi's conversations in memory. For `npm run test:memory` only. |

A var goes in `wrangler.jsonc` under `"vars"`, or in `.dev.vars` for `wrangler dev`. A secret goes in
`.dev.vars` locally and through `wrangler secret put` after a deploy, never in `wrangler.jsonc`.

### A real model

```sh
bunx wrangler secret put OPENROUTER_API_KEY
```

Then set `REAL_MODEL` to an OpenRouter model id that Pi's catalog knows, for example
`google/gemini-3.1-flash-lite`, and deploy again. Locally, put both lines in `.dev.vars`. Pi reads the key
from `process.env`, which `nodejs_compat` fills from the Worker's secrets. Every ticket then costs tokens,
and each model call is an outbound request from the Durable Object (Free allows 50 per request, Paid 10,000).
The tests check that a binding reaches `process.env` inside the Worker; no test calls OpenRouter.

## Write your own

The contract is [`WIRE.md`](../../bridge/mux/durable/WIRE.md), section 1B for this transport. This folder
reuses three parts of the local example by relative path, so copy both folders:

- **The SDK core** (`../durable-member/sdk/core/`). `createCore()` returns the layout handles and
  `core.handle(request)`, the whole wire as one function from a `Request` to a `Response`. It imports no
  runtime module. The Durable Object's `fetch` is one line that calls it.
- **The Pi glue and the script** (`../durable-member/pi-durable/index.ts`, `../durable-member/script.ts`).
  They import Pi, and `wrangler.jsonc` (`alias`), `vitest.config.ts` (`dedupe`) and `tsconfig.json` (`paths`)
  make them take it from this folder, so the bundle holds one copy of each Pi package.

The files here:

- `src/worker.ts` checks the token (`src/token.ts`) and forwards to the one Durable Object.
- `src/member.ts` is the program: the Durable Object that opens Pi, lays out the panes and serves the wire.
- `src/storage.ts` is the one place where Pi Durable meets the Durable Object's SQLite.
- `src/receipts.ts` keeps the request ids in a `collie_receipts` table, so a retry after a restart still
  runs once. It keeps the newest 1000 per pane and drops older ones in the same transaction; a repeat of a
  dropped id gets a 500, an unknown outcome, and runs nothing. The core's `ReceiptStore` interface is two
  methods.

## Test

```sh
npm test
npm run test:memory
bun run smoke
```

The tests run inside workerd, the Workers runtime, through Cloudflare's Vitest plugin, so they need Node and
Vitest. `bun test` cannot load `cloudflare:workers`, so this folder does not use it. They cover the token,
`hello`, the snapshot and its ETag, an answer that runs once, send and stop, a starter, and restarts: a new
epoch, request ids that survive in SQLite, and a waiting question raised again with the same id and a
tap across the wake taken once. They also cover the second token of a rotation and the receipts cap. `npm run
test:memory` runs them with Pi's conversations in memory and skips the test that needs them to survive. The
smoke starts `wrangler dev` on 8801 with a fresh token and a temporary state folder, asks for `hello` with
curl, and stops. None of them needs an account or the network.
