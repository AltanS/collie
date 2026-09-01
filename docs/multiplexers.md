# tmux and zellij

Collie drives one multiplexer per install. Herdr is the default. This page covers the other two
options: how to point Collie at a tmux server or a zellij session, what each backend supports, and
the beacons Collie uses to detect an agent in a pane.

## Using the app on tmux or zellij

> **Experimental in 1.0.** tmux and zellij support was tested on **tmux 3.6b** and **zellij 0.44.2**
> on a single host. Herdr remains the default and primary supported backend. **Testers wanted:**
> open an issue on [AltanS/collie](https://github.com/AltanS/collie/issues/new) titled `tmux: …` or
> `zellij: …`. Include your multiplexer, version, OS, and observed behavior (both working and
> broken).

Collie drives **one** multiplexer per install, configured by `COLLIE_MUX`. If unset on the first
run, `start` probes for Herdr, tmux, and zellij, prompts for a selection, and writes the choice to
`.env`. The walkthroughs below cover setting up `.env` to list your windows on the dashboard. For
the full configuration reference, see
[`MUX_CONTRACT.md` → Pointing a collie at a multiplexer](../MUX_CONTRACT.md#pointing-a-collie-at-a-multiplexer).

**Herdr is not required in this mode.** When using `COLLIE_MUX=tmux` or `COLLIE_MUX=zellij`, the
bridge loads only the selected adapter and ignores Herdr's socket. Multi-session discovery across
Herdr config roots is disabled (`bridge/index.ts`). You do not need Herdr installed or running. Run
Collie directly from the repository with `scripts/collie-ctl.sh start`. In this setup, `.env`
resides in `~/.config/collie/` instead of the plugin configuration directory.

### Pointing Collie at tmux

```bash
# in your .env — see Configure for where that file lives
COLLIE_MUX=tmux
COLLIE_MUX_ENDPOINT_TMUX=/run/user/1000/collie-tmux.sock  # a socket PATH (tmux -S), because it has a /
# COLLIE_MUX_ENDPOINT_TMUX=work                           # a socket NAME (tmux -L work), no /
# COLLIE_MUX_ENDPOINT_TMUX=                               # empty: tmux's own default server
# COLLIE_TMUX_BIN=/usr/bin/tmux                           # only if tmux sits somewhere unusual
```

`COLLIE_TMUX_BIN` is usually left unset. Collie checks a list of standard paths and deliberately
avoids reading `PATH`, which background services and Herdr actions do not share with login shells.
**Keep socket paths short.** Unix domain sockets longer than roughly 100 characters fail to connect,
causing tmux to return `error connecting to … (File name too long)`. Use `/run/user/<uid>/` or
`/tmp` rather than a deep directory path.

Note: on tmux versions before 3.7 with `window-size` set to `manual`, creating a window crashes the
server. Collie blocks window creation in this state. See [Requirements](install.md#requirements) for
the fix.

Setup steps:

1. **Restart after editing `.env`:** `collie restart`.
2. **Install the beacon hooks:** run `collie hooks install claude` once per host. Without hooks,
   panes appear as generic shells named `bash`. This command updates your global
   `~/.claude/settings.json` and leaves project configs untouched
   ([details below](#collie-writes-hooks-into-claudes-own-settings)).
3. **Start an agent in a visible window:** relaunch existing Claude instances so they pick up the
   new hooks:

```bash
tmux -S /run/user/1000/collie-tmux.sock new-window -n claude
# in that window
claude
```

### Pointing Collie at zellij

```bash
# in your .env
COLLIE_MUX=zellij
COLLIE_MUX_ENDPOINT_ZELLIJ=collie-zellij                  # a session NAME, not a path
# COLLIE_MUX_ENDPOINT_ZELLIJ=                             # empty: the single running session
# COLLIE_ZELLIJ_BIN=/home/you/.local/bin/zellij           # only if zellij sits somewhere unusual
```

If your distribution lacks zellij packages, download a binary from
[zellij's GitHub releases](https://github.com/zellij-org/zellij/releases) and place it in your
`PATH`.

Leaving the endpoint empty defaults to the currently running session. If zero or multiple sessions
exist, Collie halts with an error rather than selecting one automatically. If a named session exits,
Collie reports it by name instead of switching to an active one. Zellij relies on `XDG_RUNTIME_DIR`
to locate sessions; if Collie reports all sessions as exited, ensure the systemd service includes
this environment variable ([contract](../MUX_CONTRACT.md#pointing-a-collie-at-a-multiplexer)).

**Zellij sessions persist independently of their initial terminal.** Create a session with
`zellij -s collie-zellij` and detach using `Ctrl o` `d`. On headless hosts,
`zellij attach --create-background collie-zellij` starts a detached session directly (verified on
zellij 0.44.2). Collie manages active sessions but does not create or restart them.

Setup steps:

1. **Restart after editing `.env`:** `collie restart`.
2. **Install the beacon hooks:** run `collie hooks install claude` once per host. Without hooks,
   panes appear as generic shells named `bash`. This updates global `~/.claude/settings.json`
   without modifying project settings
   ([details below](#collie-writes-hooks-into-claudes-own-settings)).
3. **Start an agent in a visible tab:** restart existing Claude instances to load the hooks:

```bash
zellij --session collie-zellij action new-tab --name claude
# in that tab
claude
```

### Did it work?

```bash
collie doctor  # the `mux` check names the multiplexer, its endpoint, and whether it answered
collie logs    # `[bridge] mux: tmux · socket /run/user/1000/collie-tmux.sock`, printed at
               # startup; a multiplexer it cannot reach is one warning line more
curl -s http://127.0.0.1:8787/api/snapshot | head -c 400   # the herd, as the phone is given it
```

This `curl` call works without auth headers. Read requests bypass device validation even when
`COLLIE_DEVICE_HEADER` is enabled ([Configure](configure.md#configure)). Only write actions require
the configured header.

Check the phone UI: the dashboard should display your **tmux windows** or **zellij tabs**, and the
Claude pane should identify as an agent instead of `bash`. If panes still display as standard
shells, verify the beacon hook installation below.

### Collie writes hooks into Claude's own settings

Because tmux and zellij expose panes as generic shells, agents must announce themselves. This
requires installing Collie's [beacon](#agent-beacons-optional-linux) hooks into Claude Code's
configuration:

```console
$ collie hooks install claude
$ collie hooks status
would install: /home/you/collie/bin/collie beacon emit  (this checkout)
/home/you/.claude/settings.json: installed (v1)
```

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

### Three things that feel different on the phone

- **Pull to refresh:** Swipe down on dashboard and space views to trigger an immediate multiplexer
  poll. The terminal pane view does not support pull-to-refresh; swiping there scrolls through
  terminal buffer history.
- **"synced Ns ago":** This indicator appears in the dashboard header to show data age. It is
  displayed **only when the backend relies on scheduled polling**, such as **zellij** (up to 12s
  polling interval). Herdr and tmux push state changes immediately, so the freshness badge is
  omitted.
- **"Show in terminal":** This pane action focuses the selected pane in your active host terminal.
  It is **disabled on zellij** because zellij's focus command accepts the instruction without
  changing view state.

**The mobile interface never changes host terminal focus automatically.** Only the explicit "Show in
terminal" action updates the display. Navigating the dashboard or opening panes does not affect the
active host cursor ([ADR 0031](../.adr/0031-freshness-is-a-declared-promise.md)).

### tmux tips — getting your windows back after a reboot

Collie does not store multiplexer state. Restarting a tmux server destroys its windows, leaving the
dashboard empty. You can manage state restoration using standard tmux plugins:
[tpm](https://github.com/tmux-plugins/tpm) for plugin management,
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) for saving session trees, and
[tmux-continuum](https://github.com/tmux-plugins/tmux-continuum) for automated snapshots.

These tools restore **window layouts** and working directories. **Running agent processes are not
preserved.** Restart Claude Code manually after recovery. To restore conversation context, use
Claude's built-in flags: `claude --resume` or `claude --continue`.

### zellij tips — after a reboot there is nothing to restore

Zellij does not provide an equivalent to tmux-resurrect. Sessions persisted after terminal
detachment show as `(EXITED - attach to resurrect)`. Attaching triggers re-execution of session
commands. Because this produces side effects, **Collie does not attach to or resurrect sessions.**
Exited sessions appear as *unreachable*, and the UI displays a disconnection banner instead of an
empty session list.

Following a reboot, start the session manually (`zellij -s collie-zellij` or
`zellij attach --create-background collie-zellij` for headless systems) and launch agents inside it.
Reconnect to prior agent sessions using `claude --resume` or `claude --continue`.


## Agent beacons (optional, Linux)

A **beacon** is how an agent identifies itself to Collie. A hook in Claude Code settings runs
`collie beacon emit`, which writes a file containing the harness name, the session, and the target
pane. Herdr tracks this natively. Beacons exist for **tmux and zellij**, where a pane otherwise
appears as a generic shell. Setup details are in
[Using the app on tmux or zellij](#collie-writes-hooks-into-claudes-own-settings); this section
explains the mechanism.

```console
$ collie hooks install claude
$ collie hooks status
would install: /home/you/collie/bin/collie beacon emit  (this checkout)
/home/you/.claude/settings.json: installed (v1)
```

The path above references `bin/collie` from the local checkout. A binary install points to the
installed binary instead, [as described above](#collie-writes-hooks-into-claudes-own-settings). The
`status` command performs no writes. Running `hooks uninstall claude` removes only entries added by
Collie. It modifies your *global* Claude configuration, not project-level files. This is Linux-only:
the liveness check inspects `/proc`, and Collie writes no beacons on other operating systems.

Claude becomes visible immediately on startup. Because the hook triggers on `SessionStart`, an open
pane waiting for input displays as an idle agent instead of a shell.

Visibility ends when the process exits. Collie verifies the emitting PID on each check. Once the
agent terminates, the pane immediately reports as a standard shell instead of lingering in an
unknown state. Collie does not delete the beacon file to do this: the file remains on disk,
`collie doctor` reports it under `beacons` as *expired*, and the next hook invocation overwrites it.

This allows the dashboard to label panes by agent name rather than `bash`. It lets **"needs you"
sort panes by blocked status**, and provides the state required for alerts. Pane history also relies
on the beacon to supply the session key used by the journal.

Beacons provide **no control channel**. A beacon only determines what Collie *displays* and
*queries*. It cannot send text, inject keystrokes, rename panes, close sessions, or bypass access
controls. The threat model and omitted fields are documented in
[ADR 0024](../.adr/0024-a-beacon-is-a-hint-never-a-control-channel.md).


---

[← back to the README](../README.md)
