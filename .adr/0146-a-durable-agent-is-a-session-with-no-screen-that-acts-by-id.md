# 0146: A durable agent is a session with no screen, and it acts only by id

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0099, ADR 0100, ADR 0101, ADR 0103, ADR 0104, ADR 0114
- **Retires:** ADR 0102 (rule in `bridge/starter-launch.ts`), ADR 0105 (rule in `packages/durable-sdk/README.md`)
- **Trail:** a Pi Durable program that wanted into the crew (ADR 0099: fake a terminal, or a new crew
  role); users of Cloudflare Durable Objects on 2026-10-13 (ADR 0103: a relay, or stay out); four
  advisors on 2026-10-13 (ADR 0104: a second Collie per program); the owner on 2026-10-14 (ADR 0105:
  a copied folder); three advisors and the M66 spike on 2026-10-21 (ADR 0114: an epoch per deploy, a
  hook in memory). Files: `bridge/mux/durable/WIRE.md`, `bridge/mux/durable/`, `bridge/durable/`,
  `bridge/sources.ts`, `packages/durable-sdk/`, `docs/durable-agents.md`

## Context

A durable agent keeps its own conversations, has no terminal, and may wait for a person on a tool
call. Eight records shaped how Collie shows one; this one states the rule of today, and `WIRE.md`
stays the contract. People read "durable agent"; the code, `program` and old records say "program".

## Decision

1. **A durable agent is a session with no screen.** Each entry of `sources.json` is one more session
   of the Collie the person already runs, beside its terminal mux, built by the same factory with the
   `durable` adapter. A pane is a conversation; its id stays across a restart. The durable-only form
   (`COLLIE_MUX=durable` and the env variables) still runs, as the source `default`.
2. **It declares what it lacks.** No grid, no keys, no new tab or space: Chat is the only view.
   Steer, stop, starters, rename, close, actions, history and reopen exist only when the agent's own
   `hello` caps say so, and they read absent until the first good read.
3. **Two transports, exactly one per agent.** A private Unix socket of the same user, with no token,
   or HTTPS to a URL the person deployed, with a bearer token as the only gate. Collie dials out and
   opens no port. A wrong setting makes that session `unreachable` with one line; the bridge starts.
4. **The cost sets the cadence, and not ready is not empty.** A poll over HTTPS is billed, so it runs
   slower and backs off while the agent is down. Two failed reads in a row mean `unreachable`. An
   agent that is starting, refused or down never shows as an empty census.
5. **Every string from the agent is untrusted.** One cleaner strips controls, direction marks,
   zero-width and tag characters, and cuts to a cap. A cleaned ask offers no "Always allow". The
   `harness` string is display text and never picks a parser.
6. **An ask is data and is answered by its id.** The answer names the ask, the revision the phone
   saw, the option and a request id. A stale revision is refused. The receipt is written before the
   answer leaves, and a repeat sends nothing. Only a person's tap answers (ADR 0142, rules 1 and 6c).
   An agent SHOULD derive the ask id from the tool call, so an answer across its restart lands once.
7. **A control names the turn it saw.** A send, a stop and a belt action carry the turn or the open
   ask the phone saw, and a request id. The bridge checks the name before anything reaches the
   agent; a stale one is refused, and the typed words stay. Raw keys do not exist here.
8. **The push guard caps pushes, never what is shown.** Every open ask reaches the phone. A push goes
   out once per tool call, inside rates per pane and per host, and a flood trips an hourly breaker
   that sends one summary. The push names the pane, never the ask's text, unless the agent chose
   words of its own. The guard runs where the push is sent.
9. **A starter is a launcher row,** started by id with a request id and a receipt. It takes no input.
10. **The bridge keeps a log per pane, and history is the agent's.** Chat reads the log, so it
    outlives a closed pane and a restart. An agent that declares history serves closed ones itself.
11. **The wire is versioned by range, additive and experimental.** A reader ignores what it does not
    know. Collie speaks N and accepts N-1 for one minor after N ships. The crew protocol stays 2.
12. **The SDK is the npm package `@colliepwa/durable-sdk`,** built in this repo, on its own semver,
    under the dist-tag `experimental`, published by hand by the owner. CI never publishes.
13. **A host with no process keeps every fact the phone can see in its log** before it answers. Its
    epoch belongs to the log and the schema, never to a start. Asks, answers and receipts live in one
    journal per run, and the first closing record wins. The guard reruns first and lets a call run
    only on an allowing answer for the same arguments. A send waits for an idle session unless the
    agent opts into steer. A stop takes the session over and aborts it.

## Today in the code

- Rule 1: `readSources`, `SOURCE_NAME_PATTERN`, `ENV_SOURCE_NAME`, `planPrograms` (`bridge/sources.ts`);
  `bridge/sessions.ts` spawns each source, refuses a clashing name, puts `cards()` in the crew `hello`.
  `COLLIE_PROGRAMS=off` ignores the file. `cli/durable-attach.ts` writes it 0600 and restarts only with
  `--restart`. `DURABLE_LEAD_MINIMUM` (`bridge/durable/old-lead.ts`) warns of a lead too old.
