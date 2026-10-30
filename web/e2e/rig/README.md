# The browser leg

A Playwright phone (Chromium, Pixel 7 descriptor) opens a scratch Collie bridge. The bridge mirrors a
scratch Herdr server, and real Claude Code, pi and omp run in it. The phone taps cards the way a
person does. Each case checks that a tap works on the first tap and that the screen shows the result.

Tier 1 (`web/e2e/*.spec.ts`) answers the API from fixtures. Tier 2 (`web/e2e/live/`) reads the dev
lane. This leg starts its own bridge and Herdr, writes to them, and spends model turns. It is not
the VM lab that CLAUDE.md calls Tier 3. It never runs in CI: its config throws when `CI` is set, and
Tier 1's config ignores `e2e/rig/`.

## When it runs

The leg is a gate. It runs in these places:

- **Before every release tag**, on the release head. All forty-one cases pass on the first tap:
  thirty-four on the solo leg (three harnesses with five cases each, fourteen walky talky cases, case 22, case 25, case 26, case 28, and case 29) and
  seven on the crew leg (below). A case that fails, or is not reached, holds the tag.
- **Before every minor or major release tag**, also on herdr-core (M78, "On herdr-core" below): the solo
  leg with `make browser-leg DIR=... MUX=herdr-core` (replay, about 30 minutes), and the crew leg with
  the member on the core, `MUX=herdr,herdr-core`. A core case passes, or its red has a named cause in
  `HC_API.md` ("What does not fit Collie's mux port") or below. A patch tag runs the Herdr legs only.
  One red Claude case on the core makes every later Claude case fail on a recording mismatch ("A red Claude case stops the rest" below), so read only the first one.
- **Before merging a change** to a harness reader, the Surface, the Send Protocol or the ask code. Run
  it on the branch, solo on Herdr and solo on herdr-core. A unit test cannot show that a tap works on a
  real screen.
- **Every night**, on `origin/main`, through `nightly.ts` (below).

One solo run costs about 11 minutes. Claude Code, pi and omp replay recorded model streams ("Replay"
below), so a run on recordings sends nothing to OpenRouter or Anthropic and spends no Claude turn. A run
on a new Claude Code version runs Claude live once and records it, about 24 Claude Haiku turns on the
subscription for the solo leg and 6 for the crew leg. A run on a new pi or omp version runs that harness live once and records it: the first
recording run (2026-10-26, pi 1.3.0, omp 18.6.1) sent 44 requests to OpenRouter Haiku 4.5, 21 for pi and
23 for omp (a few cents). The crew leg adds about 4 minutes, 6 Claude turns
and 4 pi turns, and the nightly run does both and then the core leg (about 30 more minutes). The turn cap is 20 per harness. "Cost of one run" below
has the detail.

### The nightly runner

```sh
bun web/e2e/rig/nightly.ts --plan   # prints the tuple and whether it would run; spends nothing
bun web/e2e/rig/nightly.ts          # runs the leg if this tuple has no row yet
```

`nightly.ts` needs only Bun and node builtins, so it runs from a checkout with no `node_modules`. It
never writes into the checkout it starts from. It keeps a clone of its own at
`~/.cache/collie-lab/browser-leg-nightly/clone`, fetches `origin/main` into it and checks it out
detached, runs `bun install` in the root and in `web/`, builds `web/`, and runs the solo leg, then the
crew leg (below), then the solo leg again on herdr-core (`COLLIE_RIG_MUX=herdr-core`, "On herdr-core"
below), in the same run and under the same ledger row. Each leg uses a rig state of its own
(`~/.cache/collie-lab/browser-leg-nightly/state`, `.../crew-state` and `.../core-state`, set through
`COLLIE_RIG_STATE`), so a leg that a person runs by hand is never taken down by a nightly run, and the
legs share no folder, Herdr home, port or socket. The previous rig is down before the next one comes up.

**The crew leg in a nightly run.** It runs `bunx playwright test -c e2e/rig/crew.config.ts` in the clone's
`web/`, with the same environment as the solo leg, so the key file passes through untouched. It needs
nothing that the solo leg does not need: it has the same 8 GB memory guard, because the solo rig is down
first. If the solo leg could not start (it wrote no table), the crew leg does not run and the row is
`failed`. If the solo leg ran and a case failed, the crew leg still runs, for a full picture of the tuple.

**The core leg in a nightly run.** It runs `bunx playwright test -c e2e/rig/playwright.config.ts` in the
clone's `web/` with `COLLIE_RIG_MUX=herdr-core`, after the crew leg, with a 60 minute limit. It adds
about 30 minutes to a run and, on recorded versions, no model turn. If the solo leg wrote no table, the
crew leg and the core leg do not run and the row is `failed`. A `fail` or `failed` from the core leg
counts like the others: it makes the row `fail` or `failed`, and the note says `core leg: ...`. A core
case with a named cause in `HC_API.md` still counts as a `fail` here; the runner does not know the
named causes. `--plan` names the core leg.

**Once per tuple.** A tuple is the main commit, the Claude Code version, the pi version, the omp
version and the hc version (`hc --version`, `hc 0.1.14`). The versions come from the binaries `bins.ts`
names, and `hc` from `PATH`. A ledger row from before the tuple carried the hc version reads as hc
`none`, so it is never the same tuple as a new one. The ledger
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
- A run that cannot finish writes `failed`. A run in which a case failed, in either leg, writes `fail`. A
  case that was not reached, or is not applicable, in either leg proves nothing, so it makes the row
  `failed`. The row is `pass` only when both legs passed every case (34 solo cases and 7 crew cases). A
  `fail` outranks a `failed` between the two legs.

