# The harness canary

`bun run canary` starts claude, codex, opencode and pi, and grok, hermes, agy, omp and muse when `--agent`
names them, in a Herdr session of its own, types drafts
and a few real sends, and checks with Collie's own code what the phone would read and whether each
send lands. It then reads the session each agent WROTE, with the bridge's own journal adapter, and
fails on a row or content type the reader does not recognise. With `--dialogs` it also opens real
dialogs and sends to a busy agent, and with `--scenario options` it starts each New-sheet option once.
Specs: M37/02, M37/03 and M41/05 in the workspace tracker.

```sh
bun run canary                          # all four agents, the six default scenarios
bun run canary --dialogs                # plus dialogs and busy (more model turns)
bun run canary --agent claude,codex     # some agents
bun run canary --scenario idle,drafts   # some scenarios, no model turns
bun run canary --keep                   # leave the session up for a look
bun run canary --agent claude,codex --scenario options   # each New-sheet option, started once
bun run canary --record                 # write clean agents into the ledger
bun run canary --readers /tmp/c1131     # judge with another checkout's readers
```

Exit 1 means a scenario failed. Captures and `summary.json` go to
`/tmp/collie-canary/<run-id>/<agent>-<version>/`. They are never copied into `web/src/fixtures/`.

grok, hermes, agy, omp and muse run only when `--agent` names them, because their sends spend each
vendor's own quota. The `options` scenario is never part of a default run: it starts the agent once
per option the New sheet offers (`bridge/launcher-recipes.ts`), with the line the bridge builds, and
passes when Herdr shows the agent up, idle or asking a question first. It makes no model turn.

### Another provider: `--via`

```sh
COLLIE_GROK_ROOT=/path/to/grok-home/sessions \
  bun run canary --agent claude,grok --via /path/to/launchers
```

`--via DIR` starts an agent through `DIR/<agent>` when that file is executable, in place of the
agent's own command word; the rest of the line stays the canary's. An agent with no launcher there
starts as usual, and the log line says which. The version is read with the profile's own version
command on PATH, not through the launcher: a launcher should change the provider and run the same
installed agent, and the canary does not check that it does.

A launcher is yours to write, outside this repo: it points the agent at another provider and ends
in `exec <agent> "$@"`, so Herdr sees the agent itself. It covers the six default scenarios only;
`dialogs`, `busy` and `options` start their own lines.

A launcher that moves the agent's home (`GROK_HOME`, `PI_CODING_AGENT_DIR`, `HOME`) moves its log
too. Point the journal at it with the bridge's own override for that agent, `COLLIE_GROK_ROOT`,
`COLLIE_PI_ROOT` or `COLLIE_MUSE_ROOT` (a comma list), in the canary's environment.

## What it checks

Six scenarios per agent run by default; the seventh, `options`, runs only when `--scenario` names it, and
grok, hermes, agy, omp and muse are the five opt-in agents that run only when `--agent` names them. Only
`sends` makes model turns: four per agent.

| id           | what the canary does                                          | what must hold                                         |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| `idle`       | starts the agent and waits for Herdr's idle                   | composer ready (adapter agents), raw blocks, no card   |
| `drafts`     | types the 15 message kinds, never submits them                | the draft reads back, composer ready, no card          |
| `sends`      | sends plain, a `────` rule, Chinese and one file read         | outcome `sent`, the message and an OK below it         |
| `journal`    | reads the session those sends wrote, with the journal adapter | a user item, a tool item, a reply, nothing unrecognised |
| `narrow`     | restarts at 50 columns, idle plus two drafts                  | the same as `idle` and `drafts`                        |
| `start-exit` | samples every 150 ms while starting and after exiting         | no unread card                                         |

The message kinds live in `messages.ts`: the 14 hand kinds of 2026-09-26, plus `15-rule`, a
pasted `────` line. All four agents are read with their adapters, pi since 2026-10-12, so a pi send
goes through the guarded path and its draft must read back.

### The journal (spec M41/05)

`journal` is the only scenario that reads something other than a screen: what the phone's Chat mode
would make of the agent's OWN session log. It costs no model turn of its own, and it has nothing to
read unless `sends` ran in the same pane, which is why the two sit next to each other.

Two gates. The ITEM KINDS: the adapter must yield a user item carrying a prompt the canary itself
typed, a tool item, and a reply below the prompt. The UNKNOWNS: every reducer counts the row kinds
and content kinds it had no branch for (`bridge/journal/reduce.ts`), and the run fails above zero,
naming the type. That second one is a gate against a format change nobody has written a test for.

