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

`harnesses.ts` (`SETUPS`) is the one place for this. Claude runs on Haiku. pi and omp default to
`openrouter/anthropic/claude-haiku-5.5`, and their model turns are off. On 2026-10-17, pi's only key
(OpenRouter) answered 401, and omp had no credential. Their scenarios that need a turn report "not
reached" with that reason. When a working provider exists, turn them on:

```sh
COLLIE_RIG_PI_TURNS=1 COLLIE_RIG_PI_MODEL=<provider/model> \
COLLIE_RIG_OMP_TURNS=1 COLLIE_RIG_OMP_MODEL=<provider/model> \
  bunx playwright test -c e2e/rig/playwright.config.ts
```

The pi and omp bodies of scenarios 2 to 5 have not yet run against a live turn. Check their card
names and confirmations on the first run with a provider.

## Cost of one run

- Claude: 5 model turns on Haiku: the permission request, the pick-many question, the long list plus
  one message sent while it streams, and one prompt that makes 48 Read calls. The picker needs no
  turn. A run caps each harness at 15 turns (`TURN_CAP` in `leg.ts`), and every turn is logged in
  `~/.cache/collie-lab/browser-leg-state/turns.log`.
- pi and omp: no turns while their turns are off; about 6 each when on.
- Time: about 8 minutes.

## What it never touches

- The operator's Herdr server and its panes. Every `herdr` call runs with the rig's own
  `XDG_CONFIG_HOME` and drops every inherited `HERDR_*` name (`rig-lib.ts`).
- Any Collie lane, port 8787-8799, 5198, 5199, or a `collie*.service` unit. The bridge listens on
  127.0.0.1:18700-18799 with its own HOME, state and config.
- Any `collie` CLI verb. The rig pairs with the bridge's own pairing module.
- The operator's agent config. Each harness gets a scratch config under
  `~/.cache/collie-lab/browser-leg-state/harness/<id>/`. Only what it needs is copied there at
  0600: Claude's OAuth file without its refresh token, pi's `auth.json`, omp's `agent.db`. The
  bridge reads the journals of these scratch homes, never `~/.claude/projects`.
- Processes it did not start. Every kill is by a recorded pid after `/proc/<pid>/cmdline` matched.
