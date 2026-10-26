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
| **Status** | `collie status` | The *Collie is running* banner + URLs |
| **URL** | `collie url` | Print the tailnet URL |
| **QR** | `collie qr` | The same URL as a scannable code |
| **Version** | `collie version` | The running version (`0.x.y+sha`) |
| **Skill** | `collie skill` | The agent-facing brief on Collie, for an AI coding agent working in your terminal (also `collie --skill`). `collie skill install`, `uninstall`, `sync`, `status` and `print` manage the walky talky skill in your agents' instruction files; `collie update` runs `sync` after each update ([Install the skill](walky-talky.md#install-the-skill)) |
| **Docs** | `collie docs` · `collie docs <name>` · `collie docs --all` | These pages, printed out of the binary itself |
| **Update** | `collie update` | Stage the newest release of your major, flip to it, restart and verify (`--check` preflights, `--status` reports, `--major` crosses one) |
| **Rollback** | `collie update --rollback` | Put the previous version back (not on a Herdr-managed checkout, which has none staged) |
| **Uninstall** | `collie uninstall` | Remove the service; keep `.env` and the install |
| **Pair** | `collie pair` · `collie pair --expires <duration>` | Print an 8-character code and a QR code, good for 10 minutes; scan the QR code to open Settings → System → Paired devices with the code filled in, or enter the code manually to get it [paired](security.md#pair-a-device--the-write-credential). Without `--expires` the token never expires and the command says so; with it (`12h`, `30d`, `2w`) the command prints the date the token stops working once claimed. A script claims the code with a label of its own, for example `script`, and pairs once ([Give a device an expiry](security.md#give-a-device-an-expiry)) |
| **Devices** | `collie devices list` · `collie devices revoke <label>` · `collie devices set-expiry <label> <duration>` · `collie devices clear-expiry <label>` | List / revoke paired devices, or change when one [expires](security.md#give-a-device-an-expiry). `list` shows each device's expiry as `no expiry`, `expires <date>` or `EXPIRED <date>`. `set-expiry` counts a new lifetime from now; `clear-expiry` removes it. A label matches exactly, or without case when only one device fits |
| **Link** | `collie link` · `collie unlink` | Put `collie` on your PATH ([below](#put-collie-on-your-path)) |
| **Logs** | `collie logs` | Tail the service log |
| **Config** | `collie config show` · `collie config check` · `collie config init` | Print every setting with its source, validate the file, or write a commented `config.toml` ([the config file](configure.md#the-config-file)) |
| **Durable agents** | `collie durable attach <name> --socket <path>` · `collie durable attach <name> --url <url> --token-env <VAR>` · `collie durable detach <name>` · `collie durable list` | Add a durable agent to `sources.json`, remove it, or list each durable agent with the state the running bridge gives it. `attach` and `detach` apply at the next restart, or at once with `--restart`. Flags, output and exit codes: [Durable agents](durable-agents.md#the-three-verbs) |
| **Walky talky** | `collie walky who` · `collie walky send <address> <text>` · `collie walky reply <id> <text>` · `collie walky inbox` · `collie walky status <id>` | Message an agent session from a terminal, or from one agent to another ([Walky talky](walky-talky.md)) |
| **Voice** | `collie stt setup` · `stt test` · `stt status` · `stt off` | Configure / check / disable [voice input](voice-and-push.md#voice-input-optional) |
| **Push keys** | `collie push-keys` | Generate the VAPID keypair into your `.env` |
| **Push test** | `collie push-test` | Send one notification to prove it works |

The CLI also includes `build`, `serve`, `unserve`, `doctor`, and `crew …` for less frequent tasks.

Both `start` and `status` output the **Collie is running** banner: a health mark and the version,
then a `service`, a `local` and a `tailnet` line.
[First run](install.md#first-run-what-youll-see) shows it in full, including what a failed health
check prints instead. The reported version reads from the served bundle stamp, reflecting the active
build.

**Ink or plain text.** The `start`, `status`, `doctor`, `crew add`, and `crew status` commands
render an interactive terminal UI when stdout is a TTY. Passing `--plain`, or redirecting output to
a pipe, file, systemd journal, or CI runner, falls back to raw line output.

**`collie doctor` says which state it read.** Its first line names the instance (`default`, or the
name in `COLLIE_INSTANCE`) and the state directory it reads. If you run two lanes on one machine,
check that line before you trust the rest, because a shell with the wrong `COLLIE_INSTANCE` reads
the wrong lane. `--json` gives the same two values as `instance` and `stateDir` on the `collie`
entry.

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
| `status` | `collie status` | The *Collie is running* banner — readiness ✓/⚠, version, URLs |
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
