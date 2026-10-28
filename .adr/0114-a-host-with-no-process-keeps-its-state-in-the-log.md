# 0114: a host with no process keeps its state in the log

- **Status:** Proposed
- **Date:** 2026-10-21
- **Shipped in:** pending
- **Amends in scope:** the rules of `bridge/mux/durable/WIRE.md` section 8, point 1 (a new random epoch
  on every start), for a host that has no start. [ADR 0104](./0104-a-program-is-a-session.md) and
  [ADR 0105](./0105-the-durable-sdk-is-an-npm-package.md) are not changed. (Their exit was withdrawn on 2026-10-28.)
- **Trail:** Altan, 2026-10-21: "i'd like collie to become the visual layer for these types of durable
  agents. we already have the sdk that supports Pi durable, lets add this one to it." Vercel's
  `durable-harness`, first published 2026-10-15 and beta.6 on 2026-10-19, makes Pi durable on a log it calls a World and has no
  approval primitive and no phone screen. Three advisors reviewed the first
  design on 2026-10-21, each from a different side. It had an epoch per deployment, a hook that waited in
  memory, and a run list for the whole World. They changed it to the rules below ·
  `packages/durable-sdk/src/durable-harness/` ·
  `packages/durable-sdk/src/core/journal.ts` · `bridge/mux/durable/WIRE.md` (the appendix "A host with no
  process") · `docs/durable-agents.md` · the spike in the M66 tracker, spec 01 ·
  [ADR 0099](./0099-a-durable-program-is-a-mux-with-no-screen.md) ·
  [ADR 0100](./0100-an-ask-travels-as-data-and-is-answered-by-id.md) ·
  [ADR 0103](./0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md)

## Context

Every durable agent so far had a process. It started, minted an epoch, kept its panes and its open
questions in memory, and held a promise for each question. The wire's rules for restart (WIRE.md
section 8) assume that.

A durable agent on `durable-harness` can run as a function on Vercel. A function has no start that
Collie can see and no memory that outlives a request. Two functions may answer two polls of one phone.
The agent's own state is in the World, a log. The log has a place for the conversation. It has no place
for a question, an answer or a request id.

A spike on 2026-10-21 (Pi Durable 1.2.0, `durable-harness` 0.0.1-beta.6, `@workflow/world-local` 5.1.2,
a faux model, no key) answered what the design needed:

- A process that lost a session fails at its next write. Pi commits a tool's execute intent after the
  `beforeTool` hooks return and before the tool runs. So a fenced process that sees an answer still dies
  before the tool, and the tool runs once, in the new owner.
- A read-only reader of the log gives the same entries as the owner for every field the mapper reads.
- A stream named `collie` is one stream for all runs on a local World, which keys a stream by its name
  alone. A stream named `<runId>_collie` holds one run. Writes to an idle or a finished run are
  accepted and another process sees them in under 100 ms.
- Taking a session over and aborting it stops the turn in all three states (a waiting hook, a running
  tool, a streaming reply) in about 15 ms, and nothing resumes it. A tool that is already running in the
  old process still runs to its end and does its side effect, while the log says it was aborted.
- durable-harness's silence rule (`recoverAfterMs`) is set on each storage open, and a wake reopens with the default of 120 s.
  A wake reruns the hook under the same tool call id.
- On a local World the queue lives in the memory of one process. A send written by a second process is
  never picked up until the first process restarts.

## Decision

**A host with no process keeps every fact the phone can see in the World, and rebuilds the wire from it
on every request.** The invariant is one line: every fact the phone can see is in the World before the
response is written, so a state rebuilt after a request equals the state that answered it.

1. **The epoch is per World and schema.** It is `options.epoch`, else `COLLIE_EPOCH`, else a hash of the
   wire version, the mapper's schema version, the World's identity and the agent's name. It is never
   random on this host, and two instances of one deployment say the same one. It changes only when the
   meaning of a cursor changes. WIRE.md section 8, point 1, reads for this host: a host with no process
   start keeps one epoch per World and schema.
2. **The journal is the ask record.** It is one World stream per run, named `<runId>_collie`, in JSON
   lines. It holds four records: `ask`, `answer`, `expire` and `receipt`. A pure fold in the core
   (`foldJournal`) reads them: the first terminal record of an ask id wins, in stream order. The route
   answers `taken` only after it reads the journal back and its own nonce is the winning record. The
   tool arguments in an `ask` go through the same redaction as the socket path. The records are an
   appendix of WIRE.md, not a change of version 1.
