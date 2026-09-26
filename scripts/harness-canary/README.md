# The harness canary

`bun run canary` starts claude, codex, opencode and pi in a Herdr session of its own, types drafts
and a few real sends, and checks with Collie's own code what the phone would read and whether each
send lands. Spec: M37/02 in the workspace tracker.

```sh
bun run canary                          # all four agents, all five scenarios
bun run canary --agent claude,codex     # some agents
bun run canary --scenario idle,drafts   # some scenarios, no model turns
bun run canary --keep                   # leave the session up for a look
bun run canary --record                 # write clean agents into the ledger
bun run canary --readers /tmp/c1131     # judge with another checkout's readers
```

Exit 1 means a scenario failed. Captures and `summary.json` go to
`/tmp/collie-canary/<run-id>/<agent>-<version>/`. They are never copied into `web/src/fixtures/`.

## What it checks

Five scenarios per agent. Only scenario 3 makes model turns: three per agent.

| id           | what the canary does                                   | what must hold                                         |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------ |
| `idle`       | starts the agent and waits for Herdr's idle            | composer ready (adapter agents), raw blocks, no card   |
| `drafts`     | types the 15 message kinds, never submits them         | the draft reads back, composer ready, no card          |
| `sends`      | sends plain, a `────` rule and Chinese, "only OK"      | outcome `sent`, the message and an OK below it         |
| `narrow`     | restarts at 50 columns, idle plus two drafts           | the same as `idle` and `drafts`                        |
| `start-exit` | samples every 150 ms while starting and after exiting  | no unread card                                         |

The message kinds live in `messages.ts`: the 14 hand kinds of 2026-09-26, plus `15-rule`, a
pasted `────` line. opencode and pi have no adapter. For them a draft passes when its words show on
the raw mirror, and a send goes through the one-step path the phone uses.

## Verdicts

Whether a screen was reached is judged without Collie: Herdr's agent state and the screen's plain
text. What the phone makes of that screen is judged with Collie's readers only.

- `pass`: the screen came, and Collie read it right.
- `fail`: the screen came, and Collie read it wrong. The run exits 1.
- `not-reached`: the screen never came in time, for example a model turn that did not finish. It
  is never a pass, and it never fails the run.
- `known-gap`: a fail listed in `known-gaps.json`, with its reason and the issue, spec or ADR that
  owns the fix. The fix deletes the entry. A listed scenario that passes prints as a stale entry.

`--record` writes an agent into `web/src/lib/harness/verified-versions.json` (spec M37/01) with
`how: "canary"`, only after a run with no fail in which that agent reached every scenario. It
refuses when `--readers` points at another checkout, and it never creates the ledger.

## How it stays off the operator's panes

- **Its own session.** The canary starts `herdr --session collie-canary server` and refuses to
  start when a session of that name exists. Every command carries `--session collie-canary` and
  `HERDR_SOCKET_PATH` set to that session's socket. The inherited `HERDR_*` variables are removed.
- **An owned-id check.** Every pane and workspace command checks the id against the ids this run
  created. The send path refuses any other pane too.
- **Its own Herdr config.** The session reads a temporary `config.toml` (`HERDR_CONFIG_PATH`) with
  sound, toasts, the update check and onboarding off. The operator's config is not read.
- **Teardown.** A `finally` and a SIGINT, SIGTERM and SIGHUP handler close the workspaces, stop
  and delete the session, and remove the project and config directories. The run ends with a
  `teardown: clean` line, or says what is left.

## The send path

The client's real `sendGuardedReply` (`web/src/lib/reply-action.ts`) runs in this process. Its
`fetch` is replaced by a shim (`transport.ts`) that answers `GET /api/pane/:id` with the bridge's
own `readPane`, and `POST /api/pane/:id/reply` with the bridge's own `replyPane`, both from
`bridge/server.ts`. The shim builds a Herdr adapter on the canary session's socket. So there is no
server, no port and no paired device. Any other route throws, because a new route means the send
path changed. The bridge's audit lines for each send are kept in `summary.json`, with the device
name `collie-canary`.

## Proof against 1.13.1

