# The browser leg

A Playwright phone (Chromium, Pixel 7 descriptor) opens a scratch Collie bridge. The bridge mirrors a
scratch Herdr server, and real Claude Code, pi and omp run in it. The phone taps cards the way a
person does. Each case checks that a tap works on the first tap and that the screen shows the result.

Tier 1 (`web/e2e/*.spec.ts`) answers the API from fixtures. Tier 2 (`web/e2e/live/`) reads the dev
lane. This leg starts its own bridge and Herdr, writes to them, and spends model turns. It is not
the VM lab that CLAUDE.md calls Tier 3. It never runs in CI: its config throws when `CI` is set, and
Tier 1's config ignores `e2e/rig/`.

## When it runs

The leg is a gate. It runs in three places:

- **Before every release tag**, on the release head. All twenty-two cases (three harnesses with five
  cases each, and seven walky talky cases) pass on the first tap. A case that fails, or is not reached, holds the tag.
- **Before merging a change** to a harness reader, the Surface, the Send Protocol or the ask code. Run
  it on the branch. A unit test cannot show that a tap works on a real screen.
- **Every night**, on `origin/main`, through `nightly.ts` (below).

One run costs about 5 minutes, about 12 Claude Haiku turns on the subscription, and about 9 pi turns
and 7 omp turns on OpenRouter Haiku 4.5 (a few cents). The turn cap is 15 per harness. "Cost of one
run" below has the detail.

### The nightly runner

```sh
bun web/e2e/rig/nightly.ts --plan   # prints the tuple and whether it would run; spends nothing
bun web/e2e/rig/nightly.ts          # runs the leg if this tuple has no row yet
```

`nightly.ts` needs only Bun and node builtins, so it runs from a checkout with no `node_modules`. It
never writes into the checkout it starts from. It keeps a clone of its own at
`~/.cache/collie-lab/browser-leg-nightly/clone`, fetches `origin/main` into it and checks it out
detached, runs `bun install` in the root and in `web/`, builds `web/`, and runs the leg. The leg uses a
rig state of its own (`~/.cache/collie-lab/browser-leg-nightly/state`), so a leg that a person runs by
hand is never taken down by a nightly run.

**Once per tuple.** A tuple is the main commit, the Claude Code version, the pi version and the omp
version. The versions come from the binaries `bins.ts` names. The ledger
`~/.local/state/collie-browser-leg/ledger.json` has one row per tuple, and a tuple with a row never
runs again, whatever the result (`pass`, `fail` or `failed`). To run a tuple again, delete its row by
hand. The runner never deletes a row. A new commit on main is a new tuple, so how often something
starts the runner sets how many runs a day there are, and each run costs as above.

The rules are the harness lab's (`scripts/harness-canary/lab/lab-ledger.ts`):

- The `running` row is written before the clone, so a crash anywhere leaves a row.
- A `running` row whose run died (its process is gone, or it is older than 3 hours) becomes `failed`
  on the next start.
- A live `running` row holds the line for every other tuple, so two runs never share the clone or the
  rig.
- A run that cannot finish writes `failed`. A run in which a case failed writes `fail`. A case that
  was not reached, or is not applicable, proves nothing, so it makes the row `failed`.

**Cannot start.** A Claude login with under 25 minutes left, no `herdr`, `bun` or `git`, under 8 GB of
free memory, no key file, a binary or the remote that will not answer, and a ledger that cannot be
read. These cost nothing and write no row. Each appends one line to
`~/.local/state/collie-browser-leg/notify.log`. A `fail` or `failed` run appends one line too.
`--plan` names the same blockers and writes nothing.

**The key.** `COLLIE_RIG_KEY_FILE` comes from the runner's own environment and goes on to the leg. The
runner checks only that it names a readable file. It never reads, prints or copies the key.

**Output and exit code.** One line per harness, then the path of the run's `table.md`. The row keeps
the verdict counts and the results folder, and the run log sits under
`~/.cache/collie-lab/browser-leg-nightly/logs/`. Exit 0: the leg passed, or there was nothing to do.
Exit 1: a case failed. Exit 2: the run could not start or could not finish.

