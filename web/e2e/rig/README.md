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

- **Before every release tag**, on the release head. All fifteen cases (three harnesses, five cases
  each) pass on the first tap. A case that fails, or is not reached, holds the tag.
- **Before merging a change** to a harness reader, the Surface, the Send Protocol or the ask code. Run
  it on the branch. A unit test cannot show that a tap works on a real screen.
- **Every night**, on `origin/main`, through `nightly.ts` (below).

One run costs about 5 minutes, about 5 Claude Haiku turns on the subscription, and about 5 pi turns
and 5 omp turns on OpenRouter Haiku 4.5 (a few cents). The turn cap is 15 per harness. "Cost of one
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

Herdr binds its sockets under its `XDG_CONFIG_HOME`, and a Unix socket path holds at most 107 bytes on
Linux (103 on macOS). A long state root, such as the nightly runner's, would push the path over that, and
Herdr would exit with "local socket name length exceeds capacity of sun_path". So the rig keeps this one
folder outside the state root: `$XDG_RUNTIME_DIR/collie-rig-<8 hex>`, or `/tmp/collie-rig-<8 hex>` when
that is unset, mode 0700. The hex is a hash of the state root, so two rigs with two state roots never
share a folder. `up` checks the path length first and stops at once with the path and its size
(`sock-path.ts`); `down` removes the folder. Everything else of the rig stays under the state root.

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

- Claude: 5 model turns on Haiku: the permission request, the pick-many question, the long list plus
  one message sent while it streams, and one prompt that makes 48 Read calls. The picker needs no
  turn. A run caps each harness at 15 turns (`TURN_CAP` in `leg.ts`), and every turn is logged in
  `~/.cache/collie-lab/browser-leg-state/turns.log`.
- pi and omp: 5 turns each on Haiku 4.5 with a key file, none without. Their "Load older" history is
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
- The operator's agent config. Each harness gets a scratch config under
  `~/.cache/collie-lab/browser-leg-state/harness/<id>/`. Only what it needs is copied there at
  0600: Claude's OAuth file without its refresh token, omp's `agent.db`, and pi's `auth.json` only
  when no key file is set. The bridge reads the journals of these scratch homes, never
  `~/.claude/projects`.
- The checkout the nightly runner starts from. It works in its own clone, ledger and logs only.
- Processes it did not start. Every kill is by a recorded pid after `/proc/<pid>/cmdline` matched.