- **Nothing is saved, not even under `/tmp`.** The screen scenarios write an `.ansi` capture per
  case; a session log may not be written anywhere, because a Claude JSONL carries file contents from
  every Read and environment from every Bash. Only counts and item kinds reach `summary.json`.
- **The session comes off the PANE RECORD** (`agent_session`), exactly as the bridge's history route
  takes it. The canary never picks the newest file in a root: that would be reading somebody else's
  session.
- **Every way of having nothing to read is `not-reached`**, never a fail: no journal adapter for the
  agent, no session reported (Codex reports only once its first prompt is submitted, and every agent
  needs `herdr integration install <agent>`), a ref that resolves to no log, or a model that
  answered in words and opened no tool call at all.
- **The fourth send asks for a file READ, not a shell command.** Claude Code asks before Bash in its
  default mode, so "run `echo`" would park the pane on a permission dialog with nobody to answer it.
  The file is the `README.md` that `freshProject()` commits.
- **A `CLAUDE_CONFIG_DIR` in this process's environment becomes a journal root.** Herdr's panes
  inherit that variable, so the Claude in a pane writes into that profile's `projects` tree;
  `journal.ts` derives the root rather than reading "no log" and saying nothing about the reader.
- **grok and hermes are not canary agents**, so their reducers are gated by `bun test
  bridge/journal/unknowns.test.ts` alone.

### Dialogs and busy (`--dialogs`, spec M37/03)

Two more scenarios, off by default because they make more model turns: about 8 for Claude, 4 for
Codex, 2 for OpenCode, 2 per agent for `busy`. Each opens its own panes.

| id        | what the canary does                                          | what must hold                                           |
| --------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `dialogs` | asks Claude for a Bash command, a WebFetch, an AskUserQuestion and (in a plan-mode pane) a plan; asks Codex (`-a on-request -s read-only`) for a command and a file edit; asks OpenCode (a scratch config that asks for bash and edit) for a command, opens its "Always allow" step and cancels it, then asks for a file edit | a choice card with the right family and labels, no card; the pointer on rows 1 to 3, the Tab amend note and "Type something" lock or unlock the buttons as the reader says; the declining key closes the dialog and the file is not written; Apple's key answers |
| `busy`    | starts a 500-word story, then sends "Queued note: reply with only OK." while Herdr says `working` | outcome `sent`, the note answered below it, and no unread card on any sample while the agent works |

Keys are pressed only where the recipe was measured live: a permission dialog's "No" digit,
Escape out of the amend note, an AskUserQuestion option's digit, Codex's decline, and on OpenCode
the buttons' own walk (`Right`, then `Enter`) for "Allow always", "Cancel" and "Reject", and Escape,
its declared cancel key, on the edit. "Confirm" is never pressed: it would allow the pattern until
OpenCode restarts. Plan approval is read and never answered. A dialog the model does not open (it answers in words instead) is
`not-reached`. The dialog screens are saved as `dialogs-<case>.ansi`.

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
refuses when `--readers` points at another checkout, and it never creates the ledger. An agent started
through a `--via` launcher is not recorded: its version was read from PATH, not from the launcher.

A passing `journal` scenario also writes the JOURNAL reader's own line, in that entry's `journal`
block beside the screen reader's (spec M41/05). The two are recorded apart because they drift apart:
a vendor can change what it paints without changing what it writes. `bun run harness:drift` prints a
row per reader for that reason. A block is added by hand, never by a run — the canary refreshes
facts, it does not decide which readers an agent has.

## The nightly lab (M56 spec 10)

`bun run harness:lab` runs each new agent version through a lab, once. The lab carries four older specs of milestone M44.
They are the slash-command walk (spec 05), the run on a version change (spec 06),
the corpus rule in CI (spec 07) and the soft release gate (spec 08).

```sh
bun run harness:lab --plan                       # read the feeds and the ledger, run nothing
bun run harness:lab                              # run each version that has no row, at most four
bun run harness:lab --version claude=2.1.301     # one named pair
bun run harness:lab --version claude=2.1.301 --no-publish   # run the legs, make no commit
bun run harness:lab --leg phone --version claude=2.1.301    # the phone leg alone, on a scratch bridge
bun scripts/harness-canary/watch.ts              # the same lab, for an installed agent newer than the ledger
```