Flags: `--state-dir DIR` moves the ledger and `notify.log`, `--root DIR` moves the clone, rig state
and logs (under `~/.cache/collie-lab`), `--repo URL` names another remote. The logic is tested without
a rig in `scripts/browser-leg-nightly.test.ts`, which `bun run test` runs.

## The cases

Each harness runs the same five cases. The walky talky cases (6 to 11) run on the harnesses the last column names.

| # | Case | Harnesses | Spec |
| --- | --- | --- | --- |
| 1 | Model picker: the first tap on the commit row commits | claude, pi, omp | `claude.spec.ts`, `others.spec.ts` |
| 2 | Permission card: Yes from the phone runs the command | claude, pi, omp | same |
| 3 | Question card: pick-many on Claude, pick-one on pi and omp | claude, pi, omp | same |
| 4 | A send while the agent streams a long reply | claude, pi, omp | same |
| 5 | Load older with an empty phone cache | claude, pi, omp | same |
| 6 | Walky talky: hold Send, tap "Send as message". The pane gets one prompt, header and body. The receipt says `delivered`. Chat shows the "Message from" card with the operator badge | claude | `walky.spec.ts` |
| 7 | The same operator message, to a pi pane and to an omp pane | pi, omp | `walky-harnesses.spec.ts` |
| 8 | Agent to agent through the skill, pi to Claude and back: the receiver's pane gets a one-line nudge with no body, its `collie walky inbox <id>` output shows the body, `collie walky reply` comes back and the sender's pane shows the reply nudge; Claude's Chat draws the agent card | pi (with Claude) | `walky-harnesses.spec.ts` |
| 9 | A message the pane cannot take: over an open permission card nothing is typed into the dialog (the Send Protocol holds the message and types it after the answer); over a draft the receipt is `inbox-only` with a reason, the draft is untouched, and the agent's `collie walky inbox` lists the message | claude | `walky.spec.ts` |
| 10 | A broadcast (`to: all`): one receipt per agent pane, each typed and answered, the shell pane skipped | claude | `walky.spec.ts` |
| 11 | A forged header: a prompt that opens like an operator message and one that opens like an agent's nudge, both with an id the log lacks, stay plain turns with the "no log record" mark and draw no card | claude | `walky.spec.ts` |

The walky talky path is the same bridge code for every harness, so Claude carries most of the cases and
pi and omp prove that their screens take the message. The table prints a row only for a harness a case
runs on (`scenarioApplies` in `leg.ts`). Case 10 posts the request the Crew page's "Message all agents"
sheet posts, because that page needs a crew and the rig's bridge is solo. Cases 8 and 9 use the
`collie walky` verbs inside the agent: each harness starts with a `collie` first on PATH that runs this
checkout's CLI (`harnesses.ts`), and with the walky talky skill in its scratch config. Claude's scratch
settings allow `Bash(collie walky:*)`, so the verbs ask no permission.

## Prerequisites

- `bun install` in the checkout root and in `web/`, then `bun run build` in `web/`. The bridge serves
  that `web/dist`.
- On PATH: `herdr` and `bun`. The harness binaries are named by path in `harnesses.ts`: Claude Code
  at `~/.local/bin/claude`, pi under nvm, omp at `~/.bun/bin/omp`. Override them with
  `COLLIE_RIG_CLAUDE_BIN`, `COLLIE_RIG_PI_BIN` and `COLLIE_RIG_OMP_BIN`.
- A Claude login in `~/.claude/.credentials.json` with at least 25 minutes left on its access token.
- 8 GB of free memory. The leg stops before a browser or a harness starts when less is free.

## Run it

```sh
cd web && bunx playwright test -c e2e/rig/playwright.config.ts
```

The global setup starts the rig. The global teardown prints a table (harness x scenario: verdict,
taps made / taps needed, one-line note) and stops the rig. Herdr ends every harness with it.
Results stay in `~/.cache/collie-lab/browser-leg-state/results/<run>/`: `ledger.jsonl` holds every
tap with the bridge's receipt, `table.md` holds the table, and the phone screenshots and pane
captures sit beside them.