**Cannot start.** A Claude login with under 25 minutes left, no `herdr`, `bun` or `git`, under 8 GB of
free memory, no key file, a binary or the remote that will not answer, and a ledger that cannot be
read. These cost nothing and write no row. Each appends one line to
`~/.local/state/collie-browser-leg/notify.log`. A `fail` or `failed` run appends one line too, and it
names each leg that did not pass (`solo leg: ...; crew leg: ...`). `--plan` names the same blockers,
says that the crew leg is included, and writes nothing.

**The key.** `COLLIE_RIG_KEY_FILE` comes from the runner's own environment and goes on to the leg. The
runner checks only that it names a readable file. It never reads, prints or copies the key.

**Output and exit code.** One line per harness (the counts of both legs added up, the crew cases run
under Claude), then the path of the solo leg's `table.md` and the path of the crew leg's. The row keeps
the verdict counts, the solo results folder and table (`results`, `table`) and the crew leg's
(`crewResults`, `crewTable`). Rows from before the crew leg have no crew fields. The run log sits under
`~/.cache/collie-lab/browser-leg-nightly/logs/`. Exit 0: the leg passed, or there was nothing to do.
Exit 1: a case failed. Exit 2: the run could not start or could not finish.

Flags: `--state-dir DIR` moves the ledger and `notify.log`, `--root DIR` moves the clone, the rig states
(`state`, `crew-state`) and logs (under `~/.cache/collie-lab`), `--repo URL` names another remote. The logic is tested without
a rig in `scripts/browser-leg-nightly.test.ts`, which `bun run test` runs.

## The cases

Each harness runs the same five cases. The walky talky cases (6 to 11 and 16 to 24), the stop case (25), the steer case (26) and the queued case (29) run on the harnesses the
last column names. Cases 12 to 15 and 19 to 21 run on the crew leg only (below).

