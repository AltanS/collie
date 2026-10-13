# A real program speaks the wire (M55 spec 06)

Verdict: **fits with small changes.** One outside Pi Durable program ran through Collie on a local
socket, and a deploy that waits for a person became one approval card on the phone. The tap shipped
the fix. The gaps are in the SDK packaging and in one security rule, not in the wire's shapes.

## The program

- **disler/durable-pi**, the proactive incident demo (`apps/proactive-dpi-demo`, backend
  `apps/proactive-dpi-be`). MIT license, copyright IndyDevDan. Upstream head `37165c6`.
- Node 24 with `tsx`, Express, `@earendil-works/pi-durable` **1.0.3** on SQLite. One harness in one
  process, so the SDK runs inside it (the single-writer rule holds).
- The approval moment: the `deploy` tool creates a durable task `ops.deploy`. Its `approval` phase
  polls a session document (`ops.deploys`) every 400 ms until a person sets `deploying` or
  `declined`. The web UI's Approve and Decline call `Ops.decideDeploy`.
- Clone, on disk: `~/.cache/collie-lab/m55-06-spike/durable-pi`, local branch `collie-port`, commits
  `13fc57f` (the port) and `e840f0e` (the no-key scaffolding). Nothing was pushed.

## Lines changed in the program

| Part | Files | Lines |
| --- | --- | --- |
| The port: new `src/collie.ts` | 1 new | +164 |
| The port: edits to existing files | `main.ts` +3, `extensions.ts` +1, `shared/types.ts` +2 | +6, -0 |
| Vendored SDK, copied unchanged | `src/collie/sdk/core/*`, `sdk/socket.ts`, `pi-durable/index.ts` | 3,601, no edits |
| Stub for the Pi helper's import | `src/collie/script.ts` | +11 |
| No-key scaffolding, not part of the port | `faux.ts` new, `config.ts`, `ops.ts`, `main.ts` | +101, -3 |

The port is **170 lines in the program**, six of them in its own files: start Collie when
`COLLIE_DURABLE_SOCKET` is set, close it on shutdown, and keep the deploy tool's `callId` on the
deploy record so the card sits under its tool item.

`collie.ts`: one workspace `Lumen Market`, tabs `Ops desk` (root conversation) and `Incidents` (one
pane per incident) through the vendored `showConversation`; the incident summary as subtitle and the
five playbook stages as `progress` steps; on every `harness.subscribeCommits`, a deploy in
`awaiting_approval` raises one `permission` ask (title `deploy wants to ship <commit> to
production`, the agent's summary and the diff stat as reason, Approve deploy and Decline, push
words) whose answer calls `ops.decideDeploy`; a deploy that leaves `awaiting_approval` otherwise
aborts the ask. `history` through `piHistory`. Starters, rename, close, actions and reopen off. A
25-line `node:http` transport on the socket with the SDK's path and mode checks.

## The run

- Collie: `~/.cache/collie-lab/release-1.22/bin/collie _exec-bridge` (19cec41c), fresh config and
  state dirs under `~/.cache/collie-lab/m55-06-spike/`, `COLLIE_MUX=durable`, 8795 on 127.0.0.1,
  `COLLIE_SKIP_SERVE=1`. One headless device paired with `collie pair` and `POST /api/pair`.
- No model key: `DPI_FAUX=1` makes Jev a rule (an `ERROR` row is an incident) and the agent a
  script that works the real playbook with the real tools (three stages, `write` the fix, `write` a
  regression test, `submit_fix` which proves fail-on-main and pass-on-branch and commits, `deploy`).
- Bug at T+38 s, incident at T+39 s, deploy waiting at T+42 s. Approve tapped on the phone at
  T+99 s: `deploy 45 approved`, `checkout-api-00043-603` rolled out, 3 guest checkouts, 0 errors.
  The pane went idle with all five steps done.

Screenshots (390 x 844): [01-conversation-list.png](01-conversation-list.png) (the incident waits
with one question, the Ops desk idle) and [02-approval-card.png](02-approval-card.png) (the card
under the deploy tool item, header "Step 4 of 5: Review").

## What did not fit the wire, and the workaround

1. **The wait is a document, not a promise.** Workaround: watch commits, raise an ask per waiting
   deploy, abort it when the document moves. Good fit: the ask is derived from durable state, so a
   restart raises it again under the same id (`toolCallId = deploy-<task id>`).
2. **No "answered elsewhere".** A decision in the program's own web UI closes the ask as
   `by: "stopped"`. A value such as `by: "program"` would be honest. Not worked around. Spec 03's
   `decidedBy` covers it.
3. **No caller check, where it matters most.** The incident agent runs `bash` as the same user and
   the card is the only gate before production. Node cannot read the peer of a Unix socket, so the
   program cannot refuse its descendants (WIRE.md 1A); the agent could approve its own deploy with
   `curl --unix-socket`. Not worked around. A real port needs a sandboxed shell or a Node
   `SO_PEERCRED` reader.
4. **`taken` before the program acts.** If the web UI decided in between, `decideDeploy` throws
   and the phone still saw `taken`. Rare; the next snapshot corrects the screen.
5. **The program's trigger is not a starter.** "Deploy the bug" makes no pane. Left out; a pane
   action on the Ops desk would carry it.
6. **The card needs the tool call id.** One added field (`callId`).

Conversations as panes, `sessionId` and history, streaming, steer and stop (a stop aborts the deploy
task, the deploy is cancelled, the ask closes), subtitle, progress and push words fit as written.

## What the SDK lacked

1. **A Node transport.** `server.ts`, `conn.ts`, `peer.ts` need Bun. The port carries its own
   `node:http` server and drops the descendant check. The core ran on Node unchanged.
2. **The Pi helper imports Collie's example words** from `../script.ts`; a program must stub it.
3. **The Pi helper targets pi-durable 1.1.0** (`order` on `entries` and `scanConversations`): three
   type errors on 1.0.3. It runs; history order on 1.0.3 not checked.
4. **No `requireApproval`** (spec 03 not in this base). The ask was built by hand.
5. **Tool summaries are raw JSON** for calls with more than one argument (`summaryOf`).
6. **No package.** Vendoring is 3,601 lines in 9 files.

Items 1, 2, 3 and 5 were handed to spec 03 on 2026-10-13.

## Smaller things on the phone

- The list says "on durable"; the hello name `proactive-dpi` is not shown (M55's session card).
- Long incident titles are cut in the list row.
- The diff stat in the reason is in a proportional font.
- Buttons read "Allow / Approve deploy" and "Deny / Decline".

## Time

Host clock: start 23:27, approval end to end at about 23:33, report 23:35 on 2026-10-13.

## Draft to the author (not sent)

> Thanks @disler, I ported the proactive demo to Collie's durable wire on a local branch, and the
> deploy that waits for approval now shows on the phone as one card whose Approve commits the same
> decision as your Approve button. The change is one new file of about 160 lines and six lines in
> the demo, and I can open it as a pull request if you want it.

## Clean up

Bridge, backend, log stream and browser stopped; socket folder removed; no `CLAUDE_CONFIG_DIR` copy.
Delete `~/.cache/collie-lab/m55-06-spike/` to roll back.
