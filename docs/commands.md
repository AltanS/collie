# Commands

Every verb uses the format **`collie <verb>`**. This is the canonical syntax across all
installations, implemented directly in the binary (`cli/`). Before adding `collie` to your PATH
([below](#put-collie-on-your-path)), run `bin/collie <verb>` from the repository root. On a
Herdr-managed installation, these same verbs register as Herdr actions ([below](#herdr-actions))
with identical behavior.

If the host runs multiple instances, prepend `COLLIE_INSTANCE=<name>` to every verb. See
[Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host).

| Verb | Command | What it does |
| --- | --- | --- |
| **Start** | `collie start` | Build if needed, serve, print the URL |
| **Stop** | `collie stop` | Pause the bridge; removes nothing |
| **Restart** | `collie restart` | Stop, then start |
| **Status** | `collie status` · `collie status --verbose` · `collie status --json` | The *Collie is running* banner + URLs, then three short blocks: the crew's members (name, link, version, mux, panes), the paired devices, and the agent sessions by state. `--verbose` adds the `tailscale serve` dump. `--json` prints the same facts as one line of JSON for a program to read: `running`, `version`, `instance`, `port`, `localUrl`, `phoneUrl`, `crew`, `service`, `pairedDevices`, `mux`, `muxPickedBecause` and `census` (see below) |
| **Serve status** | `collie serve status` | Print what `tailscale serve` publishes on this machine, which is every front door on it and not only Collie's. Read only. `collie status --verbose` prints the same |
| **URL** | `collie url` | Print the tailnet URL |
| **QR** | `collie qr` | The same URL as a scannable code |
| **Version** | `collie version` | The running version (`0.x.y+sha`) |
| **Skill** | `collie skill` | The agent-facing brief on Collie, for an AI coding agent working in your terminal (also `collie --skill`). `collie skill install`, `uninstall`, `sync`, `status` and `print` manage the walky talky skill in your agents' instruction files; `collie update` runs `sync` after each update ([Install the skill](walky-talky.md#install-the-skill)) |
| **Docs** | `collie docs` · `collie docs <name>` · `collie docs --all` | These pages, printed out of the binary itself |
| **Update** | `collie update` | Stage the newest release of your major, flip to it, restart and verify (`--check` preflights, `--status` reports, `--major` crosses one) |
| **Rollback** | `collie update --rollback` | Put the previous version back (not on a Herdr-managed checkout, which has none staged) |
| **Uninstall** | `collie uninstall` | Remove the service; keep `.env` and the install |
| **Pair** | `collie pair` · `collie pair --expires <duration>` | Print an 8-character code and a QR code, good for 10 minutes; scan the QR code to open Settings → System → Paired devices with the code filled in, or enter the code manually to get it [paired](security.md#pair-a-device--the-write-credential). Without `--expires` the token never expires and the command says so; with it (`12h`, `30d`, `2w`) the command prints the date the token stops working once claimed. A script claims the code with a label of its own, for example `script`, and pairs once ([Give a device an expiry](security.md#give-a-device-an-expiry)). `--json` prints the code as one line of JSON for a program that shows it in its own window: `code`, `expiresAt`, `tokenLifetimeMs`, `replaced`, `url`, and `qr`, the code's modules as rows of `1` (dark) and `0` (light) |
| **Devices** | `collie devices list` · `collie devices revoke <label>` · `collie devices set-expiry <label> <duration>` · `collie devices clear-expiry <label>` | List / revoke paired devices, or change when one [expires](security.md#give-a-device-an-expiry). `list` shows each device's expiry as `no expiry`, `expires <date>` or `EXPIRED <date>`. `set-expiry` counts a new lifetime from now; `clear-expiry` removes it. A label matches exactly, or without case when only one device fits |
| **Link** | `collie link` · `collie unlink` | Put `collie` on your PATH ([below](#put-collie-on-your-path)) |
| **Logs** | `collie logs` | Tail the service log |
| **Config** | `collie config show` · `collie config check` · `collie config init` | Print every setting with its source, validate the file, or write a commented `config.toml` ([the config file](configure.md#the-config-file)) |
| **Durable agents** | `collie durable attach <name> --socket <path>` · `collie durable attach <name> --url <url> --token-env <VAR>` · `collie durable detach <name>` · `collie durable list` | Add a durable agent to `sources.json`, remove it, or list each durable agent with the state the running bridge gives it. `attach` and `detach` apply at the next restart, or at once with `--restart`. Flags, output and exit codes: [Durable agents](durable-agents.md#the-three-verbs) |
| **Multiplexers** | `collie mux list` · `collie mux list --json` | Every multiplexer this build can drive, which of them this machine has, which Collie instance drives each, and the command that starts one nobody drives ([which multiplexers this machine has](multiplexers.md#which-multiplexers-this-machine-has)) |
| **Walky talky** | `collie walky who` · `collie walky send <address> <text>` · `collie walky reply <id> <text>` · `collie walky inbox` · `collie walky status <id>` | Message an agent session from a terminal, or from one agent to another ([Walky talky](walky-talky.md)) |
| **Agent sessions** | `collie sessions` · `collie sessions --state blocked` · `collie sessions --member <member>` · `collie sessions --all` · `collie sessions --json` | List every agent session the crew shows: member, mux, seat, harness, state, whether a session is known, and how long ago you last used it. Read-only ([Sessions](sessions.md#list-the-sessions-from-a-terminal)) |
| **Voice** | `collie stt setup` · `stt test` · `stt status` · `stt off` | Configure / check / disable [voice input](voice-and-push.md#voice-input-optional) |
| **Push keys** | `collie push-keys` | Generate the VAPID keypair into your `.env` |
| **Push test** | `collie push-test` | Send one notification to prove it works |

The CLI also includes `build`, `serve` (publish the front door; `serve status` reads it), `unserve`, `doctor`, and `crew …` for less frequent tasks.

Both `start` and `status` output the **Collie is running** banner: a health mark and the version,
then a `service`, a `local` and a `tailnet` line.
[First run](install.md#first-run-what-youll-see) shows it in full, including what a failed health
check prints instead. The reported version reads from the served bundle stamp, reflecting the active
build.

**What `collie status` prints under the banner.** Three blocks, each short:

- `members` has one line per machine in the crew: its name, the link (`reachable`, `unreachable`,
  `incompatible` or `unenrolled`), the version it reports, its mux and its pane count. A member that
  does not answer shows `unreachable` and the other lines still print. Mux and pane count are what
  the member itself reports. They show `-` for a member on a build older than 1.25.0, and a member
  whose bridge is still starting shows its mux and `-` for panes, never `0`. A machine with no crew
  prints `no crew` and no members block.
- `devices` has the count of paired phones, and their names when there are five or fewer.
- `sessions` counts this bridge's agent sessions by state (`working`, `blocked`, `idle`, `done`,
  `unknown`) and says how many report a session id. On a lead the count covers the whole crew. With
  no bridge running it says `bridge not running`, and the command still exits 0.

The sessions block reads the bridge's own snapshot with the local read credential in the state
folder, the same way `collie doctor` does. It never sends a Tailscale header. The member lines use
the same dials as `collie crew status` (a `hello` and a `snapshot` per member), and the dials run at
the same time.

`collie status --json` keeps every key it had and adds `census`, an object with three parts:
`members` (a list of `{ name, role, link, version, mux, panes }`, empty without a crew), `devices`
(`{ count, names }`) and `sessions` (`{ read, refusedWith, total, byState, withSessionId }`).
`read` is `ok`, `bridge-not-running`, `refused` or `unreadable`. When it is not `ok`, `total`,
`byState` and `withSessionId` are `null`, because a count that was not read is not zero.

**Ink or plain text.** The `start`, `status`, `doctor`, `crew add`, and `crew status` commands
render an interactive terminal UI when stdout is a TTY. Passing `--plain`, or redirecting output to
a pipe, file, systemd journal, or CI runner, falls back to raw line output.

**`collie doctor` says which state it read.** Its first line names the instance (`default`, or the
name in `COLLIE_INSTANCE`) and the state directory it reads. If you run two lanes on one machine,
check that line before you trust the rest, because a shell with the wrong `COLLIE_INSTANCE` reads
the wrong lane. `--json` gives the same two values as `instance` and `stateDir` on the `collie`
entry. To read a lane without exporting anything, run `collie doctor --instance <name>`. It reads
that lane and wins over `COLLIE_INSTANCE`; `--instance default` reads the unsuffixed one. A name
this machine has no config for stops with exit 2 and lists the instances it does have. Only
`doctor` takes the flag. Every other command still reads `COLLIE_INSTANCE`.

**`collie doctor` lists your agent programs.** Each program Collie has an input profile for gets
one `harness-<name>` row: the file Collie would run on your login shell's `PATH`, the version it
printed, and the profile's verdict on that version. A version above the verified range is only a
note, because sends in a turn are still trusted. The row warns when the file resolves but its
version cannot be read, for example a wrapper first on `PATH` that needs `$HOME`, or a broken
install: until the version reads, Collie treats every send to that program as provisional. A program
that is not installed shows `not installed`. In `--json` each row also carries `harness`, `binary`,
`version` and `profileStatus`.

The row names the copy on your `PATH`, because `collie doctor` has no pane to look at. A send on
Herdr asks the program that runs in its pane, so a pane that runs another copy, started by its full
path or installed in a project, shows that copy's version on its receipts.

**`collie doctor` says whether sends reach each agent program.** Each program gets one
`sends-<harness>` row that counts its sends by outcome, over its newest 50 sends of the last 7 days.
A send you discarded or cancelled, or one still held, does not count. The row warns when 3 or more
sends ended and none went through, or when 5 or more ended and at least 30 percent were `unknown` or
`typed_not_submitted` for a reason that points at Collie, the same reasons that offer Report a
problem on the phone. It turns red when 10 or more ended and none went through. A red row makes
`collie doctor` exit 1, but it does not hold back an update, because an update is often the fix.

Two more kinds of row follow the `sends-*` rows. A `holds-<harness>` row lists the sends still held
for that program, oldest first, each with how long it has waited, the reason the phone shows
(`a running turn`, `something open at the box`, `a draft in the box`) and its request id. It never
prints the held text. It warns when a hold has waited more than 10 minutes, and says to open the pane
on the phone and send or cancel it. With no hold open, one `holds` row says so. A `screen-<harness>`
row counts, over the same window as the sends row, the sends that met a screen Collie could not type
into (a stale screen) and the other probe failures. It warns when 3 or more in a row ended that way
with no other send between them. In `--json` both carry `harness`, and a holds row also carries a
`holds` array of `requestId`, `cause`, `ageMs` and `state`.

Receipts with no agent program, which come from a plain shell pane, make a separate `-` group
(`sends--`, `holds--`, `screen--`). Those rows only show counts and always print `ok`. A shell has no
agent to confirm that a send was submitted, so its outcomes say nothing about whether sends reach an
agent program.


## See what this Collie knows

Four read-only verbs answer "what is here?" from a terminal. They write nothing and restart nothing,
and each one has a `--json` form for a program.

| Question | Command | What it tells you |
| --- | --- | --- |
| Is it running, and with whom? | `collie status` | The banner and URLs, then the crew's members, the paired devices and the agent sessions by state |
| Which multiplexers are here? | `collie mux list` | Every multiplexer this build can drive, which this machine has, and which instance drives each |
| Which agent sessions exist? | `collie sessions` | One row per agent session of the whole crew: member, mux, seat, harness and state |
| Which machines are in the crew? | `collie crew status` | Each member's link, version, mux and pane count, with the reason when a link is refused |

Start with `collie status`. It gives the counts. Go to `collie sessions` for the rows behind the
session count, to `collie mux list` for the multiplexer behind a mux name, and to `collie crew status`
for one member's link in detail. A member older than 1.25.0 shows `-` for its mux and pane count in
`status` and `crew status`. When one machine runs two Collies, `collie status` and `collie crew status`
group the members under that machine's name, one line per instance.

## Put `collie` on your PATH

Run `collie link` to publish `~/.local/bin/collie`:

```bash
bin/collie link          # ~/.local/bin/collie → <checkout>/bin/collie
collie status            # from anywhere
bin/collie unlink        # take the name back down
```

It creates a **symlink to the checkout's binary**, so future `collie build` updates take effect
immediately without extra steps
([ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md)). The command replaces existing
links from other Collie checkouts and prints which one it overwrote. It refuses to overwrite
non-Collie files at that path. `unlink` removes the symlink only if it targets *your* current
checkout.

If `~/.local/bin` is missing from your `PATH`, `link` warns you and exits. It never edits your shell
profile. Run `collie doctor` to check the `path-link` line and see which checkout the bare `collie`
command resolves to.

## Herdr actions

**Applies only to a Herdr-managed install** created with `herdr plugin install AltanS/collie` or
`herdr plugin link`. Herdr is one of five multiplexers Collie supports. These actions map directly
to the adapter: each action forwards the verb to the same `collie` binary documented in the table
above. On binary installs created via `scripts/install.sh`, plugin actions do not exist, and
`collie <verb>` is the only syntax.

Collie registers these actions in `herdr-plugin.toml`. Invoke them with
`herdr plugin action invoke <id> --plugin herdr.collie`, or view them with
`herdr plugin action list --plugin herdr.collie`:

| `<id>` | Equivalent verb | What it does |
| --- | --- | --- |
| `start` | `collie start` | Build if needed, start the service, `tailscale serve`, print URL + banner |
| `stop` | `collie stop` | Pause the bridge; removes nothing |
| `restart` | `collie restart` | `stop` + `start` |
| `status` | `collie status` | The *Collie is running* banner (readiness ✓/⚠, version, URLs), then members, devices and agent sessions |
| `url` | `collie url` | Print the tailnet URL |
| `version` | `collie version` | Print the running version (`0.x.y+sha`) |
| `update` | `collie update` | Advance the checkout (pull, or fetch + re-detach) + rebuild + restart |
| `uninstall` | `collie uninstall` | Tear down the service (keeps `.env` + checkout) |
| `push-keys` | `collie push-keys` | Write a VAPID keypair into the `.env` the service reads |
| `push-test` | `collie push-test` | Push one notification to every subscribed device |

`qr`, `pair`, `devices`, `link`, `logs`, `stt`, and `config` have no corresponding plugin action
because they require a terminal, positional arguments, or both. Run them as `collie <verb>`.

**Herdr actions return Herdr's JSON envelope instead of the terminal banner.** View the action's
captured stdout with `herdr plugin log list --plugin herdr.collie`, or run `collie <verb>` directly
to print output inline. Output from `herdr plugin list --json` reflects the version cached during
`plugin link`, not the active version. For linked clones, `update` re-links automatically to fix the
cache. You can force this with `herdr plugin link "$(pwd)"`. Herdr ≥0.8.0 re-reads the manifest from
disk on each invocation.

> **Note.** `scripts/collie-ctl.sh <verb>` remains supported. It operates as a bootstrap shim: it locates
> Bun, compiles `bin/collie` if the checkout lacks it, and passes along argv. A freshly linked clone
> uses this path to build its initial binary. Herdr actions continue to point to this script because
> Herdr <0.8.0 freezes the action definitions cached at install time
> ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)). Each verb is
> implemented once inside the compiled binary in `cli/`.


---

[← back to the README](../README.md)