| # | Case | Harnesses | Spec |
| --- | --- | --- | --- |
| 1 | Model picker: the first tap on the commit row commits | claude, pi, omp | `claude.spec.ts`, `others.spec.ts` |
| 2 | Permission card: Yes from the phone runs the command | claude, pi, omp | same |
| 3 | Question card: pick-many on Claude, pick-one on pi and omp | claude, pi, omp | same |
| 4 | A send while the agent streams a long reply. On Claude the first tap presses Enter into Claude's own queue: the receipt is `sent` with `queued`, the Chat draws Claude's queued row with the note (or the note has already landed after the turn, when a fast answer drained the queue first), and after the turn Claude answers it and the note is in the transcript once. A note sent after the turn already ended may go in as a plain `sent`. A held send fails the case | claude, pi, omp | same |
| 5 | Load older with an empty phone cache: seven prompts, so the six-prompt cold page has an older page. The Load older row is attached, nothing covers its centre, a tap adds older rows, and the pin leaves the row free | claude, pi, omp | same |
| 6 | Walky talky: hold Send, tap "Send as message". The pane gets one prompt, header and body. The receipt says `delivered`. Chat shows the "Message from" card with the operator badge | claude | `walky.spec.ts` |
| 7 | The same operator message, to a pi pane and to an omp pane | pi, omp | `walky-harnesses.spec.ts` |
| 8 | Agent to agent through the skill, pi to Claude and back: the receiver's pane gets a one-line nudge with no body, its `collie walky inbox <id>` output shows the body, `collie walky reply` comes back and the sender's pane shows the reply nudge; Claude's Chat draws the agent card | pi (with Claude) | `walky-harnesses.spec.ts` |
| 9 | A message the pane cannot take now: over an open permission card nothing is typed into the dialog (the Send Protocol holds the message and types it after the answer). Over a draft the message is held too (M62 spec 02): the receipt is `accepted` with the reason `draft present` and the draft is untouched. The draft is then sent, its turn runs, and the message is typed after that turn, once, and the receipt says `delivered` | claude | `walky.spec.ts` |
| 10 | A broadcast (`to: all`): one receipt per agent pane, each typed and answered, the shell pane skipped | claude | `walky.spec.ts` |
| 11 | A forged header: a prompt that opens like an operator message and one that opens like an agent's nudge, both with an id the log lacks, stay plain turns with the "no log record" mark and draw no card | claude | `walky.spec.ts` |
| 12 | Crew leg. "Message all agents" on the lead's Crew page: the sheet counts 2 agents on 2 machines, Send asks "Message 2 agents on 2 machines?", and Send there posts. Both panes get the header and body, the lead's `collie walky status` shows both receipts `delivered` (the member's through its sweep report), the member's pane opened on the phone through the lead (`?h=`) shows the header line, and both agents answer | claude (lead), pi (member) | `walky-crew.spec.ts` |
| 13 | Crew leg. Claude on the lead runs `collie walky who` and sends to pi's address as `who` printed it, with its pane instance token (`#` and four characters). pi's pane gets the one-line nudge, `collie walky inbox <id>` shows the body, pi answers with `collie walky reply`, and Claude's pane shows the reply nudge. The lead's `collie walky status <id>` says `delivered` within 60 s (the member's report reached the lead), and the member's `collie walky status <reply id>` says `delivered` within 60 s (the lead pushed the outcome back to the sender's machine) | claude (lead), pi (member) | `walky-crew.spec.ts` |
| 14 | Crew leg. The member's bridge stops: the lead's Crew page names it unreachable, the sheet counts 1 agent on 1 machine, the bridge takes the message for the lead's pane only and answers `rig-member/all` with a refused receipt ("host rig-member is unreachable"), which the sheet draws as a "not sent" row. The member then starts again and is reachable before the case ends | claude (lead) | `walky-crew.spec.ts` |
| 15 | Crew leg. Release lines (M60 spec 01). On the lead's Updates page, the Release line control reads Stable; a tap on Edge shows the receipt, and `GET /api/update/line` on the lead says `edge` with nothing installed (no run record moves). The Crew page then says the members follow the lead's line, Edge. A tap on Stable puts it back, with its receipt. The member's own follow (an Edge build up, a rollback down) needs a published Edge tag behind a release mirror, which this rig does not serve; the unit suites in `bridge/crew/follow.test.ts` carry that half | claude (lead) | `walky-crew.spec.ts` |
| 16 | A message during a running turn. A long numbered list streams (160 items on Claude, 180 on pi, 80 on omp). The operator holds Send and taps "Send as message" while it runs. The list runs to its last line, the agent then answers the body, the header is on the screen once, and the receipt ends at `delivered`. The phone's line under the box goes from "queued" to "typed into the pane". Claude (Enter), pi (Alt+Enter) and omp (Ctrl+Q) may take it into their queue during the turn, so the note says when the header showed. A message must never steer the turn | claude, pi, omp | `walky.spec.ts`, `walky-harnesses.spec.ts` |
| 17 | A message over a question card. Claude asks a pick-one question (no option has a preview). A message sent while the card shows is not typed into the dialog and its receipt stays `accepted`. The phone answers the question (Cherry), and then the message is typed once, the receipt says `delivered` and the agent answers the body. Case 9 does the same over a permission card | claude | `walky.spec.ts` |
| 18 | An address of a pane that closed. A second Claude starts, `who` prints its address with a token, and its pane closes. After the bridge's 30 s sweep another Claude starts. A message to the old `#token` address is refused, and the new pane gets nothing. Herdr does not give a closed pane's id to the next pane, so the refusal is `no such pane` here. `pane replaced` needs a multiplexer that reuses ids (tmux, zellij), and the unit tests carry it | claude | `walky.spec.ts` |
| 19 | Crew leg. Member to lead. pi on the member runs `collie walky who` (which lists its own machine and points to the lead), then sends to Claude's address on the lead, taken from the lead's `who` and put in the prompt. Claude's pane gets the one-line nudge with no body, reads it with `collie walky inbox <id>` and replies. The member's `collie walky status <id>` says `delivered` (the lead pushed the outcome back), and the lead's status of the reply says `delivered` (the member's report). Case 13 is the mirror image | claude (lead), pi (member) | `walky-crew.spec.ts` |
| 20 | Crew leg. Walky talky off on the member. The member's bridge restarts with `COLLIE_WALKY=off`. Claude on the lead sends to pi and reads `not sent: off`; the lead's status says `refused (off)`; pi's pane gets nothing. The Crew page's message to that machine (the sheet's "Send to" set to it) draws the receipt row `rig-member/all` with `not sent: off`, and the member counts the refusals in its own `refusals.json`. The lead's "Not sent on this machine" line counts only the lead's own refusals, so it stays empty. The member then restarts without the setting and is reachable | claude (lead), pi (member) | `walky-crew.spec.ts` |
| 21 | Crew leg. The pair limit. A throwaway Claude on the lead sends seven messages to pi on the member through the CLI (`collie walky send` with that pane's markers). pi's box holds a draft, so the first six are held (`accepted`, and the lead reads the reason `draft present` from the member's report) and cost no model turn. Each send waits the CLI's 15 seconds for an outcome, so the six take about 90 seconds. The seventh is refused `pair limit` on the lead and never dialled, and the draft is untouched. The draft stays at the end: clearing it would type the six. This is the crew leg's last case, and the rig takes the holds down with it | claude (lead), pi (member) | `walky-crew.spec.ts` |
| 22 | Model from the belt over a draft. A word typed into Claude's box outside the phone is a draft. The belt's Model is refused `draft_present`, and the phone offers Replace and Cancel, no Add, with the notice "Replace it, or cancel". One tap on Replace empties the box and sends `/model`: the picker opens on the pane and as a card on the phone, and the draft is gone. Escape outside the phone closes the picker. No model turn | claude | `claude.spec.ts` |
| 23 | A held message cancelled by its sender (M62 spec 03). The operator's message over a draft is held (`accepted`, `draft present`). In the pane's Messages sheet the held row carries Cancel; a tap ends it as `inbox-only` with the reason `cancelled by sender`, the draft is untouched, and nothing is typed once the box is cleared | claude | `walky.spec.ts` |
| 24 | A held message dropped by the pane's owner (M62 spec 03). A second Claude sends through the CLI over a draft, so the message is an agent's and held. The phone shows "1 message waits for the box to clear" above the box; a tap opens the Messages sheet on it, Drop ends it as `inbox-only` with the reason `dropped by the pane's owner`, the mark goes, and nothing is typed once the box is cleared | claude | `walky.spec.ts` |
| 25 | Stop a running pi turn (M68, ADR 0116). A long numbered list streams (180 items), so the turn runs for tens of seconds. The belt shows Stop. The first tap arms it: the button reads "Stop?" and nothing is posted. The second tap posts one abort request, and the bridge presses pi's interrupt key as a person's tap. The receipt says `stopped`, the notice "Stopped." shows under the box, and the box reads free within 5 s. One model turn. | pi | `stop.spec.ts` |
| 26 | Steer while working (M69). A bash call counts to 40 over 40 s (the lab's long turn, 2026-10-23). The operator types a line, holds Send and taps the Steer row. The receipt says `steered`, the phone says "Steered: the agent takes it after its current step." within 5 s, and the turn still runs right after, because a steer is taken after the current tool call in the same turn. The note says whether the agent answered the line | pi | `steer.spec.ts` |
| 27 | Steer while working (Codex): case 26 on Codex, with the profile's `steerDelayMs` (1000) added to the 5 s window. Not built: this rig starts claude, pi and omp only, and a Codex harness needs a binary, a login seed, an entry in `harnesses.ts`, and a column in the nightly's table. `steer.spec.ts` carries the helper and its `steerDelayMs` parameter, so the case is one test line once the harness exists | none yet | `steer.spec.ts` |
| 28 | Clear a draft from the Keys board (ADR 0116). A word is typed into pi's box outside the phone (the keys route, as case 22 types one) and never sent, so the Surface reads `draft` and the Keys board's Clear button is enabled. One tap posts one `POST /api/pane/:id/clear`, and the bridge presses pi's clear key as a person's tap. The receipt says `cleared`, the notice "Box cleared." shows under the box, the box reads free within 5 s and the word is gone from the screen. No prompt is sent: zero model turns, nothing on OpenRouter | pi | `clear.spec.ts` |
| 29 | A queued send on omp (ADR 0122). Two passes over a long numbered list (80 items). In each, a send from the composer while the turn runs is queued: the receipt is `sent` + `queued`, and within one poll Chat shows the "Waiting to send" card with the text and no button. Stop (arm, then Stop) ends the turn, omp puts the text back into its box, and the card turns "Back in the box" with Send and Discard; the receipt carries `late: "returned"`. Pass 1 taps Send: the submit key goes alone, omp answers the text, the log holds it once and the card goes. Pass 2 taps Discard: the box reads empty, the card goes and the text never becomes a prompt. Three model turns | omp | `queued.spec.ts` |

The walky talky path is the same bridge code for every harness, so Claude carries most of the cases and
pi and omp prove that their screens take the message. The table prints a row only for a harness a case
runs on, and only for the cases of its own leg (`scenarioApplies` in `scenarios.ts`). Case 10 posts
the request the Crew page's "Message all agents" sheet posts, to prove the fan-out on the solo rig;
the sheet itself, tapped on the Crew page, is proved on the crew leg (case 12). Cases 8 and 9 use the
`collie walky` verbs inside the agent: each harness starts with a `collie` first on PATH that runs this
checkout's CLI (`harnesses.ts`), and with the walky talky skill in its scratch config. Claude's scratch
settings allow `Bash(collie walky:*)`, so the verbs ask no permission.

## The crew leg

A second Playwright config, `crew.config.ts`, runs the walky talky cases that need a crew (12 to 14 and 19 to 21), and the release-line case (15)
against two machines on this one host:

- **The lead** is the solo rig: Herdr session `collie-rig`, its attached client, and a bridge on a
  free port in 18700-18799, with the phone paired to it.
- **The member** is a second Herdr server, session `collie-rig-member`, with its own short XDG home
  (`$XDG_RUNTIME_DIR/collie-rig-<8 hex>`, hashed from `<state root>/member`, so it is never the
  lead's), its own attached client, and a second bridge on the next free port. Its state, config,
  HOME and harness folders sit under `<state root>/rig/member/` and `<state root>/harness/member/`.
- **The enrolment** runs the real verbs as functions, the way `integration/crew-harness.test.ts`
  does (`crew-enrol.ts`): `cmdCrewInvite` on the lead, `cmdJoin` on the member with `--insecure
  --address 127.0.0.1:<member port>`, then a restart of the lead. Every restart is the rig's own:
  kill the recorded pid, start the bridge again with the same dirs and port. The member comes back in
  peer mode, with a pinned TLS listener, so the rig reads it only through the lead (`?host=`).

The crew leg has its own state root, `~/.cache/collie-lab/browser-leg-crew-state`, so it never shares
a rig folder, a Herdr home, a port or a ledger row with the solo leg, and both can run at once.

```sh
cd web && COLLIE_RIG_KEY_FILE=/path/to/.env bunx playwright test -c e2e/rig/crew.config.ts
```

A harness runs on either machine with that machine's own `collie` shim and skill: the shim sets
`COLLIE_STATE_DIR` to its machine's state dir, so an agent on the member asks the member's bridge.
Claude runs on the lead and pi on the member. Case 14 waits on the lead's own sweep: the sweep rides
the lead's poll (`bridge/crew/lead.ts`, CREW_PROTOCOL §10.1), the next dial is refused, and one
failed call makes the member `unreachable` (`registry.ts` `record`). The idle poll is 12 s, so the
case allows 90 s. It took 5 to 8 s in the runs of 2026-10-18.

**Cost of one run.** About 5 and a half minutes (case 21's six held sends take about 90 seconds), 6 Claude Haiku turns (the broadcast, the send to pi, the reply
nudge, the broadcast with the member down, the reply to pi's message in case 19, the send in case 20) and
4 pi turns on OpenRouter Haiku 4.5 (the broadcast, the nudge, and the send and the reply nudge of case 19).
Case 21 spends no turn: its sender is a throwaway Claude that never takes a prompt, and pi's box holds a
draft. Memory: two Herdr servers, two bridges and a browser, under the same 8 GB guard.

**By hand.** Add `--crew` to any command, or the command reaches the solo rig:

```sh
bun e2e/rig/rig.ts up --crew                       # lead + member, enrolled, phone paired
bun e2e/rig/rig.ts status --crew                   # both machines' pids and ports
bun e2e/rig/rig.ts start pi --on member --crew     # a harness on the member (or --on lead)
bun e2e/rig/rig.ts read <pane> 60 --on member --crew
bun e2e/rig/rig.ts crew stop-member                # stop the member's bridge by its recorded pid
bun e2e/rig/rig.ts crew start-member               # start it again, same dirs and port
bun e2e/rig/rig.ts crew start-member --env COLLIE_WALKY=off   # the same, with walky talky off (the only setting it takes)
bun e2e/rig/rig.ts down --crew
```

`crew stop-member` and `crew start-member` signal the rig's daemon, which owns every process and is
the one writer of `rig.json`. The member's Herdr and its agents keep running, as on a machine whose
Collie stopped.

## On herdr-core

By default every machine of the rig runs a scratch Herdr TUI server. `COLLIE_RIG_MUX` picks another
multiplexer, and `make browser-leg DIR=... MUX=...` passes it on:

```sh
COLLIE_RIG_MUX=herdr-core bunx playwright test -c e2e/rig/playwright.config.ts          # the solo leg on the core
COLLIE_RIG_MUX=herdr,herdr-core bunx playwright test -c e2e/rig/crew.config.ts          # lead on Herdr, member on the core
bun e2e/rig/rig.ts up                                                                   # by hand: the same variable, on every command
```

One name puts both machines on that mux. Two names, `<lead>,<member>`, split them; that is the dev
lane's own shape. Unset or `herdr` is the gate as it always ran. The rules are in `rig-mux.ts`.

**How the core starts.** The daemon runs `hc server start` for each machine with `HC_SESSION`
`collie-rig-<8 hex>` (the name of the rig's short home) and `HC_SOCKET` `<short home>/hc.sock`, under
XDG homes of the rig's own. The short home is the folder Herdr gets (above), because the core binds its
holder socket beside `hc.sock` and a long state root would push it past `sun_path`. Every `hc` call
drops each inherited `HC_` name and carries that socket, so the operator's core
(`$XDG_RUNTIME_DIR/herdr-core/default.sock`) is never dialled. The bridge gets `COLLIE_MUX=herdr-core`
and `COLLIE_MUX_ENDPOINT_HERDR_CORE`. A harness starts with `hc run --bg --name leg-<harness>-<stamp>
--cwd <project> --no-parent --no-notify -- sh -c "exec '<start.sh>'"`: a terminal whose program is the
start script, with no shell beneath. A program started over the API gets the core's environment, not
the caller's, so the start script carries every setting the harness needs, as it does on Herdr. The
specs find a pane by the id the start returns, which is the bridge's own pane id on both muxes (a Herdr
`w1:p1`, a core address `t1`), and read it through `/api/snapshot`.

**Teardown.** `hc server stop` ends the core, its holder and every terminal's program. Then the rig
kills the recorded server pid and any `herdr-core` process still bound to this rig's socket (by its
command line or its `HC_SOCKET`), and removes the socket. Two facts of hc 0.1.14 shape this. Every `hc`
call starts a core when none answers, `hc server status` included, so the rig calls `hc` only while the
socket file is there. And the core places its server and holder in systemd user services of their own
(`hc-serve-<hex>.service`, `hc-hold-<hex>.service`), outside the rig's scope, so the scope's `TasksMax`
does not bound the harnesses on the core.

**What differs from Herdr** (`HC_API.md` has the probes):

- **A plain mirror.** The core hands out text with no colour and no SGR attribute, so a reader that
  keys on a dim or inverse cell sees none.
- **The key hold.** The core answers a key about 3 s after a raw write. The Send Protocol's probe and S1
  wait it out, so a send takes longer.
- **No History without hooks.** The core keeps no conversation id. On the core the rig writes the
  beacon hooks `collie hooks install claude` would write into Claude's scratch settings, with the rig's
  own `collie`, so a Claude pane has History and Chat as it does for an operator who installed them. pi
  has no such hook, so a pi pane on the core has no History: its Load older case and the Chat card of
  its walky talky case fail there.
- **An agent names itself.** The core names a terminal's agent only from the program's own OSC 7501
  report. Claude Code 2.1.314 and pi 1.3.0 send one; omp 18.6.1 does not, so its pane reads as a shell
  and every omp case is not reached.
- **A history read can hang.** On 2026-10-30 a `terminal.read` with history (`hc read --lines 60`) on a
  pi that showed a dialog did not answer in 30 s, while the plain screen read answered at once. The
  bridge gives up after 5 s and reads the pane as unreadable, so pi's permission and question cards
  never reach the phone.
- **A red Claude case stops the rest.** Claude's recordings replay one session in order. A card left
  up and then cleared with Escape puts "Request interrupted" into Claude's next prompt, and a case left
  out moves the session's first prompt. Either way every later Claude request misses its recording. So
  on the core, as on Herdr, a Claude case after a red one says nothing until the red one is fixed.
- **No view pane and no attached client.** The core keeps each terminal's screen itself, with no
  client attached. A terminal started over the API is 200 x 120.

## Prerequisites

- `bun install` in the checkout root and in `web/`, then `bun run build` in `web/`. The bridge serves
  that `web/dist`.
- On PATH: `herdr` and `bun`. The harness binaries are named by path in `harnesses.ts`: Claude Code
  at `~/.local/bin/claude`, pi under nvm, omp at `~/.bun/bin/omp`. Override them with
  `COLLIE_RIG_CLAUDE_BIN`, `COLLIE_RIG_PI_BIN` and `COLLIE_RIG_OMP_BIN`.
  The rig's bridge gets a `bin/` folder under its scratch HOME with a link per binary, first on its PATH, so its
  version read runs the very binary the pane runs (a `claude` shim on the operator's PATH fails under the scratch
  HOME, and a newer `omp` in `~/.local/bin` would be read instead of `~/.bun/bin/omp`).
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

By hand: `bun e2e/rig/rig.ts up | down | status | start claude|pi|omp | pane <cmd...> | pane ls | pane close <paneId>... | snapshot | read <pane>`.
After a crash, `bun e2e/rig/rig.ts down` stops what the rig started. The crew leg's commands are in
"The crew leg" below.

With `COLLIE_RIG_OWNER_WATCH=1` a rig dies with the session that ran `up`. `make browser-leg` started in one
Claude session and followed from a second one then stops when the first one ends. Start the leg from the session
that will outlive it, from a plain shell, or leave the variable unset. It is off by default.

On Linux, `up` starts the rig's daemon in a systemd scope of its own, `rig-<8 hex>-<pid>.scope`, with
`TasksMax=700` (1400 for `up --crew`, which runs two servers and two bridges; `COLLIE_RIG_TASKS_MAX=<n>`
overrides both), a stop timeout of 10 s, and core dumps off (`COLLIE_RIG_CORES=1` keeps them). The Herdr
server, the bridge and every pane are children of the daemon, so they run there too, not in the Claude
session that ran `up`. Five rigs from one session once filled that session's task limit (threads count as
tasks), and Bun, Node and Claude aborted. Elsewhere (macOS, Windows), or without `systemd-run` and a user bus
(`$XDG_RUNTIME_DIR/bus`), the daemon runs where `up` runs; on Linux that `WARNING` goes to `logs/daemon.log` and to stderr of `up`, and the
rig has no task cap and no owner watch.

- **Slice.** The scope goes in your default user slice, so the limit is per rig and there is no limit for all rigs
  together. To put every rig in one slice, define the slice in a slice unit file on the host and set `COLLIE_RIG_SLICE=rig.slice`. The value must look like
  `name.slice`; anything else is ignored with a `WARNING` line. Then the slice's own limits bound all rigs together.
- **Check.** Once the daemon is up, `up` reads the scope's `pids.max`. When it is not the number asked for (a host
  that does not hand the task controller to your user), `up` prints one `WARNING` line to stderr, and
  `logs/daemon.log` gets it too, saying the task cap is not enforced. The check runs whenever the rig came up, also when
  the daemon was slow to write `rig.json`. `status` shows `"tasks": "<pids.current>/<pids.max>"` for the scope, and leaves it out without one.
- **Run limit.** The scope has `RuntimeMaxSec=21600` (6 hours). It is a hard stop by systemd: it kills the scope
  with no teardown, so the Herdr home and `rig.json` stay until the next `up` or `down` clears them.
  `COLLIE_RIG_RUNTIME_MAX_SEC=<n>` (a positive integer, in seconds) changes it.
- **Owner watch (`COLLIE_RIG_OWNER_WATCH=1`).** `up` records the OWNER, the cgroup it ran in (a Claude session's
  scope), in `rig.json`, but only on Linux and only if that directory exists at that moment. The daemon checks
  every 30 s that it still exists, and tears the rig down after two misses in a row. Only "no such directory"
  counts as a miss; any other error is ignored. Only a `claude-*.scope` cgroup is an owner (an allow list). Any other
  cgroup is no owner: a login session, a desktop app, and also a `vte-spawn-*` or `tmux-spawn-*` scope. A rig started
  from a plain shell or a terminal multiplexer skips the check.
- **Start failure.** systemd-run's own messages go to `logs/systemd-run.err`. If systemd-run itself fails (it exits
  non-zero within 1.5 s, before the daemon ran, with an error such as a bus failure), `up` starts the daemon
  without a scope and prints a `WARNING` to stderr (also in `logs/daemon.log`) that says the rig has no task cap and
  no owner watch. If the daemon ran and then failed, there is no second start: `up` reports the failure text taken
  from `logs/daemon.log`, then `logs/daemon.out`, then `logs/systemd-run.err`, the first of them that has text.
- **Stop.** `down` asks the daemon to tear down first, then stops the scope if it is still active. It finds the scope
  in `rig.json`; when `rig.json` is gone (a kill between its removal and the scope's stop), it lists
  `rig-<hash of the state root>-*.scope` with `systemctl --user list-units` and stops what it finds. A host may run its
  own reaper for scopes whose daemon is gone. Every `systemctl` call has a 15 s limit.

**The pane cap.** A harness pane costs 46 to 64 tasks (omp), and scripts that open one pane per case and
close none filled the task limit at about one pane a minute. So `pane <cmd>` and `start <harness>` count the open
panes first (the rig's view pane is left out) and refuse when there are `COLLIE_RIG_MAX_PANES` or more: a positive
integer, 6 when unset or not one. The refusal exits with code 75, lists the open panes and names the fix.
The cap is a soft limit, per machine and per rig. It is not atomic across callers that start at the same moment,
so several can pass the check together. The scope's `TasksMax` is the hard guard.

```sh
bun e2e/rig/rig.ts pane ls                       # the open panes: id, label, age, command (add --on member for the member)
bun e2e/rig/rig.ts pane close w3:p1 w4:p1        # close some; an id that is already gone is reported and skipped
bun e2e/rig/rig.ts pane close --all              # close every pane but the view pane
bun e2e/rig/rig.ts start omp --replace           # close the omp pane `start omp` opened last, then open the new one
bun e2e/rig/rig.ts pane --replace sleep 600      # the same for `pane`, which keeps one slot of its own
```

`--replace`, `--crew` and `--on <machine>` count only before the first word of the command, or anywhere before a
literal `--`. Everything after reaches the pane as typed: `pane sh -c 'echo --replace'` keeps its `--replace`, and so
does `pane sleep 600 --replace`. The last pane per key is in `rig/last-panes.json` (written to a temp file and
renamed; not `rig.json`, which the daemon writes whole), and `up` and `down` remove it. The cap sits in these two
verbs only: the Playwright leg opens its panes through `rig-lib.ts` and does not meet it. `pane ls` and `pane close`
are verbs, so run a shell command of that name as `pane sh -c ls` or `pane -- ls`; `pane ls <more words>` prints that
hint and starts nothing.

The pure helpers (owner, unit name, environment settings, argument split, cap, start fallback) are in `rig-scope.ts`.
`scripts/browser-leg-rig-scope.test.ts` tests them, and `bun test ./scripts` (and so CI) runs it.

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

`harnesses.ts` (`SETUPS`) is the one place for this. Claude runs on Haiku (`COLLIE_RIG_CLAUDE_MODEL`)
with its own login when it runs live, and on a dummy login when it replays. pi and
omp run on `openrouter/anthropic/claude-haiku-4.5` and read `OPENROUTER_API_KEY`. Their model calls
never go to OpenRouter directly: they go to the rig's model stub, which replays them or passes them on
("Replay" below).
`COLLIE_RIG_KEY_FILE` names a dotenv file that holds it. Each start script reads that one name from
the file in a subshell, straight into the harness's environment. The key never goes into a file, a
pane's command line or the leg's own processes, and pi gets no `auth.json`, so the key wins.

Without a key file, a pi or omp with no recording for its version reports "not reached" for the
scenarios that need a turn. With a recording it replays, and needs no key. Other knobs:
`COLLIE_RIG_PI_MODEL`, `COLLIE_RIG_OMP_MODEL`, and `COLLIE_RIG_PI_TURNS=0` or
`COLLIE_RIG_OMP_TURNS=0` to keep one harness off.

The teardown scrubs the key from every text file of the run, the rig's logs and Playwright's test
results, and drops a screenshot whose capture held it. It prints a count, never the key.

## Replay: recorded model streams for pi, omp and Claude Code

The rig fakes the model, not the agent (ADR 0125). The rig daemon starts a stub on 127.0.0.1, on a free
port in the rig's range, before the first harness. pi's base URL goes to it through a provider extension
(`collie-rig-stub.ts` in its scratch folder), omp's through `models.yml`, and Claude Code's through
`ANTHROPIC_BASE_URL` (`http://127.0.0.1:<port>/claude-lead`, M67 spec 07). The real binaries still run in
real Herdr panes and draw every screen the phone taps, the permission card included: a recorded
`tool_use` answer makes the real Claude draw it.

**Claude Code.** The stub answers Claude's `HEAD /api/hello` itself on every tier. On replay Claude gets a
dummy login (`seedClaudeReplay` in `scripts/harness-canary/lab/seed.ts`): the real access token is not
copied, the 25-minute token rule does not apply, and Claude's own calls to Anthropic for account extras
(a passes banner, the agents hint) fail quietly, so the replay screen is the same on every run. When Claude
records, it runs on the real login (no refresh token) and the stub passes each call to
`https://api.anthropic.com` with Claude's own headers; the token is in memory for that one request and is
never logged or stored. A forced live Claude that does not record (`COLLIE_RIG_LIVE=claude`) gets no base
URL at all: it is the live run of before M67. Claude's summary keeps each `<system-reminder>` of the
prompt to its first line, plus any memory file the rig wrote, because the reminders carry the operator's
own `~/.claude/CLAUDE.md` (Claude finds it on its walk up from the project) and the account's email. It
leaves Claude's `role: system` items out (the OS version, the session's scratchpad), and adds a digest of
the system prompt and the tool definitions, so a new tool list is a mismatch.

**The tier.** The global setup reads each harness's `--version` and picks one tier for the run:

- **replay**: `cassettes/<harness>/<version>/meta.json` lists this leg, with the same model and the same
  walky talky skill text (`cli/skills/walky-talky.md`, by hash). The stub answers every model call from
  the recordings, with their recorded pacing. It has no path to OpenRouter on this tier. The harness gets
  a dummy key, its start script does not open the key file, pi gets no `auth.json` and omp no `agent.db`.
- **live**: there is no recording for this version, model or skill text. The stub passes each call on to
  OpenRouter (pi, omp) or Anthropic (Claude) with the harness's own key or login and records it, so the
  next run replays. Without a key file, pi and omp record nothing and their turn scenarios are "not
  reached". Claude needs no key file, only its login.

```sh
COLLIE_RIG_MODEL=replay ...     # replay or stop: a harness with no recording fails the run before it starts
COLLIE_RIG_LIVE=pi ...          # pi live this run (pi,omp,claude or all); the rest by the rule
COLLIE_RIG_MODEL=live ...       # all three live
COLLIE_RIG_RECORD=1 ...         # a forced live run records too (a version miss always records)
COLLIE_RIG_REPLAY_SPEED=4 ...   # replay four times faster than recorded (default 1, never slower)
```

The run's first lines say the tier of each harness and why. Its last lines say which harness replayed,
the live model turns (`live model turns: claude 0` on a Claude replay), `OpenRouter requests this run: N`
and `Anthropic requests this run: N`. A replay run says 0 there. The same numbers
go to `model.json` in the run folder, and the nightly ledger row keeps the tiers (`tiers`).

**Record.** Run the leg once with a key file on the new version (`make browser-leg DIR=...` from the
workspace does this on its own after a version bump), or force it:

```sh
COLLIE_RIG_LIVE=all COLLIE_RIG_RECORD=1 COLLIE_RIG_KEY_FILE=/path/to/.env bunx playwright test -c e2e/rig/playwright.config.ts
bun run e2e:recordings:check
git add e2e/rig/cassettes
```

A recording run writes into this checkout's `e2e/rig/cassettes/`. A case that did not pass live
leaves a recording too, and `meta.json` lists it under `failed` (the leg tells the stub each case's
verdict). A replay plays that run back. When such a case fails on replay, its note says so first and
gives the command to record that one case again:

```sh
COLLIE_RIG_LIVE=pi COLLIE_RIG_RECORD=1 COLLIE_RIG_KEY_FILE=/path/to/.env bunx playwright test -c e2e/rig/playwright.config.ts -g "<the case title>"
```

That run rewrites only that case and clears its mark when it passes. Commit the recordings like
fixtures, after reading the diff and running the check.

A record run settles each case when its verdict arrives.
A case that passes with no model call removes that harness's recording of it.
A case that passes with calls overwrites the file and clears the mark.
A case that fails keeps an earlier good recording and logs one line.
A good recording has the same model and skill, and no mark.
Without a good recording, the failed case writes the new one and marks it.
A replay run never changes a cassette.
A harness version bump leaves the old `<version>` folder.
Delete that folder in the same commit that records the new version.

**Where they live.** `cassettes/<harness>/<version>/<case>.jsonl`, one file per case (`pi.walky-agents`,
`claude.walky-broadcast` for the pi or omp calls of a Claude case, `cassettes/claude/2.1.312/pi.walky-agents`
for Claude's calls in a pi case), and `meta.json` per version with one
entry per leg (`solo`, `crew`). A line holds one model request's summary (the wire format, the model, the
tool names, the last prompt's text, the kinds of the items after it) and the recorded server-sent events
with their delays. No request body, no header and no key is stored. omp's Responses stream echoes the
request's `instructions` (the system prompt) and `tools` in its `response.*` events; the recorder keeps
those events but empties the two fields. Values that differ on every run
(walky ids, pane addresses, uuids, dates, ports, the rig's folders, and the folders in Claude's dashed
form) and the machine's own host name (`{{host}}`, the first label of `os.hostname()`, which `collie walky who`
prints) are placeholders such as `{{walky:0}}`, `{{lab}}` and `{{labdash}}`, and a replay fills in this
run's values (`VOLATILE` in `replay/cassette.ts`).

**A mismatch.** When a request has no recording, for example because a case's prompt or the skill text
changed, the stub answers HTTP 422 `cassette mismatch ... re-record`, the harness ends the turn and
paints that text, and the case fails with the stub's message first. It never gets a nearby answer.
Record again.

**The redaction check.** `bun run e2e:recordings:check` in `web/` reads every file under
`e2e/rig/cassettes/`. It fails on any of these:

- an OpenRouter, Anthropic or OpenAI key pattern, or a bearer token;
- an Authorization or x-api-key header;
- a home path, or a host or company name of the owner;
- a `.jsonl` file over 1 MiB;
- a case listed under `failed` in a `meta.json`.

It prints the file and line, never the matched text. The vitest
`e2e/rig/cassettes-check.test.ts` runs the same check on every CI test run. Run it before every commit
that adds recordings. The recorder blanks a key pattern the model echoes, and stores no header, so the
check is the second line.

## Cost of one run

On replay, pi, omp and Claude spend no model turn: the stub serves them. The turn counts below are what the
leg asks of each harness, and on a live run (a new version, or forced) they are paid turns: OpenRouter
for pi and omp, the subscription for Claude.

- Claude: 24 model turns on Haiku (the count of `turns-claude` in the run folder): the permission
  request, the pick-many question, the long list plus one message sent while it streams, seven prompts for the Load older history (each reads four tiny files and
  replies with a marker), and 13 for walky talky: the operator's message (6), the nudge from pi (8), the
  permission request, the message that waited behind it, the draft once sent and the message held behind
  it (9), the broadcast (10), the
  forged header (11, two), the long list and the message sent during it (16), and the question and the
  message that waited behind it (17). The picker and case 18 need no turn. A run caps each harness at 25 turns (`TURN_CAP` in `leg.ts`), and every turn is logged in
  `~/.cache/collie-lab/browser-leg-state/turns.log`.
- pi and omp: 11 turns each, replayed from the recordings (no cost), or on Haiku 4.5 when live. Case 26 adds 1 on pi (the long turn; the steered line is answered inside it). Case 28 adds none. Walky talky adds 6 on pi (case 7,
  the send and the reply nudge of case 8, the broadcast, and the two of case 16) and 4 on omp (case 7, the
  broadcast and the two of case 16). Their "Load older" history is
  seven prompts ("Reply with exactly DONE-n") and 45 shell lines (`!echo`) after the first, which run
  without the model and pad the rows past the 40-row page floor. omp's permission case runs
  omp with `--approval-mode write`, so a bash call asks.
- The crew leg (cases 12 to 15 and 19 to 21) adds 6 Claude turns and 4 pi turns, and about 4 minutes plus the rig's
  start. A nightly run is therefore about 15 minutes, 29 Claude turns, 21 pi turns and 15 omp turns.
- Time: about 11 minutes for all three harnesses, about 3 of them for Claude alone. A case that waits
  out its reply timeouts adds up to 4 minutes.

## What it never touches

- The operator's Herdr server and its panes. Every `herdr` call runs with the rig's own
  `XDG_CONFIG_HOME` and drops every inherited `HERDR_*` name (`rig-lib.ts`).
- Any Collie lane, port 8787-8799, 5198, 5199, or a `collie*.service` unit. The bridge and the model
  stub listen on 127.0.0.1:18700-18799, the bridge with its own HOME, state and config. The crew leg's two bridges do the same,
  each with its own.
- Any `collie` CLI verb. The rig pairs with the bridge's own pairing module, and the crew leg enrols
  with the verbs' own functions, whose restart, `serve`, `exec` and push are the rig's stand-ins.
- The operator's bridges, from inside a harness. Each harness starts with `COLLIE_STATE_DIR` set to
  the rig's state dir. So a `collie walky` that an agent runs in a rig pane reaches the rig's bridge
  first. Without it, the CLI looks for bridges in the hook target registry under the real home. The
  rig's bridge is not listed there, because it registers under its own HOME.
- The operator's agent config. Each harness gets a scratch config under
  `~/.cache/collie-lab/browser-leg-state/harness/<id>/`. Only what it needs is copied there at
  0600: Claude's OAuth file without its refresh token (a dummy login when Claude replays), and pi's `auth.json` only when there is no key
  file and pi does not replay. omp gets no copy of `agent.db`: its key comes from the environment
  through the stub, or it replays and needs none. The bridge reads the journals of these scratch homes, never
  `~/.claude/projects`.
- The checkout the nightly runner starts from. It works in its own clone, ledger and logs only.
- Processes it did not start. Every kill is by a recorded pid after `/proc/<pid>/cmdline` matched.