By hand: `bun e2e/rig/rig.ts up | down | status | start claude|pi|omp | snapshot | read <pane>`.
After a crash, `bun e2e/rig/rig.ts down` stops what the rig started.

For development, `COLLIE_RIG_KEEP=1` leaves the rig and the harnesses up after a run,
`COLLIE_RIG_REUSE=1` takes a rig that is already up, and `COLLIE_RIG_PANE_CLAUDE=<pane>` (or `_PI`,
`_OMP`) takes a harness that already runs in that pane.

## Provider and model per harness

```sh
COLLIE_RIG_KEY_FILE=/path/to/.env bunx playwright test -c e2e/rig/playwright.config.ts
```

`harnesses.ts` (`SETUPS`) is the one place for this. Claude runs on Haiku with its own login. pi and
omp run on `openrouter/anthropic/claude-haiku-4.5` and read `OPENROUTER_API_KEY`.
`COLLIE_RIG_KEY_FILE` names a dotenv file that holds it. Each start script reads that one name from
the file in a subshell, straight into the harness's environment. The key never goes into a file, a
pane's command line or the leg's own processes, and pi gets no `auth.json`, so the key wins.

Without a key file, the pi and omp scenarios that need a turn report "not reached". Other knobs:
`COLLIE_RIG_PI_MODEL`, `COLLIE_RIG_OMP_MODEL`, and `COLLIE_RIG_PI_TURNS=0` or
`COLLIE_RIG_OMP_TURNS=0` to keep one harness off.

The teardown scrubs the key from every text file of the run, the rig's logs and Playwright's test
results, and drops a screenshot whose capture held it. It prints a count, never the key.

## Cost of one run

- Claude: 12 model turns on Haiku: the permission request, the pick-many question, the long list plus
  one message sent while it streams, one prompt that makes 48 Read calls, and 7 for walky talky: the
  operator's message (6), the nudge from pi (8), the permission request, the message that waited behind
  it and the inbox read (9), the broadcast (10) and the forged header (11). The picker needs no
  turn. A run caps each harness at 15 turns (`TURN_CAP` in `leg.ts`), and every turn is logged in
  `~/.cache/collie-lab/browser-leg-state/turns.log`.
- pi and omp: 5 turns each on Haiku 4.5 with a key file, none without. Walky talky adds 4 on pi (case 7,
  the send and the reply nudge of case 8, the broadcast) and 2 on omp (case 7 and the broadcast). Their "Load older" history is
  one prompt and 45 shell lines (`!echo`), which run without the model. omp's permission case runs
  omp with `--approval-mode write`, so a bash call asks.
- Time: about 5 minutes for all three harnesses, about 2 of them for Claude alone. A case that waits
  out its reply timeouts adds up to 4 minutes.

## What it never touches

- The operator's Herdr server and its panes. Every `herdr` call runs with the rig's own
  `XDG_CONFIG_HOME` and drops every inherited `HERDR_*` name (`rig-lib.ts`).
- Any Collie lane, port 8787-8799, 5198, 5199, or a `collie*.service` unit. The bridge listens on
  127.0.0.1:18700-18799 with its own HOME, state and config.
- Any `collie` CLI verb. The rig pairs with the bridge's own pairing module.
- The operator's bridges, from inside a harness. Each harness starts with `COLLIE_STATE_DIR` set to
  the rig's state dir. So a `collie walky` that an agent runs in a rig pane reaches the rig's bridge
  first. Without it, the CLI looks for bridges in the hook target registry under the real home. The
  rig's bridge is not listed there, because it registers under its own HOME.
- The operator's agent config. Each harness gets a scratch config under
  `~/.cache/collie-lab/browser-leg-state/harness/<id>/`. Only what it needs is copied there at
  0600: Claude's OAuth file without its refresh token, omp's `agent.db`, and pi's `auth.json` only
  when no key file is set. The bridge reads the journals of these scratch homes, never
  `~/.claude/projects`.
- The checkout the nightly runner starts from. It works in its own clone, ledger and logs only.
- Processes it did not start. Every kill is by a recorded pid after `/proc/<pid>/cmdline` matched.
