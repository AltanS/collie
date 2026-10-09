# 0091: An agent is started by id, with a request id and a receipt

- **Status:** Accepted
- **Date:** 2026-10-09
- **Shipped in:** pending (1.19.0)
- **Relates to:** [ADR 0089](./0089-a-second-agent-on-a-branch.md) (the receipt pattern this reuses),
  [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the crew link forwards, it does
  not interpret).
- **Trail:** `bridge/harness-launch.ts` · `bridge/launch-receipts.ts` · `bridge/worktree-receipts.ts`
  (`ReceiptFileStore`, `memoryReceipts`) · `bridge/server.ts` (`launch`, `pickLaunch`, `runLaunch`,
  `launchersRoute`) · `web/src/routes/new.tsx` · `web/src/lib/new-page.ts` · spec M48/01

## Context

> **Addendum 2026-10-09 (1.19.0).** The New sheet became the New page, `/new`: a full page with a
> select for the agent and one for the command, and what cannot run stays in its select, disabled,
> with the reason in brackets (it was listed in a block at the top). The decision is unchanged.

The New sheet (M48) starts an agent, a `launchers.toml` row or a plain shell from one place. Until
now the phone knew which agents exist from a list compiled into the web app, and the only way to
start one was a `launchers.toml` row the operator had written. That left three gaps:

- **The phone guessed.** A closed list of harness names in the web app is wrong on any machine that
  has a different set installed, and wrong again for every crew member.
- **The bridge's PATH is not the operator's.** A systemd user unit runs with a short PATH. On the
  development host, `opencode` (`~/.opencode/bin`) and `pi` (an nvm folder) are found only by a login
  shell (`bash -lc`), which is also the shell the new pane runs. A search on the bridge's own PATH
  said "not installed" for two agents that start fine.
- **A retried Start was a second pane.** `POST /api/launch` had no idempotency. A reply lost on a
  bad link, then a second tap, opened two agents.

## Decision

**The bridge owns the list of agents it can start, reports it per machine, and starts one by id. A
launch carries a phone-minted request id, and a retry with that id never starts a second pane.**

1. **The list is the bridge's.** `bridge/harness-launch.ts` maps each id to a label and ONE binary
   word (`claude`, `codex`, `opencode`, `pi`, `omp`, `grok`, `hermes`, `muse`, `agy`). Every id is a
   name of the mux contract (`MUX_AGENT_NAMES`), and every contract name is either started or named
   with its reason (`antigravity` is the desktop app; its terminal agent is `agy`). A test pins both.
2. **Found is checked on the login shell's PATH.** Once per process, the bridge asks the operator's
   login shell (`$SHELL -lc 'printf %s "$PATH"'`, argv only, killed after 3 s) for its PATH, and
   searches each binary there with the existing tool search (`findTool`). Only POSIX shells and fish
   are asked; Windows and an unknown shell use the bridge's own PATH. The answer is cached for 60 s.
3. **The list rides on `GET /api/launchers`** as the optional `harnesses: [{ id, label, found }]`.
   The crew already forwards that route with `?host=`, so each member reports its own. A body
   without the field is an older bridge, and the phone offers no agents for it rather than guessing.
4. **A launch names exactly one kind.** The body has one of `command` (a `launchers.toml` row,
   matched exactly as before), `harness` (an id from the list) or `shell: true`. None or two is a
   400. An unknown id is `launch.unknown_harness`, before anything runs. The bridge types the
   binary; the phone never sends a command line.
5. **A folder may be named.** `cwd` opens the pane there: absolute, or `~`-relative, with no control
   character (`launch.bad_folder`). A row's pinned `cwd` still wins. A folder that worked joins
   Recent, as the multiplexer reported it.
6. **One receipt per request id.** The phone mints a UUID per Start intent. The bridge stores the
   outcome of every launch that succeeded in `<stateDir>/launch-receipts.json` (0600, at most 200,
   oldest dropped), with ADR 0089's store, now generic. A known id answers the stored pane with
   `replayed: true`; an id still in flight is joined. The second check runs with no `await` between
   it and `track`, so two requests with one id cannot both start. A failed launch stores nothing:
   its pane was closed again, so the same id may run again.
7. **The phone never re-sends on its own.** A network error, a 5xx or a crew `write_outcome_unknown`
   is shown as "We could not confirm the start". The operator may tap "Try again", which sends the
   same id, so it lands on the receipt if the first one worked.

## Consequences

- An agent installed under the login shell's PATH only (nvm, `~/.opencode/bin`) now shows as found,
  and starts.
- The web app keeps no list of harness names for this page. A new harness is a row in
  `bridge/harness-launch.ts`, and every phone sees it on the next launchers read.
- The state dir gains one file, written only by a launch that carries an id.
- A launch on a member reaches the member through the existing forward; the request id travels in
  the body, so the receipt lives where the pane was made.
- The login shell is asked once per bridge process. A change to the operator's shell profile needs a
  bridge restart to be seen.

## Amendment, 2026-10-09: a bare folder name is under home, and the folder must exist

Rule 5 said `cwd` is absolute or `~`-relative. A person typed `projects`, got `launch.bad_folder`,
and the page said nothing. Now a path with no leading `/` or `~` is a folder under home, as `cd
projects` is in a fresh shell, resolved in the bridge so every client gets one rule. `..` segments,
control characters and `~name` still give `launch.bad_folder`. A named folder (the person's, or a
row's pinned one) that is not a directory on the machine that runs the start gives
`launch.folder_missing` with `{ folder }`, before anything runs; a crew member checks its own disk.
The page shows the full path in its summary before Start and does not check while the person types.

