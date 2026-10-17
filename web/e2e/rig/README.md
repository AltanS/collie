# The browser leg

A Playwright phone (Chromium, Pixel 7 descriptor) opens a scratch Collie bridge. The bridge mirrors a
scratch Herdr server, and real Claude Code, pi and omp run in it. The phone taps cards the way a
person does. Each case checks that a tap works on the first tap and that the screen shows the result.

Tier 1 (`web/e2e/*.spec.ts`) answers the API from fixtures. Tier 2 (`web/e2e/live/`) reads the dev
lane. This leg starts its own bridge and Herdr, writes to them, and spends model turns. It is not
the VM lab that CLAUDE.md calls Tier 3. It never runs in CI: its config throws when `CI` is set, and
Tier 1's config ignores `e2e/rig/`.

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

- Claude: 5 model turns on Haiku: the permission request, the pick-many question, the long list plus
  one message sent while it streams, and one prompt that makes 48 Read calls. The picker needs no
  turn. A run caps each harness at 15 turns (`TURN_CAP` in `leg.ts`), and every turn is logged in
  `~/.cache/collie-lab/browser-leg-state/turns.log`.
- pi and omp: 5 turns each on Haiku 4.5 with a key file, none without. Their "Load older" history is
  one prompt and 45 shell lines (`!echo`), which run without the model. omp's permission case runs
  omp with `--approval-mode write`, so a bash call asks.
- Time: about 2 minutes for Claude alone, about 6 with pi and omp. A case that waits out its reply
  timeouts adds up to 4 minutes.

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
- Processes it did not start. Every kill is by a recorded pid after `/proc/<pid>/cmdline` matched.
