# Changelog

`@colliepwa/durable-sdk` has its own version, apart from Collie's, and follows [Semantic Versioning](https://semver.org/).
Each version names the durable wire version it speaks. Until the package leaves the `experimental` dist-tag, a minor
release may change the API.

## 0.2.0 (Unreleased)

- **A journal for a host with no process.** `core/journal.ts` defines the records of that host (`ask`, `answer`, `expire`, `receipt`) and `foldJournal`, a pure fold: the first terminal record of an ask id wins, an `ask` after its terminal record is ignored, and a `receipt` of phase `done` closes its `pending`. It returns the open asks, the decided outcomes, the winning record of each and the request ids.
- **Seams for a host that rebuilds its state on every request.** All optional; the memory path is unchanged. `CoreOptions.epoch` and `CoreOptions.rev` fix the epoch and the snapshot's `rev`. A pane takes `turnId` (fixed, never minted) and `sendWhenIdleOnly` (`canSend` is false while a turn runs). `pane.seedAsk(record, sink)` opens an ask with no promise: an answer goes to `sink.answer`, and is `taken` only when the sink says so, else 409 `decided` or `too-late`. `pane.seedDecided(outcomes)` restores the first outcomes. A seeded ask past its `expiresAt` closes as `timeout` at exactly `expiresAt`.
- **A receipt store may claim a request id atomically.** `ReceiptStore.claim(requestId, digest, group)` is optional and answers `new`, `pending`, `done` (with the reply) or `dropped`. `MemoryReceiptStore` implements it. `Receipts.run` calls it instead of `get` when a store has it: `new` runs the act, `done` replays the first reply, a `pending` with another digest is 409 `request-id-reused`, and a `pending` with the same digest is asked again until it is done or `ReceiptsOptions.pendingWaitMs` (default 4000) passes, then 500 `receipt-dropped`, an unknown outcome that never runs the act twice.
- **The ask policy is in core.** `toAskSpec({ toolName, args, words })` builds the question for a risky tool call (title, Allow and Deny, the push words, the call's redacted arguments) and `core` exports it with `summaryOf` and `RiskWords`. `riskGuard` calls it, so a hook in a Pi process and a host with no Pi raise the same card for the same call. `./pi` still exports `summaryOf` and `RiskWords`; nothing a program sees changed.
- **A test holds the memory store to the seams.** `invariant.test.ts` runs the whole protocol suite and, after every request, builds a second store from the first one's facts (layout, items and a journal) through the seams. It requires the same snapshot, the same reset view of every pane and the same first outcome for every decided ask. A host that derives its state can rely on it. No code changed.
- **`./durable-harness`: a Pi agent on Vercel's durable-harness.** Experimental, and tested self-hosted only: no run on Vercel yet. `collieRoute({ open, token })` is a web handler for transport 1B that builds the wire from the World on every request: a bearer check in constant time before any read, a pane per open run, items from the Pi mapper over the session's log plus the reply being written, asks and request ids from a journal stream per run (`<runId>_collie`), and a short outage answered from the last good reply for 5 s. `withCollie(open, { registry, risky })` wraps the opener for `resumeWith`; its guard asks through the journal, rerun-first, and allows a call only on an `allow` for the same arguments from a process that still holds the session. `takeoverControls(open)` sends while idle and stops by taking the session over; a tool that has already started finishes in the old process and does its work while the log says it was aborted. On a local World, serve the route from the process that runs the queue. `durable-harness` 0.0.1-beta.6 and `@workflow/world` 5.0.5 are optional peers at those exact versions, checked at the first request, and the entry is tested with `@workflow/world-local` 5.1.2 and Pi 1.2.0. `createRoute` and `WireSource` take any source.
- **A host may fix a pane's events cursor.** `PaneOptions.cursor`: a read at exactly that cursor gets no events, and any other read gets the reset view with that cursor as `next`. For a host that rebuilds the pane on every request and cannot replay a tail.
- **A journal receipt can fail, and names its writer.** A `receipt` record may carry a `nonce`, minted per `pending`, and a `phase` of `failed`, which frees the request id when its nonce matches the standing `pending`. `parseJournal(text)` reads a journal's JSON lines and drops a line that does not parse or does not fit its tag.

## [0.1.0]

- **The first package.** The durable SDK, built from `packages/durable-sdk` in the Collie repo.
- **Wire version 1.** `WIRE_VERSION` is 1, and `SDK_VERSION` is this package's version.
- **Bun and Node, one import.** `openCollie` picks the Bun server, with the descendant check, on Bun, and the
  `node:http` server, which cannot run that check, on Node 22.19 or later. `./bun` and `./node` force one.
- **`./pi` for Pi Durable 1.1 and 1.2.** The Pi Durable glue, with `@earendil-works/pi-durable`, `pi-ai` and `chord`
  1.1 or later and below 2 as optional peers. It is tested with 1.1.0 and 1.2.0. A tool returns both `content` (1.1) and
  `output` (1.2) through `toolResult`. A pane shows a notice when the Pi session fails, and the error goes to the log.
  `./core` is the wire without a transport.
- **Decoded JSON in, not `unknown`.** The public functions take `Json | undefined` instead of `unknown`, and `Json` and
  `JsonObject` are exported, so a consumer passes decoded JSON.
- **The Pi helpers can put a clock on a question.** `riskGuard` and `askTools` take `timeoutMs`, and the ask carries `expiresAt`; past it the call is blocked, or the tool returns "timed out", and `onTimeout` lets the program log it.
