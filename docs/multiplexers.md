# Multiplexers

Collie drives one multiplexer per install: Herdr, tmux, zellij, tuios or tern. A sixth backend, `durable`, is not a multiplexer but a durable agent program with no screen (see [durable notes](#durable-notes)). Herdr is the default. This
page covers pointing Collie at any of them, what each backend can answer, and the beacons Collie
uses to detect an agent in a pane.

## Pointing Collie at a multiplexer

Name the backend in `COLLIE_MUX`, point it at an endpoint, restart, and install the beacon hooks.

> **Experimental.** tmux and zellij (since 1.0) were tested on **tmux 3.6b** and **zellij 0.44.2**,
> on a single host. tuios (since 1.15.0) was tested on **tuios 0.8.4**. Tern was probed by its
> contributor on **tern 0.4.5**, a closed beta that the maintainers cannot run.
> Herdr is the default and the primary supported backend. **Testers wanted:** open an issue on
> [AltanS/collie](https://github.com/AltanS/collie/issues/new) titled `tmux: …`, `zellij: …`,
> `tuios: …` or `tern: …`, with your multiplexer, version, OS, and what you saw.

Name the multiplexer on the command line:

```bash
COLLIE_MUX=herdr collie start
COLLIE_MUX=tmux collie start
COLLIE_MUX=zellij collie start
COLLIE_MUX=tuios collie start
COLLIE_MUX=tern collie start
COLLIE_MUX=durable COLLIE_DURABLE_SOCKET=/run/user/1000/durable/session.sock collie start
```

Set the endpoint when the default target is not the one you want:

```bash
# in your .env: ~/.config/collie/.env, or Herdr's plugin config dir on a Herdr
# install. See Configure for the full precedence.
COLLIE_MUX=tmux
COLLIE_MUX_ENDPOINT_TMUX=/run/user/1000/collie-tmux.sock
COLLIE_MUX_ENDPOINT_ZELLIJ=collie-zellij

# only if the binary sits somewhere unusual
# COLLIE_TMUX_BIN=/usr/bin/tmux
# COLLIE_ZELLIJ_BIN=/home/you/.local/bin/zellij
```

| variable | value | what it means |
| --- | --- | --- |
| `COLLIE_MUX` | `herdr`, `tern`, `tmux`, `zellij`, `tuios` or `durable` | which backend this install drives |
| `COLLIE_MUX_ENDPOINT_TMUX` | `/run/user/1000/collie-tmux.sock` | a socket PATH (`tmux -S`), because it has a `/` |
| `COLLIE_MUX_ENDPOINT_TMUX` | `work` | a socket NAME (`tmux -L work`), no `/` |
| `COLLIE_MUX_ENDPOINT_TMUX` | empty | tmux's own default server |
| `COLLIE_MUX_ENDPOINT_ZELLIJ` | `collie-zellij` | a session NAME, not a path |
| `COLLIE_MUX_ENDPOINT_ZELLIJ` | empty | the single running session |
| `COLLIE_MUX_ENDPOINT_TUIOS` | `/run/user/1000/tuios/tuios.sock` | the tuios daemon's socket PATH |
| `COLLIE_MUX_ENDPOINT_TUIOS` | empty | `$XDG_RUNTIME_DIR/tuios/tuios.sock`, else `/tmp/tuios-<uid>/tuios.sock` |
| `COLLIE_MUX_ENDPOINT_TERN` | `/run/user/1000/tern/daemon.sock` | the Tern daemon's socket PATH |
| `COLLIE_MUX_ENDPOINT_TERN` | empty | `$XDG_RUNTIME_DIR/tern/daemon.sock`, else `/tmp/tern-<uid>/daemon.sock` |
| `COLLIE_DURABLE_SOCKET` | `/run/user/1000/durable/session.sock` | the PATH of the Unix socket a durable program listens on. Absolute, at most 103 bytes, no default |
| `COLLIE_DURABLE_URL` | `https://collie-durable-member.you.workers.dev` | the address of a durable program behind TLS, instead of the socket. `https://` only, or `http://127.0.0.1:<port>` for `wrangler dev` |
| `COLLIE_DURABLE_TOKEN` | `your-32-byte-random-token-here` | the bearer token sent with every request to that URL. At least 32 bytes, always set with the URL |
| `COLLIE_TERN_BIN` | `/home/you/.local/opt/tern/tern` | only if tern sits somewhere unusual |
| `COLLIE_TMUX_BIN` | `/usr/bin/tmux` | only if tmux sits somewhere unusual |
| `COLLIE_ZELLIJ_BIN` | `/home/you/.local/bin/zellij` | only if zellij sits somewhere unusual |

Herdr has no endpoint variable here: its socket is `HERDR_SOCKET_PATH`, not a
`COLLIE_MUX_ENDPOINT_` name.

That socket is the local one and no other. A machine saved in Herdr is not a crew member, and only
a Collie crew brings another machine's sessions to the phone. What each list is, and why one is not
the other, is in [Herdr machines and the crew](crew.md#herdr-machines-and-the-crew).

Then restart, install the beacon hooks, and start an agent where the phone can see it:

```bash
collie restart                 # after every .env edit
collie hooks install claude    # once per host, tmux, zellij and tern only

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
tmux, zellij and tern require. They expose panes as generic shells, so without hooks every pane appears as
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
server. Collie blocks window creation in this state and tells you to run
`tmux set -g window-size latest`; [Requirements](install.md#requirements) lists the tested
versions.

With `automatic-rename` on, tmux renames a window after whatever program is running in it; Collie
shows the last folder of that window's active pane instead, since a screenful of tabs named `bash`
says nothing. A window you named yourself keeps that name.

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

Zellij 0.44 and later reports each pane's folder, so zellij panes get the Files button and show
their branch. An older zellij reports no folder, and its panes have neither.

### tern notes

Point Collie at Tern:

```bash
COLLIE_MUX=tern collie start
collie hooks install claude   # beacon hooks for agent detection
```

Collie reads Tern sessions as spaces, tabs as tabs, and blocks as panes. The endpoint is the Tern daemon's socket, defaulting to `$XDG_RUNTIME_DIR/tern/daemon.sock` (or `/tmp/tern-<uid>/daemon.sock`). Inside a Tern pane, `$TERN_PANE` identifies the block and `$TERN_PANE_SOCKET` points at the daemon socket.

Tern reports lifecycle events via `tern events`, enabling immediate topology change notifications.

"Show in terminal" moves your Tern window to the pane's session and tab and focuses its block. A tab or a session that Collie creates opens in the background and does not move your window.

Collie does not detect Tern on its own, as it does not detect tuios: name it with `COLLIE_MUX=tern`. Typed text longer than 128 KiB is refused, because it travels as one command-line argument.

### durable notes

> **Experimental.** The wire may change in any minor release. The wire is written down in
> [`bridge/mux/durable/WIRE.md`](../bridge/mux/durable/WIRE.md), and a program and a Collie that do
> not share a version get a named `incompatible` instead of a silent mismatch.

`durable` is for a durable agent program: a program that runs agents, keeps their conversations and
has no screen. Collie shows each of its conversations as a pane that has **Chat and nothing else**.
There is no Terminal view, because there is no terminal. Two settings turn it on:

```bash
COLLIE_MUX=durable                                    # which backend this install drives
COLLIE_DURABLE_SOCKET=/run/user/1000/durable/session.sock   # where the program listens
```

The program listens on that socket, and Collie dials it. Name the backend with `COLLIE_MUX=durable`:
Collie does not detect it on its own. The path must be absolute and at most 103 bytes. Collie
connects only when the socket is yours and has no group or other permission (mode `0600`), because
the socket carries no token and a private socket is the whole gate. Run Collie in a peer of its
own beside any Herdr one, since one install mirrors one backend.

#### Two ways to reach a program

```bash
# a program on this machine, as you
COLLIE_DURABLE_SOCKET=/run/user/1000/durable/session.sock

# or a program you deployed behind TLS, for example on Cloudflare
COLLIE_DURABLE_URL=https://collie-durable-member.you.workers.dev
COLLIE_DURABLE_TOKEN=your-32-byte-random-token-here
```

Set one of the two, never both. A URL without a token, or both set, is a config error: the peer
starts, names the error in its log, and shows the program as unreachable with that reason.
The socket transport is for Linux and macOS. On Windows use the URL and the token: a socket path
there is the same config error, and the peer says so in its log and in `collie doctor`.

| | private socket | https with a token |
| --- | --- | --- |
| Where the program runs | this machine, as your user | anywhere you deploy it |
| What keeps others out | the socket is yours, mode `0600` | the token, and only the token |
| Who can act as your phone | any process of your user | anyone who has the token |
| How often Collie asks | every 1 s while a phone watches, else every 3 s | every 2 s while a phone watches, else every 10 s |

The URL must start with `https://`. The one exception is `http://127.0.0.1:<port>` or
`http://localhost:<port>`, with a port, for `wrangler dev` on the same machine. Collie refuses any
other `http://` address, because the token would cross the network unencrypted.

Make the token 32 random bytes or more, for example with `openssl rand -hex 32`, and give the
program the same value. Collie sends it with every request and never prints it: `collie doctor`
says "set, 64 bytes", nothing more. To change it, deploy the new token to the program, set it in the
peer's `.env`, and run `collie restart`.

> **Caution.** Over https the token is the only gate. Anyone who has it can read every
> conversation and answer every question, and the host (Cloudflare, for example) sees the text. A
> program reached this way should offer Allow and Deny only, never an always-allow.

Every poll over https is a billed request: on Cloudflare one poll is one Worker request and one
Durable Object request, and a "nothing changed" answer counts too. With no phone open the idle poll
runs every 10 s, and the bridge's own safety-net poll reuses its last answer, so a peer asks 8,640
times a day. That fits the Workers Paid plan, which is the honest recommendation for a program you
poll all day. On the Free plan it leaves little room for anything else.

A Worker and a Durable Object that speak this wire, to run under `wrangler dev` first and then
deploy, are in
[`examples/durable-member-cloudflare`](../examples/durable-member-cloudflare/README.md).

What works:

- The program's conversations in the list, in the merged crew list, and in Chat and History.
- Questions the program asks, such as a tool that needs a yes or a no. You answer them from the
  phone, and only a tap answers.
- Send text, steer a turn that is running, and stop it.
- The program's starters, as rows on the New page.

What does not work:

- Terminal, and typed keys. A durable pane has no screen to show or type into.
- New tabs, renaming and closing tabs or workspaces. The program lays out its own conversations.
- "Show in terminal". No pane is ever reported as focused.
- Another user's program on the socket. The socket must belong to the user that runs Collie.
- A program on another machine over plain TCP. Reach it over https with a token, as above, or run a
  Collie peer on the machine with the program and join it to the crew.

To try it, run the example program in
[`examples/durable-member`](../examples/durable-member/README.md). It is a small Pi Durable app with
a scripted model, so it needs no key, and it opens a conversation with a question to answer as soon
as it starts. Its README walks you from the first command to the answer on your phone.

One Collie serves one backend, so a durable program needs a Collie of its own, even on a host that
already runs Herdr. A bridge that drives two backends at once is not part of this release. In
practice you run a second Collie instance on the same host with `COLLIE_MUX=durable`, give it its
own port and state directory, and join it to the crew with `collie join` like any other peer. The
steps for the second instance are in
[Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host), and
[Crew commands](crew.md#how-a-crew-is-wired) says what a peer is.

With a lead older than 1.21.0, the pane is listed but the question is not. The pane shows "needs you"
with a red dot, and no card appears. Chat shows the tool call as a collapsed step with no Allow or
Deny. The actions sheet still offers Terminal view, and it stays empty. Update the lead and the card
and the Chat page work. Nothing crashes before that.

A member's crew name defaults to its host name. A durable peer that shares a host with the lead, or
with a Herdr peer, would join under the same name, and the host chip could not tell them apart.
Name it when it joins: `COLLIE_INSTANCE=durable collie crew join <lead-address> --label durable`.
To rename a peer that already joined, run `collie crew remove <member>` on the lead and
`collie crew leave` on the peer, then join again with `--label`. (`collie crew rename` names the
crew, not a member.)

When Collie cannot reach the program, the peer starts anyway and shows the program as unreachable,
with a reason:

| reason | what it means |
| --- | --- |
| `COLLIE_DURABLE_SOCKET is not set`, `must be an absolute path`, `is longer than 103 bytes` | the variable is missing or unusable |
| `the private socket transport is not available on Windows` | on Windows set `COLLIE_DURABLE_URL` and `COLLIE_DURABLE_TOKEN` instead of the socket |
| `COLLIE_DURABLE_SOCKET and COLLIE_DURABLE_URL are both set` | set the socket, or the URL with its token, not both |
| `COLLIE_DURABLE_URL is set without COLLIE_DURABLE_TOKEN` | the URL needs its token |
| `COLLIE_DURABLE_URL uses plain http to <host>` | use `https://`; plain http is for 127.0.0.1 or localhost only |
| `COLLIE_DURABLE_TOKEN is <n> bytes; it must be at least 32 bytes, for example 64 hex characters from openssl rand -hex 32` | make a longer token, and give the program the same one |
| `token-refused` | the program answered 401 or 403: the two sides hold different tokens |
| `no socket at <path>` | nothing listens there yet |
| `socket-not-private` | the path is not a socket, is not yours, or has a group or other permission |
| `connection refused`, `no answer within <n>ms` | a stale socket file, a program that hangs, or nothing at the URL yet |
| `tls refused`, `the host name does not resolve` | the URL's certificate or name is wrong |
| `incompatible: program speaks 2..3, this Collie speaks 1..1` | the version ranges do not meet. Update the older side |
| `starting` | the program is up and says it is not ready yet. Collie asks again on the next poll |

`collie doctor` checks the same things in six lines, `durable-env`, `durable-socket`,
`durable-url`, `durable-token`, `durable-hello` and `durable-ready`, and names the failing check
with a fix. `durable-env` says which way the peer reaches the program, and the lines for the other
way are skipped with the reason. A seventh line, `durable-lead`, warns on a peer whose lead runs a
release below 1.21.0: that lead shows durable panes without the question card, and its Terminal tab
polls. The peer also writes that sentence to its log once. Update the lead.

### tuios notes

tuios reports agents itself, so it needs no beacon hooks:

```bash
COLLIE_MUX=tuios collie start
tuios integration install claude-code   # once, so tuios hears the agent's hooks
```

Collie reads the agent, its state and its conversation from the tuios daemon. A pane that waits
for you shows as blocked, and a pane's history opens when the agent reported its conversation. An
agent that Collie has no harness for shows as a shell.

Collie shows each tuios session as a space, each workspace as a tab, and each window as a pane. A
workspace shows as a tab while it holds a pane. A pane that runs on another machine is not shown.
Point a Collie on that machine at its own tuios.

The endpoint is the daemon's socket. Leave it empty to use the socket that `tuios` itself uses.
Collie reads `XDG_RUNTIME_DIR` to find it, so make sure the service has that variable. Inside a
tuios pane, `echo $TUIOS_SOCKET` prints the path.

Collie needs **tuios 0.8.3 or newer**: the daemon must announce the `workspace-renamed` event,
which 0.8.2 does not. With an older daemon, Collie
shows the bridge as disconnected and the log says what to update.

Some things work differently on tuios:

- A new tab opens on the lowest empty workspace. A session has nine workspaces by default, so
  Collie refuses a tenth tab.
- Show in terminal moves every terminal that shows the pane's session, a tuios-web tab included.
  tuios cannot move a terminal to another session. If no terminal shows the pane's session, Collie
  refuses and names the session the terminal shows.
- The **New worktree** switch on the New page stays, off, and says it needs Herdr.

### Did it work?

```bash
collie doctor   # the `mux` check names the multiplexer, its endpoint,
                # and whether it answered (durable: the six `durable-*` checks)

# `[bridge] mux: tmux · socket /run/user/1000/collie-tmux.sock`, printed at
# startup; a multiplexer it cannot reach is one warning line more
collie logs

# the herd, as the phone is given it; reads need the pairing token
curl -s -H "Authorization: Bearer $COLLIE_TOKEN" http://127.0.0.1:8787/api/snapshot | head -c 400
```

Every read needs a paired device's token, so this `curl` call sends one. Without it, the bridge
answers `403 device not paired`. To get a token for a script, see
[Upgrading to 1.18.0](upgrading.md#upgrading-to-1180). `collie doctor` needs no token on the host.
`COLLIE_DEVICE_HEADER` still gates only writes and the Files view
([Pair a device](security.md#pair-a-device--the-write-credential)).

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

Because tmux, zellij and tern expose panes as generic shells, agents must announce themselves. This
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
| [a **space** is](../MUX_CONTRACT.md#what-a-space-and-a-tab-are-per-multiplexer) | a workspace | a session | the session, exactly one, so the phone drops the space strip |
| [a **tab** is](../MUX_CONTRACT.md#what-a-space-and-a-tab-are-per-multiplexer) | a tab | a window | a tab |
| [a **pane** is](../MUX_CONTRACT.md#what-a-space-and-a-tab-are-per-multiplexer) | a pane | a pane | a terminal pane |
| [who says a pane holds an agent](../MUX_CONTRACT.md#capabilities) | Herdr does, itself | a [beacon](#agent-beacons-optional-linux), or nothing | a [beacon](#agent-beacons-optional-linux), or nothing |
| [how soon an unannounced change is seen](../MUX_CONTRACT.md#the-declared-facts--not-capabilities-either) | pushed | pushed | counted on a schedule, 12 s ceiling |
| ["Show in terminal"](../MUX_CONTRACT.md#capabilities) | yes | yes | **no**, zellij accepts the request and moves nothing |
| [open / rename / close a tab](../MUX_CONTRACT.md#capabilities) | yes | yes (opening is refused on the tmux crash case above) | yes |
| [open a space](../MUX_CONTRACT.md#capabilities) | yes | yes | **no**, a session it made would be invisible to it |
| [pane history](../MUX_CONTRACT.md#capabilities) | from Herdr's own pane record | from the beacon's session key | from the beacon's session key |

Without active beacons, tmux, zellij and tern present panes as raw shells, and pane history is marked
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

### tmux tips, getting your windows back after a reboot

```bash
claude --resume      # reconnects the conversation, not the window
```

Collie does not store multiplexer state. Restarting a tmux server destroys its windows, leaving the
dashboard empty. Standard tmux plugins restore the window layouts and working directories:
[tpm](https://github.com/tmux-plugins/tpm) for plugin management,
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) for saving session trees, and
[tmux-continuum](https://github.com/tmux-plugins/tmux-continuum) for automated snapshots.

> **Note.** Running agent processes are not preserved. Restart Claude Code manually after recovery.

### zellij tips, after a reboot there is nothing to restore

```bash
zellij -s collie-zellij                                  # start the session
zellij attach --create-background collie-zellij          # headless: start it detached
claude --resume                                           # reconnects the agent
```

Zellij does not provide an equivalent to tmux-resurrect. Sessions persisted after terminal
detachment show as `(EXITED - attach to resurrect)`, and attaching triggers re-execution of session
commands, so a reboot means starting the session fresh with one of the commands above and launching
agents inside it, reconnecting each with `claude --resume` or `claude --continue`.

> **Note.** Because attaching produces side effects, Collie does not attach to or resurrect
> sessions. Exited sessions appear as *unreachable*, and the UI displays a disconnection banner
> instead of an empty session list.


## Agent beacons (optional, Linux)

A **beacon** is how an agent identifies itself to Collie, on tmux, zellij and tern, where a pane otherwise
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

The path above references `bin/collie` from the local checkout. A binary install points to
`~/.local/bin/collie`, or to `~/.local/share/collie/current/bin/collie` when that name is not
linked, [as described above](#collie-writes-hooks-into-claudes-own-settings). The `status` command
performs no writes.

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
