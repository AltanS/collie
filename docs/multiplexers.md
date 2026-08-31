# tmux and zellij

Collie drives one multiplexer per install. Herdr is the default; this page is the other two — how to
point Collie at a tmux server or a zellij session, what each one can and cannot answer, and the
beacons that tell Collie an agent is in a pane at all.

## Using the app on tmux or zellij

> **Experimental in 1.0.** tmux and zellij were probed on **tmux 3.6b** and **zellij 0.44.2**, by one
> operator, on one host. Herdr stays the default and the fully supported path. **We want testers:**
> open an issue on [AltanS/collie](https://github.com/AltanS/collie/issues/new) titled `tmux: …` or
> `zellij: …` and say which multiplexer and version, which OS, and what you saw — what worked as much
> as what did not.

Collie drives **one** multiplexer per install, named by `COLLIE_MUX`. The two walkthroughs below get
you from a `.env` to a dashboard listing your own windows. The reference for every key is
[`MUX_CONTRACT.md` → Pointing a collie at a multiplexer](../MUX_CONTRACT.md#pointing-a-collie-at-a-multiplexer);
this section is the path through it, not a copy of it.

**Herdr is not required in this mode.** With `COLLIE_MUX=tmux` or `COLLIE_MUX=zellij` the bridge
builds only the adapter you named and never dials Herdr's socket, and multi-session discovery — which
walks Herdr's own config root — turns itself off (`bridge/index.ts`). Herdr does not have to be
installed or running. Without it, drive Collie from the checkout with `scripts/collie-ctl.sh start`,
and the `.env` lives in `~/.config/collie/` instead of the plugin config dir.

### Pointing Collie at tmux

```bash
# in your .env — see Configure for where that file lives
COLLIE_MUX=tmux
COLLIE_MUX_ENDPOINT_TMUX=/run/user/1000/collie-tmux.sock  # a socket PATH (tmux -S), because it has a /
# COLLIE_MUX_ENDPOINT_TMUX=work                           # a socket NAME (tmux -L work), no /
# COLLIE_MUX_ENDPOINT_TMUX=                               # empty: tmux's own default server
# COLLIE_TMUX_BIN=/usr/bin/tmux                           # only if tmux sits somewhere unusual
```

`COLLIE_TMUX_BIN` is empty for almost everyone: Collie probes a short list of fixed paths and
deliberately never reads `PATH`, which a service and a Herdr action do not share with your shell.
**Keep a socket path short** — a Unix socket path longer than about 100 characters cannot be
connected to at all, and tmux says `error connecting to … (File name too long)`. `/run/user/<uid>/`
or `/tmp` is the place for it; a deep checkout is not.
One caveat lives here too: on tmux below 3.7 with `window-size` set to `manual`, opening a window
crashes the server, so Collie refuses to open one — see
[Requirements](install.md#requirements) for the one-line fix.

Then, in order:

1. **Restart after any `.env` edit** — `bin/collie restart`.
2. **Install the beacon hooks** — `bin/collie hooks install claude`, once per host. Without them a
   pane is only a shell and the dashboard names every one of them `bash`; it edits your *global*
   `~/.claude/settings.json` and never a project's
   ([the detail](#collie-writes-hooks-into-claudes-own-settings)).
3. **Start an agent in a window Collie can see** — and relaunch any Claude that was already running,
   because a running Claude does not reload its hooks:

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

Empty means *the* running session. With no session, or with two, Collie refuses to start rather than
guess, and names what it found. A session you named that has since exited is refused by name — never
silently swapped for a neighbour. One environment variable is easy to lose: zellij finds its sessions
through `XDG_RUNTIME_DIR`, and a Collie that reports every session as exited is looking at a unit file
without it ([contract](../MUX_CONTRACT.md#pointing-a-collie-at-a-multiplexer)).

**A zellij session outlives the terminal that started it.** Start one anywhere — `zellij -s
collie-zellij` — then detach with `Ctrl o` `d`: the session keeps running on the host, and that
running session is what Collie drives. On a host you never sit at, `zellij attach --create-background
collie-zellij` starts the same session with no terminal at all (probed on zellij 0.44.2). Collie
itself never creates a session and never resurrects one.

Then, in order:

1. **Restart after any `.env` edit** — `bin/collie restart`.
2. **Install the beacon hooks** — `bin/collie hooks install claude`, once per host. Without them a
   pane is only a shell and the dashboard names every one of them `bash`; it edits your *global*
   `~/.claude/settings.json` and never a project's
   ([the detail](#collie-writes-hooks-into-claudes-own-settings)).
3. **Start an agent in a tab Collie can see** — and relaunch any Claude that was already running,
   because a running Claude does not reload its hooks:

```bash
zellij --session collie-zellij action new-tab --name claude
# in that tab
claude
```

### Did it work?

```bash
bin/collie doctor      # the `mux` check names the multiplexer, its endpoint, and whether it answered
bin/collie logs        # `[bridge] mux: tmux · socket /run/user/1000/collie-tmux.sock`, printed at
                       # startup; a multiplexer it cannot reach is one warning line more
curl -s http://127.0.0.1:8787/api/snapshot | head -c 400   # the herd, as the phone is given it
```

That `curl` needs no device header: both write gates leave reads alone, so a read answers even with
`COLLIE_DEVICE_HEADER` set ([Configure](configure.md#configure)). A write from the shell is the case that needs
the header you configured.

Then open the phone: the dashboard lists your **tmux windows** or **zellij tabs**, and the pane you
launched Claude in names the agent rather than `bash`. If every pane still reads as a shell, the
beacon hooks are missing — next section.

### Collie writes hooks into Claude's own settings

On tmux and zellij a pane is just a shell, so the agent has to say what it is. That is a
[beacon](#agent-beacons-optional-linux), and it needs Collie's hooks in Claude Code's settings:

```console
$ bin/collie hooks install claude
$ bin/collie hooks status
would install: /home/you/collie/bin/collie beacon emit  (this checkout)
/home/you/.claude/settings.json: installed (v1)
```

Say it plainly, because it edits a file you own:

- The target is your **global** `~/.claude/settings.json` (and any `CLAUDE_CONFIG_DIR` profile).
  A project's `.claude/settings.json` is never written.
- It adds **five** entries, each marked `# collie-beacon v1`, each with a 10 s timeout. Every hook
  beside them is left exactly where it was, and `hooks uninstall claude` removes only the marked ones.
- **An already-running Claude does not reload its hooks.** Relaunch the agents you want seen.
- **Linux only** — the liveness check reads `/proc`; elsewhere a beacon is simply never written.
- **A beacon belongs to one multiplexer.** It names the pane it was written for by that
  multiplexer, its session and its pane, so after you change `COLLIE_MUX` the beacons written under
  the old one match nothing. Nothing deletes them and nothing breaks — `collie doctor` simply keeps
  counting them under `beacons`.
- If you set `COLLIE_STATE_DIR`, export it in the shell your agents run in too: `collie beacon emit`
  resolves the state dir from **its own** environment, so a beacon otherwise lands where the bridge
  is not reading.

`collie doctor` reports this as the `beacon-hooks-claude` check and names the install command as the
remedy — including when a hook still points at a checkout that has moved. What a beacon may and may
not do is [Agent beacons](#agent-beacons-optional-linux); this is only the setup step.

### What changes compared with Herdr

The reader's summary. **The truth is the cell in [`MUX_CONTRACT.md`](../MUX_CONTRACT.md)** — each row
links to it.

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

Without a beacon, tmux and zellij report every pane as a plain shell, and pane history is **declared
absent** rather than served empty.

### Three things that feel different on the phone

- **Pull to refresh.** On the dashboard and on a space, drag down and let go: Collie asks the
  multiplexer to look *now* rather than waiting for its next round. The pane view has no pull —
  its scroller is the terminal mirror, where pulling reaches older output instead.
- **"synced Ns ago"** sits under the dashboard header, and it is the age of what you are looking at.
  It appears **only where the bridge promises a bounded freshness** — today that is **zellij**, which
  has no way to announce a new tab and so is re-counted on a schedule (worst case 12 s). Under Herdr
  and tmux there is no chip, because those announce their changes and there is nothing to wait for.
- **"Show in terminal"** is a row in a pane's actions. Tap it and the terminal you are attached to on
  the host jumps to that pane. It is **absent under zellij** — zellij's focus command accepts the
  request and moves nothing, so Collie declines it rather than offering a button that lies.

**The phone never moves your terminal on its own.** Only that one named tap does. Browsing the herd,
opening a pane, backing out — none of it touches the cursor of whoever is typing on the host
([ADR 0031](../.adr/0031-freshness-is-a-declared-promise.md)).

### tmux tips — getting your windows back after a reboot

Collie persists nothing about your multiplexer. A tmux server that dies takes every window with it,
and Collie then has nothing left to list. tmux's own plugins fix that, and they are entirely optional:
[tpm](https://github.com/tmux-plugins/tpm) installs plugins,
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) saves and restores the session tree,
and [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum) does the saving for you.

What comes back is the **windows**, their layout and their working directories. **The agents inside do
not come back running** — start Claude Code again by hand. Picking its old conversation back up is
Claude's own feature (`claude --resume` / `claude --continue`), not the plugin's.

### zellij tips — after a reboot there is nothing to restore

zellij has no tpm-and-resurrect story for Collie to lean on. What it has is its own: a session that
outlived its terminal is listed as `(EXITED - attach to resurrect)`, and attaching re-runs the
commands that session was built from. That is an operator's act with side effects, so **Collie never
attaches and never resurrects** — an exited session reads as *unreachable*, not as an empty herd, and
the phone shows the disconnected banner naming the session rather than a herd that has lost its tabs.

So after a reboot the two steps are yours: start the session again — `zellij -s collie-zellij`, or
`zellij attach --create-background collie-zellij` on a host you never sit at — and start the agents
in it by hand, the same way you did the first time. Picking a conversation back up is again Claude's
own `--resume` / `--continue`.


## Agent beacons (optional, Linux)

A **beacon** is the agent telling Collie what only the agent knows: a hook in Claude Code's own
settings runs `collie beacon emit`, which writes one small file naming the harness, the session and
the pane it is running in. Herdr reports all of that itself — beacons are for **tmux and zellij**,
where a pane is otherwise just a shell. Installing them is a step of
[Using the app on tmux or zellij](#collie-writes-hooks-into-claudes-own-settings); this section is
what they are.

```console
$ bin/collie hooks install claude
$ bin/collie hooks status
would install: /home/you/collie/bin/collie beacon emit  (this checkout)
/home/you/.claude/settings.json: installed (v1)
```

`status` reads and writes nothing; `hooks uninstall claude` removes only the entries Collie marked as
its own. It edits your *global* Claude settings, never a project's. Linux only — the liveness check
reads `/proc`, and on any other host a beacon is simply never written.

A Claude is visible from the moment it starts — the hook fires on `SessionStart`, so a pane you have
opened but not yet typed into shows an idle agent rather than a shell.

What you get: the dashboard names the agent in each pane instead of `bash`, so **"needs you" can sort
by who is actually blocked** — and a status is something notifications can fire on at all. Pane
history works too, because the beacon carries the session key the journal needs.

What you do **not** get: any control. A beacon sets what Collie *shows* and what it *looks up*, and
nothing else — it can never cause a send, a key, a rename or a close, and it relaxes no gate. The
threat model, and why some obviously useful fields do not exist, are
[ADR 0024](../.adr/0024-a-beacon-is-a-hint-never-a-control-channel.md).


---

[← back to the README](../README.md)