The canary fails on the two readers 1.13.2 fixed. To see it:

```sh
git worktree add /tmp/c1131 v1.13.1
ln -s "$PWD/web/node_modules" /tmp/c1131/web/node_modules
bun run canary --agent claude,codex --scenario idle,drafts,narrow,start-exit --readers /tmp/c1131
rm /tmp/c1131/web/node_modules && git worktree remove /tmp/c1131
```

On 2026-09-26 that run failed codex `idle` (composer not found, unread card), claude `drafts` on
`15-rule` (unread card, draft not read back) and claude `start-exit` (card after exit). On main
every scenario passed, except the listed codex `start-exit` gap. `--readers` swaps only the
`web/src/lib` readers and the reply action; the bridge side of the send path is this checkout's.

## Findings (2026-09-26, Herdr 0.9.0)

**Session targeting.** `herdr --session <name> <group> <verb>` targets a named session for `pane`,
`tab`, `workspace` and `agent`. The flag wins over an inherited `HERDR_SOCKET_PATH`.
`HERDR_SOCKET_PATH=<socket>` alone also works. A stopped session is an error
(`server_not_running`), never a fallback to the default session. `herdr --session <name> server`
starts a headless server. `herdr session stop <name>` returns before the server is gone, so
`herdr session delete <name>` must be retried until it succeeds.

**Pane size.** In a headless session with no client, a new pane is 119 columns wide. With a client
attached, Herdr sizes new panes from that client, also in tabs nobody views. The canary's client is
147 x 41, so its panes are 120 x 40. A `stty cols` wider than the pane wraps every full-width row,
so `--cols` stops at 119.

**Why the canary attaches a client.** A headless session answers no colour query (OSC 10, 11 and
4). Codex 0.156.1 then paints its composer with no background and its status separators with no
colour. On such a screen, main's Codex reader finds no composer, and every idle pane wears the
unread card. This matters outside the canary as well: a Codex started in a session no client ever
attached to looks like that. A person's terminal always answers, and Herdr answers a pane from what
its client reported. So the canary attaches one client of its own (`client.ts`) in a PTY it hosts
(`Bun.Terminal`), answers the colour queries with a fixed dark palette, and keeps the client on the
`canary-view` workspace. Nothing but those answers is ever written to it.

**Folder trust.** Both agents ask about the fresh project, and the canary answers like a person:

- Claude Code 2.1.283 starts the pointer on "No, exit", so the canary presses Down, re-reads, then
  presses Enter. Herdr reports this screen as `blocked`.
- Codex 0.156.1 asks even with `-c 'projects."<dir>".trust_level="trusted"'`, and even with `-a`
  and `-s`. Herdr reports this screen as `idle`, which is why readiness also needs no startup
  question on screen.
- A plain folder inside a trusted git repo inherits Codex trust; a nested git repo does not.

The project folder is always `/tmp/collie-canary-project`, emptied and rebuilt each run, so the
agents keep ONE trust entry for it in `~/.codex/config.toml` and ONE project entry in
`~/.claude.json`, not one per run. The canary does not edit those files. After the first run the
folder is trusted, so the trust question no longer appears; the canary still answers it when it does.

**Inherited markers.** A Claude started with `CLAUDE_CODE_CHILD_SESSION` in its environment saves
no transcript and says so in the status row. The canary removes the `CLAUDE_CODE_*`, `CLAUDECODE`
and `HERDR_*` variables before it starts the server.

**Models.** claude runs Haiku (`--model haiku`), codex its default model at low effort
(`-c model_reasoning_effort="low"`), pi its default model with `--thinking off` and
`--no-session`, and opencode its default model. All are flags, none touches the operator's config.

## Traps kept from the hand runs

- Ctrl+C on an EMPTY Codex composer exits Codex. The canary never sends it to Codex; drafts are
  cleared with a Backspace sweep.
- Two Ctrl+C within about a second exit Claude. Ctrl+C is Claude's fallback only, sent once, then
  the canary waits 1.5 s.
- `herdr pane read --format ansi` returns raw text, not JSON. The canary reads panes through the
  bridge's `readPane` instead, which is what the phone reads.