**The feeds.** Claude Code and Codex use the npm dist-tag `latest`. pi and opencode use the latest GitHub release.
A feed is a plain HTTPS GET with no token.

**One run.** The lab installs the binary at that version with `npm install` into its own folder, never global.
It starts a throwaway tmux server with `tmux -f /dev/null -L harness-lab-<pid>`. The person's tmux server is never touched.
Claude gets an isolated `CLAUDE_CONFIG_DIR` under `~/.cache/collie-lab/harness-lab/<harness>-<version>/`.
Claude starts with `--strict-mcp-config` and an empty MCP config, so no MCP server of the person runs.
The lab deletes that folder at the end.

1. The walk. The lab types `/` and reads the whole slash menu.
   It takes each command on the safe list in `slash-commands.json` and types it.
   It checks that the menu points at the command. Only then it presses Enter.
   It reads the screen with the Surface and presses Escape until the box is free.
   A command on neither list is reported as unclassified and never sent.
   A command the menu marks "(removed)" is reported as removed and never sent, by any leg, on any list.
   A command that changes an account setting on the server is on the unsafe list.
2. The Surface reads every screen the walk reaches.
   When a dialog screen reads `free`, the lab presses Escape once and ends the walk.
   The run is then a fail, and it makes no send and no ask.
3. One probed send. The lab sends one short message through the send protocol and reads the receipt.
4. One ask answer. The lab asks for a command that needs a permission, lifts the dialog and answers No through the protocol.
   The file the command would make must not exist.

5. The phone leg. Claude only. The lab drives a bridge over HTTP, the way the phone does.
   Steps 3 and 4 call the send protocol inside the lab process. The phone leg does not.
   It sends every request with a device token (`Authorization: Bearer`), the bridge's own `Origin` and `x-requested-with`.
   It judges each send by the receipt the bridge answers and by the Surface in `/api/snapshot`.
   Details are in "The phone leg" below.

**Pass.** No dialog screen reads `free`. The send settles. The ask answer settles (`sent` or `effective`), and the declined file does not exist.
No phone scenario fails. A phone scenario that is `not-reached` does not fail the run.
A dialog that no reader lifts is a fail, and the reason says so.
Only a harness with a profile under `web/src/lib/surface/profiles/` runs steps 3 and 4.
The others run the walk only, and the row says `walk-only`.

**The lab clone.** The lab never writes into the repo it is given. It keeps a clone under
`~/.cache/collie-lab/harness-lab/clone`. It makes the clone from the origin URL of `--repo` on first use.
It resets the clone to `origin/main` before each pass commit.
The lab refuses a `--repo` under `~/apps` and a checkout with a detached HEAD.

**What a pass leaves.** One commit on the branch `harness-lab/<harness>-<version>`, in the lab clone.
A scratch worktree sits under `~/.cache/collie-lab/harness-lab/worktrees/`.
The commit touches two files: `web/src/lib/harness/verified-versions.json` and the profile's verified range.
The run log is the commit body, and the body states the real send and ask results.
The script never pushes. A person reads the branch and merges it.
A pass whose commit fails writes a `failed` row with the reason, not a `pass` row.

**What a fail leaves.** An issue as files, `issues/<harness>-<version>.json` and `.md`, under the lab folder.
They hold the title, the label `harness-drift`, the redacted screens, the Surface verdict of every screen and the counters.
The ritual never opens the issue. The issue is public, so a person shows the draft to Altan and posts it after a yes.
`gh issue create` runs only with `--open-issue` on a hand run. It checks first that the label exists in the target repo.
It says so, and stops, when the label is missing.

**To run a failed version again.** Delete its row from the ledger file by hand, then run the lab.
The lab has no `--retry` flag on purpose, because a flag could repeat a paid action without a person looking.
Read the log first. A `failed` row names the reason in its note.

### The phone leg

The phone leg finds bugs that only show over HTTP: a refusal the phone cannot read, a send that a
running turn swallows, a command that ends typed but not sent. It runs in two modes.

```sh
bun run harness:lab --leg phone --version claude=2.1.302                 # a scratch bridge
bun run harness:lab --leg phone --version claude=2.1.302 \
  --bridge http://127.0.0.1:8788 --token-file ~/phone-token.txt          # a bridge that already runs
```