3. **The guard is rerun-first.** A risky call reads the journal, appends the `ask` only when there is
   none for this call, and polls the journal (1 s, doubling to 5 s) until a terminal record closes it.
   It lets the call run only on an `answer` whose option allows, for the same arguments. A deny, an
   expiry, other arguments and a lost session all block the call. A rerun finds its own `ask` and
   waits for the same one, with the original expiry.
4. **A send is taken only while the session is idle.** The route opens the session, submits the text
   and lets go, and the queue finishes the turn. While a turn runs, `canSend` is false, so the phone
   offers no Send, and `steer` is false. Every control writes a `pending` receipt, acts, then writes
   `done`. A flush that fails is a 5xx with no `done`.
5. **A stop is a takeover.** The route opens the session, aborts its root conversation and lets go,
   then closes the turn's open questions as decided by the program. It covers a waiting hook, a
   running tool and a streaming reply. It does not call back a tool that has started: that tool
   finishes and does its work while the log says it was aborted, and the docs say so.
6. **The cost has one shape.** The route loads only what the request needs: hello asks whether the
   World answers; the snapshot reads the list of runs and the journal of each open run; a pane's routes
   read that run and its journal. Nothing is kept between requests but the last good answer to each GET,
   served for at most 5 s while the World errs. The pane's `rev` never falls inside a run. The
   snapshot's `rev` never falls when a run ends, and a run that leaves the list lowers it, which the
   docs say. The adapter compares stamps for equality only, so a falling value would not break it, but
   one that came back to an earlier value would skip a read.
7. **Self-hosted first, Vercel untested.** On a local World the route must run in the process that
   consumes the queue. The docs call this path supported self-hosted and call Vercel untested, until
   one smoke run on a real preview deployment has attached, listed a session, answered one card and sent
   once the session was idle.

## Roads not taken

- **A server that holds the state.** It is a second thing to deploy, and the wire would depend on one
  process again. The log already is the state.
- **One random epoch for each instance.** The adapter re-reads every pane whenever the epoch changes.
  Two functions behind one URL would reset the phone on every poll that landed on the other one.
- **An in-memory hook with no journal.** The session can be taken over, crash or be woken on another
  machine at any point. A question kept in one process is lost, or asked twice.
- **A new wire version.** Nothing above changes a shape of version 1. The appendix says how one host
  fills it.

## The exit

[ADR 0104](./0104-a-program-is-a-session.md#the-exit) withdrew its exit on 2026-10-28, so this decision needs no
outside signal and no date. (amended 2026-10-28) If the entry is ever retired, the `./durable-harness` entry goes with the durable code, in the
same commit, and the package is deprecated, never unpublished
([ADR 0105](./0105-the-durable-sdk-is-an-npm-package.md#the-exit)).

Two more things end the entry sooner. `durable-harness` is a beta, and the SDK pins it exactly: if a
later version moves its API and the entry is not ported within one minor release of Collie, the entry
moves to `experiments/`. And if the smoke run on Vercel fails, the docs keep saying self-hosted and name
the cause, and the Vercel steps leave the page.

## Consequences

- A builder adds one wrapper and one route to an agent they already have, then runs one
  `collie durable attach`. The same code runs as a function on Vercel and as one Node process.
- The route polls the World on every request. A phone that watches costs one call every 2 s, and an idle
  one every 10 s. Each call reads the list of runs and one journal for each open session. On a local
  World one session of 200 entries reads in 96 ms at p95, and ten such sessions in 988 ms at p95. Nothing
  is measured on Vercel.
- A question that waits costs one journal read every 5 s after the first seconds. After 120 s of silence
  durable-harness may hand the session to a new process, which reruns the hook under the same tool call id. The
  question stays one question.
- The core gains seams (an injectable epoch, rev and turn id; an ask seeded from a record; a receipt
  store that can claim a request id) that the memory path does not use. The socket path stays
  byte-identical, and the protocol suite runs over both.
- The phone cannot steer, rename, close, reopen or start anything on this host. It has no store of its
  own for titles, closes or starters. A later change may add one.
- A started tool outlives a stop. That is Pi's limit, not Collie's, and the docs name it.
- The kernel harnesses of `durable-harness` (`/pi`, `/opencode`, `/claude-code`, `/codex`) are a later
  source over the same route. They are not in this record.
- Revisit this decision if Vercel's World refuses a stream named `<runId>_collie`, or drops it before the
  run, or if a World gains a stop primitive for an outside caller. (amended 2026-10-28: the exit no longer fires)