- Rule 2: `durableCapabilities` (`bridge/mux/durable/adapter.ts`); rule 0 of `web/src/lib/chat-gate.ts`.
- Rule 3: `chooseDurableTransport`, `buildDurableTransport` (`bridge/mux/durable/transport.ts`), read
  by the adapter, its boot line and `durableFindings` (`cli/durable-findings.ts`). `client.ts`: the
  path walk and `SOCKET_PATH_MAX_BYTES`; `protocol.ts`: `DURABLE_SERVICE`. `http-client.ts`:
  `resolveDurableUrl`, `TOKEN_MIN_BYTES`, `redirect: "manual"`, the private `#authorization` field.
- Rule 4: `DURABLE_BUDGETS` (socket 1 s and 3 s; HTTPS 2 s and 10 s, 5000 ms budgets, a 10 s down
  gap) and `FAILURES_TO_UNREACHABLE = 2` in `adapter.ts`, whose header says "not ready is not empty".
- Rule 5: `cleanText` and `CAPS` (`clean.ts`); `alwaysAllowOffered` (`web/src/lib/ask.ts`).
- Rule 6: `bridge/durable/answer.ts` (receipt first, one digest per request id, `maybe-applied`);
  `askIdFor` (`packages/durable-sdk/src/core/layout.ts`). `FORWARDABLE` (`bridge/crew/forward.ts`)
  holds `answer`, `send`, `abort` and `action`; an old member's 404 reads as `stale`.
- Rule 7: `namesCurrent`, `rawInputRefusal`, `controlPane` (`bridge/durable/control.ts`). On the
  agent's own machine a plain send is one Send Protocol request through the structured driver
  (`bridge/surface/durable-driver.ts`, `textRouteFor` in `web/src/lib/send-path.ts`). Steer, stop,
  actions and every write through a crew member keep the pane routes.
- Rule 8: `DEFAULT_GUARD_LIMITS` (3, 10, 30), `BREAKER_MS`, `GUARD_FILE` (`bridge/durable/guard.ts`),
  keyed on host, session and tool call id; `ask.permission`, `ask.flood` (`bridge/push-titles.ts`);
  the two callers in `bridge/durable/ask-push.ts`.
- Rule 9: `starterItems`, `launchStarter` (`bridge/starter-launch.ts`), from `launchersRoute`.
- Rule 10: `DurableLogs` (`bridge/durable/log.ts`, one folder per source, the cursor beside each log),
  read by `bridge/journal/durable.ts`; `programHistory` and `reopenConversation` in `adapter.ts`.
- Rule 11: `PREVIOUS_ACCEPTED = null`, `negotiateVersion` (`protocol.ts`); `CREW_PROTOCOL_VERSION = 2`.
- Rule 12: `packages/durable-sdk/package.json` (name, optional peers, no dependencies), `SDK_VERSION`,
  `openCollie` (`src/index.ts`). No workflow runs `npm publish`; the steps are in its `README.md`.
- Rule 13, under `packages/durable-sdk/src/`: `foldJournal` (`core/journal.ts`); `journalName`,
  `TESTED` (`durable-harness/world-port.ts`); the epoch, `tokenAccepted` and the caps
  (`durable-harness/route.ts`); the guard and `takeoverControls` (`durable-harness/with-collie.ts`).

## Recorded, not found in the code

- 0102 point 4 was dropped on 2026-11-16, never built.
- `sources.json` is "mode 0600": the attach verb writes it so; the bridge reads it with no check.
- "A change that must touch a terminal path says so in its commit message" (ADR 0104).
- `/api/config` without `session` answers the primary "for one minor release": no end is coded.
- The retirement path (a source ignored with a log line for one minor, `npm deprecate`, no unpublish)
  is a promise in `docs/durable-agents.md`, "The exit". Its trigger was withdrawn on 2026-10-28.
- A host with no process is untested on Vercel; the docs say so until one smoke run passes.

## Consequences

- Any process of the same user, a tool the agent runs included, can use the socket. The defence is
  the agent's descendant check, which only the SDK's Bun entry on Linux runs (`WIRE.md` 1A).
- Anyone who holds the token acts as the phone, and the host sees the text (`WIRE.md` 1B).
- A started tool outlives a stop on a host with no process. That is Pi's limit; the docs name it.

## What we tried before

- 0099: an agent was a mux adapter on a peer of its own. Its points 3 and 4 (socket only, no
  token), 5 (SDK as example code) and 10 (one peer, one mux) were overtaken by 0103, 0105, 0104.
- 0100, 0101: asks and controls by id with a receipt; 0104 added the session to the guard key.
- 0102, 0103: starters are launcher rows, not a second list; TLS with a token beside the socket.
- 0104, 0105, 0114: a session, not a second Collie; an npm package, not a copy; a log, not a server.