**The scratch bridge.** In a full run the leg runs after step 4, in the same tmux server.
The lab starts `bridge/index.ts` of this checkout as a child process. It binds `127.0.0.1` on a free port.
It never takes a port from 8787 to 8799. The bridge gets a temporary `HOME` and `COLLIE_STATE_DIR` inside the run folder,
the lab's tmux server, and the lab's installed agent binary first on its `PATH`.
The lab writes one paired device into that state folder and keeps the token in memory only.
The phone panes use a second login copy with Collie's beacon hooks, so a send can end `effective`.
The bridge starts with a fresh state folder every time, so no counter or daily cap of an earlier run reaches it.
At the end the lab stops the bridge and deletes its folder. The bridge log goes into the captures folder, redacted.

**A running bridge.** `--bridge` takes an origin on this machine, such as `http://127.0.0.1:8788`.
`--token-file` names a file that holds a device token. Pair that device by hand first.
The leg makes its own panes with `POST /api/workspace`. It refuses to name any other pane, and it closes its panes at the end.
It starts and stops nothing else. The lab's hooks cannot reach that bridge's state folder,
so a send there may end `sent` or `effective`, and both count.

**The scenarios.** Each scenario gets its own pane. The leg sends the start line into the shell pane like a person.
A shell has no profile, so the bridge types the line and presses Enter blind. The first answer must be `sent`.
A `refused unconfirmed` there fails the scenario as "shell send needs two taps". The leg then taps commit with the rows hash, so the scenario still runs.
Claude asks for folder trust before its hooks run. The bridge still sees a shell then, so the leg answers with the Keys board.
The leg reads the `/` menu once per run, with the walk's own reader, through the phone's Type and Keys board.

1. `idle-send`: one message into a free box ends `sent` or `effective`.
2. `stream-sends`: a prompt for 120 fruit names, then four sends at 3, 5, 6 and 7 seconds.
   Every receipt must end `effective` within two minutes, and the box must be empty. A refusal or `typed_not_submitted` fails.
3. `turn-end-send`: the leg reads the snapshot every 200 ms and sends at the flip from running to idle.
4. `command-slash`: `/model` must end `sent` and show a readable menu ask within 5 seconds. The leg closes it with Escape.
   Then `/help` and every belt command on the safe list. `/clear` and `/compact` are never sent.
   A command that ends typed but not sent gets the phone's Discard, and a capture of that screen.
   The belt is the operator's bar rows from `/api/config`, or else the shipped Claude belt in `web/src/lib/harness-bar.ts`.
5. `ask-answer`: the leg asks for a `touch` command and answers No through `/api/ask`. The file must not exist.
6. `send-on-agents-screen`: the leg looks for a command that opens a screen of its own over the conversation.
   It tries `/agents`, then each safe command that opens a dialog, and reads the screen for a row that the Claude profile
   names as another screen's (`otherScreens`, the agents screen's "enter to return" footer).
   When none opens one, the scenario is `not-reached` with "no full-screen command on this version".
   On that screen a message must end `refused` with a readable sentence. After Escape the same message must go in.
7. `crew-send`: always `not-reached`, because the lab has no crew member yet.

A scenario passes, fails or is `not-reached`, as in the canary. A known gap uses the name `phone:<scenario>` in `known-gaps.json`.

**What it leaves.** One `.ansi` capture per scenario and a `summary.json` with the receipts,
under `~/.cache/collie-lab/harness-lab/phone/<harness>-<version>-<time>/`. Nothing goes into `web/src/fixtures/`.
In a full run the phone lines go into the ledger row, the commit body and the issue.
The `summary.json` also holds the `/` menu the leg read, with the commands it marks removed.
A run of the phone leg alone never makes a commit. Its ledger gets the suffix `leg-phone`, so it never blocks the nightly run of the same version.
Its lab folder is `leg-phone/ledger-<hash>/`, one per ledger. A run's start sweep deletes every run folder its own ledger does not know,
so two hand runs with two ledgers in one folder would delete each other's run folder.

### What one run costs, and what stops a repeat

- Time: about one minute of machine time. The first live run on Claude 2.1.301 took 49 seconds.
  It did an npm install, read 98 menu commands, sent 19 safe commands and made three model turns.
  The phone leg adds about two minutes.
- Model turns: at most four, on the person's Claude subscription. The plan uses three: the send, the ask request and what Claude does after a No.
  A harness without a profile uses none. The phone leg adds at most 14 more. A scenario that would pass that cap is `not-reached`. The ritual's own `claude -p` session is extra: Sonnet, at most 25 turns.
