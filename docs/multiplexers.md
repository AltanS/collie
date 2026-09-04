# Multiplexers

Collie drives one multiplexer per install: Herdr, tmux or zellij. Herdr is the default. This page
covers pointing Collie at any of the three, what each backend can answer, and the beacons Collie
uses to detect an agent in a pane.

## Pointing Collie at a multiplexer

Name the backend in `COLLIE_MUX`, point it at an endpoint, restart, and install the beacon hooks.

> **Experimental in 1.0.** tmux and zellij were tested on **tmux 3.6b** and **zellij 0.44.2**, on a
> single host. Herdr is the default and the primary supported backend. **Testers wanted:** open an
> issue on [AltanS/collie](https://github.com/AltanS/collie/issues/new) titled `tmux: …` or
> `zellij: …`, with your multiplexer, version, OS, and what you saw.

Name the multiplexer on the command line:

```bash
COLLIE_MUX=herdr collie start
COLLIE_MUX=tmux collie start
COLLIE_MUX=zellij collie start
```

Set the endpoint when the default target is not the one you want:

```bash
# in your .env. See Configure for where that file lives.
COLLIE_MUX=tmux
COLLIE_MUX_ENDPOINT_TMUX=/run/user/1000/collie-tmux.sock
COLLIE_MUX_ENDPOINT_ZELLIJ=collie-zellij

# only if the binary sits somewhere unusual
# COLLIE_TMUX_BIN=/usr/bin/tmux
# COLLIE_ZELLIJ_BIN=/home/you/.local/bin/zellij
```

| variable | value | what it means |
| --- | --- | --- |
| `COLLIE_MUX` | `herdr`, `tmux` or `zellij` | which backend this install drives |
| `COLLIE_MUX_ENDPOINT_TMUX` | `/run/user/1000/collie-tmux.sock` | a socket PATH (`tmux -S`), because it has a `/` |
| `COLLIE_MUX_ENDPOINT_TMUX` | `work` | a socket NAME (`tmux -L work`), no `/` |
| `COLLIE_MUX_ENDPOINT_TMUX` | empty | tmux's own default server |
| `COLLIE_MUX_ENDPOINT_ZELLIJ` | `collie-zellij` | a session NAME, not a path |
| `COLLIE_MUX_ENDPOINT_ZELLIJ` | empty | the single running session |
| `COLLIE_TMUX_BIN` | `/usr/bin/tmux` | only if tmux sits somewhere unusual |
| `COLLIE_ZELLIJ_BIN` | `/home/you/.local/bin/zellij` | only if zellij sits somewhere unusual |

Herdr has no endpoint variable here: its socket is `HERDR_SOCKET_PATH`, not a
`COLLIE_MUX_ENDPOINT_` name.

Then restart, install the beacon hooks, and start an agent where the phone can see it:

```bash
collie restart                 # after every .env edit
collie hooks install claude    # once per host, tmux and zellij only

# open a window or a tab for the agent
tmux -S /run/user/1000/collie-tmux.sock new-window -n claude
zellij --session collie-zellij action new-tab --name claude

claude                         # in that window or tab
```

### What those commands did

`COLLIE_MUX` on the command line sets the choice for that run and for every later run. `start`
writes the name to `.env`, so running `collie start` later drives the same multiplexer.

With `COLLIE_MUX` unset, `start` probes for Herdr, tmux, and zellij, prompts for a backend, and
writes the answer to `.env`. For the full configuration reference, see
[`MUX_CONTRACT.md` → Pointing a collie at a multiplexer](../MUX_CONTRACT.md#pointing-a-collie-at-a-multiplexer).

`collie hooks install claude` installs Collie's [beacon](#agent-beacons-optional-linux) hooks, which
tmux and zellij require. They expose panes as generic shells, so without hooks every pane appears as
`bash`.

The command updates `~/.claude/settings.json` and leaves project configs untouched
([details below](#collie-writes-hooks-into-claudes-own-settings)). Running Claude instances do not
reload their configuration, so restart them.

> **Note.** Herdr is not required in this mode. With `COLLIE_MUX=tmux` or `COLLIE_MUX=zellij`, the
> bridge loads only the selected adapter and ignores Herdr's socket. Multi-session discovery across
> Herdr config roots is disabled (`bridge/index.ts`). You do not need Herdr installed or running,
> and `.env` lives in `~/.config/collie/` instead of the plugin configuration directory.

### tmux notes

`COLLIE_TMUX_BIN` is usually left unset. Collie checks a list of standard paths and does not read
`PATH`, which background services and Herdr actions do not share with login shells.

> **Note.** Keep socket paths short. Unix domain sockets longer than roughly 100 characters fail to
> connect, and tmux returns `error connecting to … (File name too long)`. Use `/run/user/<uid>/` or
> `/tmp` rather than a deep directory path.

On tmux versions before 3.7 with `window-size` set to `manual`, creating a window crashes the
server. Collie blocks window creation in this state. See [Requirements](install.md#requirements) for
the fix.

### zellij notes

If your distribution lacks zellij packages, download a binary from
[zellij's GitHub releases](https://github.com/zellij-org/zellij/releases) and place it in your
`PATH`.

Leaving the endpoint empty defaults to the single running session. If zero or multiple sessions
exist, Collie halts with an error instead of selecting one. If a named session exits, Collie reports
it by name instead of switching to an active one.

Zellij requires `XDG_RUNTIME_DIR` to locate sessions. If Collie reports all sessions as exited,
verify that the systemd service includes this environment variable
([contract](../MUX_CONTRACT.md#pointing-a-collie-at-a-multiplexer)).

Zellij sessions persist independently of their initial terminal. Create a session with
`zellij -s collie-zellij` and detach using `Ctrl o` `d`. On headless hosts,
`zellij attach --create-background collie-zellij` starts a detached session directly (verified on
zellij 0.44.2).

> **Note.** Collie manages active sessions, but it does not create or restart them.

### Did it work?

```bash
collie doctor   # the `mux` check names the multiplexer, its endpoint,
                # and whether it answered

# `[bridge] mux: tmux · socket /run/user/1000/collie-tmux.sock`, printed at
# startup; a multiplexer it cannot reach is one warning line more
collie logs

# the herd, as the phone is given it
curl -s http://127.0.0.1:8787/api/snapshot | head -c 400
```

This `curl` call works without auth headers. Read requests bypass device validation even when
`COLLIE_DEVICE_HEADER` is enabled ([Configure](configure.md#configure)). Only write actions require
the configured header.

Check the phone UI: the dashboard should display your **tmux windows** or **zellij tabs**, and the
Claude pane should identify as an agent instead of `bash`. If panes still display as standard
shells, verify the beacon hook installation below.

### Collie writes hooks into Claude's own settings

```console
$ collie hooks install claude
$ collie hooks status
would install: /home/you/collie/bin/collie beacon emit  (this checkout)
/home/you/.claude/settings.json: installed (v1)
```

Because tmux and zellij expose panes as generic shells, agents must announce themselves. This
requires installing Collie's [beacon](#agent-beacons-optional-linux) hooks into Claude Code's
configuration.

The output references the `bin/collie` path from this repository. Package installs use the installed
binary path (`~/.local/bin/collie` or `~/.local/share/collie/current/bin/collie`) rather than
versioned directories, ensuring links remain valid across updates.

Behavior details for Claude configuration changes:

- Modifies the **global** `~/.claude/settings.json` and any active `CLAUDE_CONFIG_DIR`.
  Project-level `.claude/settings.json` files are untouched.
- Injects **five** hooks tagged `# collie-beacon v1` with 10-second timeouts. Existing hooks are
  preserved. `hooks uninstall claude` removes only Collie entries.
- **Running Claude processes do not reload configuration.** Restart agents to apply changes.
- **Linux only.** The agent liveness check depends on `/proc`. Other operating systems do not emit
  beacons.
- **Beacons are multiplexer-specific.** They record pane and session identifiers for the active
  backend. Switching `COLLIE_MUX` invalidates existing beacons. Old beacons remain on disk until
  cleared, visible under `collie doctor`'s `beacons` count.
- If using `COLLIE_STATE_DIR`, export it in the agent's shell environment. `collie beacon emit`
  reads this variable directly; otherwise, beacons write to the default state directory where the
  bridge will not find them.

`collie doctor` includes a `beacon-hooks-claude` diagnostic check that points out missing hooks or
broken paths to moved checkouts. For runtime details, see
[Agent beacons](#agent-beacons-optional-linux).

### What changes compared with Herdr

The table below summarizes key differences. Refer to [`MUX_CONTRACT.md`](../MUX_CONTRACT.md) for the
exact specification.

| | Herdr | tmux | zellij |
| --- | --- | --- | --- |
| [a **space** is](../MUX_CONTRACT.md#what-a-space-and-a-tab-are-per-multiplexer) | a workspace | a session | the session — exactly one, so the phone drops the space strip |
| [a **tab** is](../MUX_CONTRACT.md#what-a-space-and-a-tab-are-per-multiplexer) | a tab | a window | a tab |
| [a **pane** is](../MUX_CONTRACT.md#what-a-space-and-a-tab-are-per-multiplexer) | a pane | a pane | a terminal pane |
| [who says a pane holds an agent](../MUX_CONTRACT.md#capabilities) | Herdr does, itself | a [beacon](#agent-beacons-optional-linux), or nothing | a [beacon](#agent-beacons-optional-linux), or nothing |
| [how soon an unannounced change is seen](../MUX_CONTRACT.md#the-declared-facts--not-capabilities-either) | pushed | pushed | counted on a schedule, 12 s ceiling |
| ["Show in terminal"](../MUX_CONTRACT.md#capabilities) | yes | yes | **no** — zellij accepts the request and moves nothing |
| [open / rename / close a tab](../MUX_CONTRACT.md#capabilities) | yes | yes (opening is refused on the tmux crash case above) | yes |
| [open a space](../MUX_CONTRACT.md#capabilities) | yes | yes | **no** — a session it made would be invisible to it |
| [pane history](../MUX_CONTRACT.md#capabilities) | from Herdr's own pane record | from the beacon's session key | from the beacon's session key |

Without active beacons, tmux and zellij present panes as raw shells, and pane history is marked
unavailable rather than returning empty content.

### Two things that feel different on the phone

- **"synced Ns ago":** This indicator appears in the dashboard header to show data age. It is
  displayed **only when the backend relies on scheduled polling**, such as **zellij** (up to 12s
  polling interval). Herdr and tmux push state changes immediately, so the freshness badge is
  omitted.
- **"Show in terminal":** This pane action focuses the selected pane in your active host terminal.
  It is **disabled on zellij** because zellij's focus command accepts the instruction without
  changing view state.

> **Note.** The mobile interface never changes host terminal focus automatically. Only the explicit
> "Show in terminal" action updates the display. Navigating the dashboard or opening panes does not
> affect the active host cursor
> ([ADR 0031](../.adr/0031-freshness-is-a-declared-promise.md)).

### tmux tips — getting your windows back after a reboot

Collie does not store multiplexer state. Restarting a tmux server destroys its windows, leaving the
dashboard empty.

You can manage state restoration using standard tmux plugins:
[tpm](https://github.com/tmux-plugins/tpm) for plugin management,
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) for saving session trees, and
[tmux-continuum](https://github.com/tmux-plugins/tmux-continuum) for automated snapshots.

These tools restore **window layouts** and working directories. To restore conversation context, use
Claude's built-in flags: `claude --resume` or `claude --continue`.

> **Note.** Running agent processes are not preserved. Restart Claude Code manually after recovery.

### zellij tips — after a reboot there is nothing to restore

Zellij does not provide an equivalent to tmux-resurrect. Sessions persisted after terminal
detachment show as `(EXITED - attach to resurrect)`, and attaching triggers re-execution of session
commands.

> **Note.** Because attaching produces side effects, Collie does not attach to or resurrect
> sessions. Exited sessions appear as *unreachable*, and the UI displays a disconnection banner
> instead of an empty session list.

Following a reboot, start the session manually (`zellij -s collie-zellij` or
`zellij attach --create-background collie-zellij` for headless systems) and launch agents inside it.
Reconnect to prior agent sessions using `claude --resume` or `claude --continue`.


## Agent beacons (optional, Linux)

A **beacon** is how an agent identifies itself to Collie, on tmux and zellij, where a pane otherwise
appears as a generic shell.

```console
$ collie hooks install claude
$ collie hooks status
would install: /home/you/collie/bin/collie beacon emit  (this checkout)
/home/you/.claude/settings.json: installed (v1)
```

A hook in Claude Code settings runs `collie beacon emit`, which writes a file containing the harness
name, the session, and the target pane. Herdr tracks this natively. Setup details are in
[Pointing Collie at a multiplexer](#collie-writes-hooks-into-claudes-own-settings); this section
explains the mechanism.

The path above references `bin/collie` from the local checkout. A binary install points to the
installed binary instead, [as described above](#collie-writes-hooks-into-claudes-own-settings). The
`status` command performs no writes.

Running `hooks uninstall claude` removes only entries added by Collie. It modifies your *global*
Claude configuration, not project-level files. This is Linux-only: the liveness check inspects
`/proc`, and Collie writes no beacons on other operating systems.

Claude becomes visible immediately on startup. Because the hook triggers on `SessionStart`, an open
pane waiting for input displays as an idle agent instead of a shell.

Visibility ends when the process exits. Collie verifies the emitting PID on each check, so once the
agent terminates, the pane immediately reports as a standard shell instead of lingering in an
unknown state.

Collie does not delete the beacon file to do this: the file remains on disk, `collie doctor` reports
it under `beacons` as *expired*, and the next hook invocation overwrites it.

This allows the dashboard to label panes by agent name rather than `bash`. It lets **"needs you"
sort panes by blocked status**, and provides the state required for alerts. Pane history also relies
on the beacon to supply the session key used by the journal.

> **Note.** Beacons provide no control channel. A beacon only determines what Collie *displays* and
> *queries*. It cannot send text, inject keystrokes, rename panes, close sessions, or bypass access
> controls. The threat model and omitted fields are documented in
> [ADR 0024](../.adr/0024-a-beacon-is-a-hint-never-a-control-channel.md).


---

[← back to the README](../README.md)