- Keys: the lab presses about 150 keys. Most of them are Down presses that read the menu.
- Network: the feed reads, and one npm install of about 250 MB.
- A `(harness, version)` pair that has a row in the lab ledger never runs again. Pass, fail, failed and walk-only all count.
  The ledger is `~/.local/state/collie-harness-lab/ledger.json`. Set `COLLIE_HARNESS_LAB_LEDGER` to use another path.
- The lab writes a `running` row, with its process id, before its first paid step.
  A run that dies leaves that row. The next run start turns a row with a dead process into `failed`.
  After three hours any `running` row becomes `failed` too. So the next night skips the pair.
- A run that cannot finish writes a `failed` row. The install is tried twice, because it costs no model turn. Nothing else is retried.
- A run that cannot start writes no row and costs nothing. This happens when the Claude login has less than 25 minutes left, or tmux or npm is missing.
  It writes one line to `notify.log`, so a silent night is visible. The next run tries again.
- The operator is told once per version and verdict. The ledger row keeps what was told.

### How it protects the login

The lab copies `~/.claude/.credentials.json` into the isolated folder with the refresh token removed.
A refresh inside the lab would rotate the person's real refresh token and could log them out.
The copy has only the access token. The lab refuses to start when that token has less than 25 minutes left.
A live Claude session refreshes it.

The copy must never outlive the run. A SIGTERM, a SIGINT or an uncaught error deletes the run folder first.
Then it stops the tmux server and writes a `failed` row. A SIGKILL that follows finds no copy.
`main.ts` and `watch.ts` also sweep before any plan or run, so a night with no new version still cleans up.
The sweep deletes every run folder whose ledger row is not a live `running` row.
It kills every `harness-lab-<pid>` tmux server whose process is dead.

The lab redacts every screen, log line and issue body before it writes it. It removes the home folder, the user name,
the host name, the account display name, the organization name and e-mail addresses.
It also removes anything shaped like a key or a token. A word such as `skill` is not a key.

### The ritual

The darius ritual `nightly-harness-lab` is defined in the workspace `.darius.toml` with `mode = "off"`.
It is not enabled. Altan and the lead enable it later.
Its skill file says the same cost and stop rule. The darius timer runs every 15 minutes,
so a mode change during the day starts a run at once.
`watch.ts` is not part of the ritual. A person runs it by hand. It shares the ledger with the lab.

### The soft release gate (M44 spec 08)

`bun scripts/harness-drift.ts --strict` exits 1 when an installed agent is newer than its verified version.
`scripts/check-tag.sh` runs it before it prints the tag command.
To tag over a drift, name it on purpose: `scripts/check-tag.sh --accept-drift claude=2.1.301`.
The version must be the installed one. The tag message then carries `Not verified: claude 2.1.301`.
The release page gets a small heading `Not verified` and one sentence that names the agent and the version.

This gate is a reminder, not proof. It sees only the agents installed on this machine.
It starts no agent and makes no network call. It never says that a reader is right.
The gate tells you to merge a lab branch only when that branch is in the lab clone.

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

**Journal roots.** The journal scenario reads the logs the agents write into their ordinary homes:
the canary does not relocate `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or the rest, because an agent started
with a fresh config has no credentials and cannot run at all. So a run leaves one small session file
per agent behind, in that agent's own sessions directory, holding the canary's four prompts and one
read of a scratch `README.md`.

**Models.** claude runs Haiku (`--model haiku`), codex its default model at low effort
(`-c model_reasoning_effort="low"`), pi its default model with `--thinking off` and
`--no-session`, and opencode its default model. All are flags, none touches the operator's config.

**OpenCode's permission dialogs need a config.** OpenCode 1.18.32 asks before a tool only when its
config says `ask`. The dialogs scenario writes `opencode-ask.json` into the run's capture folder
(`permission` set to `ask` for `bash` and `edit`) and starts that one OpenCode with
`OPENCODE_CONFIG` pointing at it. OpenCode merges that file over its usual config for this one
process; nothing in `~/.config/opencode` is written.

## Traps kept from the hand runs

- Ctrl+C on an EMPTY Codex composer exits Codex. The canary never sends it to Codex; drafts are
  cleared with a Backspace sweep.
- Two Ctrl+C within about a second exit Claude. Ctrl+C is Claude's fallback only, sent once, then
  the canary waits 1.5 s.
- `herdr pane read --format ansi` returns raw text, not JSON. The canary reads panes through the
  bridge's `readPane` instead, which is what the phone reads.
