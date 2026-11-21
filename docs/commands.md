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
| **Skill** | `collie skill` | The agent-facing brief on Collie, for an AI coding agent working in your terminal (also `collie --skill`). `collie skill install`, `uninstall`, `sync`, `status` and `print` manage the WalkyTalky skill in your agents' skills folders; `collie update` runs `sync` after each update ([Install the skill](walky-talky.md#install-the-skill)) |
| **Docs** | `collie docs` · `collie docs <name>` · `collie docs --all` | These pages, printed out of the binary itself |
| **Update** | `collie update` | Stage the newest release of your major, flip to it, restart and verify (`--check` preflights, `--status` reports, `--major` crosses one) |
| **Rollback** | `collie update --rollback` | Put the previous version back (not on a Herdr-managed checkout, which has none staged) |
| **Uninstall** | `collie uninstall` | Remove the service; keep `.env` and the install |
| **Pair** | `collie pair` · `collie pair --expires <duration>` | Print an 8-character code and a QR code, good for 10 minutes; scan the QR code to open Settings → Devices and machines → Paired devices with the code filled in, or enter the code manually to get it [paired](security.md#pair-a-device--the-write-credential). Without `--expires` the token never expires and the command says so; with it (`12h`, `30d`, `2w`) the command prints the date the token stops working once claimed. A script claims the code with a label of its own, for example `script`, and pairs once ([Give a device an expiry](security.md#give-a-device-an-expiry)). `--json` prints the code as one line of JSON for a program that shows it in its own window: `code`, `expiresAt`, `tokenLifetimeMs`, `replaced`, `url`, and `qr`, the code's modules as rows of `1` (dark) and `0` (light) |
| **Devices** | `collie devices list` · `collie devices revoke <label>` · `collie devices set-expiry <label> <duration>` · `collie devices clear-expiry <label>` | List / revoke paired devices, or change when one [expires](security.md#give-a-device-an-expiry). `list` shows each device's expiry as `no expiry`, `expires <date>` or `EXPIRED <date>`. `set-expiry` counts a new lifetime from now; `clear-expiry` removes it. A label matches exactly, or without case when only one device fits |
| **Link** | `collie link` · `collie unlink` | Put `collie` on your PATH ([below](#put-collie-on-your-path)) |
| **Harness** | `collie harness link claude` · `collie harness unlink claude` · `collie harness status` · `collie harness sync` | Experimental, Collie 1.29.0 or later: let Collie send plain messages to Claude Code as data instead of typing them ([Send by data](claude-code-on-your-phone.md#send-by-data-optional-experimental)) |
| **Logs** | `collie logs` | Tail the service log |
| **Config** | `collie config show` · `collie config check` · `collie config init` | Print every setting with its source, validate the file, or write a commented `config.toml` ([the config file](configure.md#the-config-file)) |
| **Durable agents** | `collie durable attach <name> --socket <path>` · `collie durable attach <name> --url <url> --token-env <VAR>` · `collie durable detach <name>` · `collie durable list` | Add a durable agent to `sources.json`, remove it, or list each durable agent with the state the running bridge gives it. `attach` and `detach` apply at the next restart, or at once with `--restart`. Flags, output and exit codes: [Durable agents](durable-agents.md#the-three-verbs) |
| **Multiplexers** | `collie mux list` · `collie mux list --json` | Every multiplexer this build can drive, which of them this machine has, which Collie instance drives each, and the command that starts one nobody drives ([which multiplexers this machine has](multiplexers.md#which-multiplexers-this-machine-has)) |
| **WalkyTalky** | `collie walky who` · `collie walky send <address> <text>` · `collie walky reply <id> <text>` · `collie walky inbox` · `collie walky status <id>` · `collie walky off` · `collie walky on` | Message an agent session from a terminal, or from one agent to another ([WalkyTalky](walky-talky.md)) |
| **Hill** | `collie hill post --title <t> --summary <s> --option <intent>=<label> [--image <path>[=<caption>]] ...` · `collie hill status <id>` · `collie hill withdraw <id>` · `collie hill list` · `collie hill clear` · `collie hill on\|off` | An agent puts one decision on the hill for you to answer, then follows it up. Up to four images (PNG, JPEG or WebP, 2 MB each) ride along by path; the bridge reads each file itself. The answer comes back as a WalkyTalky message. `collie hill post --help` prints every flag and the rules (M96). `collie hill off` switches the Hill off on this Collie, the same switch as Settings → Tricks and the Hill → The Hill; `on` switches it back. On a crew member the post goes to the lead's Hill; exit 5 means the lead did not answer, and the same `--request-id` posts once; `collie hill clear` removes every closed decision and prints how many went, open ones stay, and the Answered group on the Hill page has the same Clear button with a second tap to confirm ([The Hill](hill.md), [Decisions from any machine](crew.md#decisions-from-any-machine)) |
| **Local API** | `collie api` · `collie api <operation>` | Experimental: the local, read-only API a trick reads with `t.api`. It answers a trick's own run in this release, so `collie api <operation>` prints one line and reads nothing. `collie api` alone lists the operations and their flags ([The local API](#the-local-api-experimental)) |
| **Tricks** | `collie trick list` · `collie trick add [<name> \| <https-url>[//<folder>][#<ref>]]` · `collie trick update <id>` · `collie trick remove <id>` · `collie trick on <id>` · `collie trick off <id>` · `collie trick auto <id> on\|off` · `collie trick init [--sh] [--dir <folder>] <id>` · `collie trick dev <folder\|id>` · `collie trick check [--run] [--json] <folder>` · `collie trick helper <id\|folder>` · `collie trick skill [<id>]` | Add a trick from a git repository, switch it on or off, and write one. A trick is a small program that adds parts to Collie. `add` with no source lists the official repository and adds nothing, and a trick stays off until `on`, which is your yes to its code and refuses in an agent's pane. `dev` runs a trick once and prints what the phone would draw, and `check` lists what its code does ([Tricks](tricks.md), [Write a trick](tricks-authoring.md)) |
| **Theme check** | `collie theme check <file>...` · `collie theme check --json <file>...` | Check theme files with the app's own parser before you share them: one line per refusal and per contrast warning, the words Settings shows. Exits 0 when every file passes, 1 when one is refused, 2 on a usage error. `--shipped` accepts the id of a shipped theme. Reads only the files you name ([Check a theme before you share it](themes.md#check-a-theme-before-you-share-it)) |
| **Theme brief** | `collie theme skill` · `collie theme --skill` | Print the brief for an AI agent that writes a theme: the steps, with `collie theme check`, and the sections of [Themes](themes.md) that list every key and word a theme file may use |
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
`members` (a list of `{ name, role, link, version, mux, panes, host }`, empty without a crew), `devices`
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
A send you discarded or cancelled, or one still held, does not count. When the window holds receipts from more than one Collie version, the row adds the counts per version, newest first, and a receipt from a Collie that did not record its version reads `older`. The row warns when 3 or more
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

`collie crew status --json` prints one line. With a crew it holds `crew` (an object with `id` and
`name`), `mode`, `self` and `members`. Without a crew it holds only `mode` and `members`, as in
`{"mode":"solo","members":[]}`. Each member has
`id`, `role`, `address`, `link`, `version`, `mux`, `panes` and `host`. `link` is `reachable`,
`unreachable`, `incompatible`, `unenrolled`, or `not-probed` under `--no-probe`. The list of what
`tailscale serve` publishes left `collie status` in 1.25.0. Run `collie serve status` for it, or
`collie status --verbose`.

## The local API (experimental)

A trick's run can list your agent sessions, read a screen and follow events, over a Unix socket, while tricks are switched on.

```
collie api
```

`collie api` alone lists the operations and their flags. In this release the local API answers a
trick's own run and nothing else. Run by hand, `collie api <operation>` reads nothing, prints this
one line and exits 3:

```
The local API answers a trick's own run in this release. A trick reads it with t.api.
```

A trick reads it with `t.api`, at the `access` it declares
([Reading Collie through the local API](tricks-reference.md#reading-collie-through-the-local-api)).
A reader for your own scripts comes later, with a key you make on purpose.

| Operation | Flags | Trick level | What it answers |
| --- | --- | --- | --- |
| `hello` | `--token` | `see` | The first request on every connection, with the run's token. The API version, the Collie version, `experimental: true` and the operations offered at the token's level |
| `sessions` | none | `see` | One row per agent session of this machine: `id`, `machine`, `agent`, `label`, `folder` (the folder name, never the path), `state`, `account` (a label) and `rev` |
| `brief` | `--session` | `see` | One session's `state`, whether an ask is open, when its last turn ended and whether a draft is in its input box. No text |
| `read` | `--session`, `--lines` | `read` | One session's screen as plain text, secrets masked and the length capped, with `truncated` |
| `accounts` | none | `see` | Each agent account's `id`, `agent`, `label`, `kind`, `signedIn` and `running`. No email, plan or path |
| `hill.list` | none | `see` | The open decisions on the Hill: `id`, `machine`, `sender`, `title`, `urgency` and `date`. No body |
| `machines` | none | `see` | One row per machine of the Machines page, the lead first: `id`, `label` (a short name, never a full host name or an address), `reachable`, `version` and `load` (`cpu`, `memory`, `sessions`). No address, key or path |
| `events` | `--after`, `--wait` | `see` | Up to 256 events after a cursor, and `next`, the cursor to ask from next. `--wait` holds the request for up to 25 seconds when there is no event |

> **Experimental.** The names, the fields and the exit codes of the local API may change in a
> later minor release. Treat the output as something to read today, not as a contract.

**It is on while tricks are switched on.** The local API is on while tricks are switched on, on a
machine where tricks run (not on a crew member that only follows its lead). When tricks go off,
the bridge removes the socket and ends every open wait. Windows has no such socket.

**It answers a trick's own run.** When Collie starts a run of a trick that declares `access`, it
makes a random token for that run and puts it in the run's facts, beside the socket's path. Every
connection opens with `hello` and that token, within 2 seconds. With no token, an unknown one, a
dead one or no `hello` in time, the socket answers one error, `api.no_run_token`, and closes. The token dies when the run ends, when the
trick or tricks are switched off, and when the bridge stops. It is never in the environment, on a
command line, on disk or in a log line. The level the trick declares is the token's level, and the
bridge checks it: a `see` token is refused `read` with `api.denied`.

**What it is, in honest words.** The token keeps a program that only finds the socket out of this
socket, and that is all it does. A program that runs as you can still read your sessions in other
ways. It can read a pane through the multiplexer itself. It can read another program's memory, a
trick's token included.

It can also read Collie's local secret, the file `local-secret` in the Collie state directory. With
that secret it reaches only five reads on the bridge's loopback address, and none of them returns a
screen or a message. Collie does not stop the other ways. The socket is `api/sock` in
the Collie state directory, mode 0600 inside a folder of mode 0700. It is closed to other users, to
other machines and to pages in a browser, because it is a Unix socket and not a web address.

**It only reads.** It cannot type, answer an ask or change anything. Apart from `read`, which
returns the screen, an answer holds names and states and never a message or a decision's body.
One field holds text an agent wrote: the `title` of a card in `hill.list`, cut to 120 characters.
`read` masks secrets in the screen text, and the mask is best effort. It finds the secret shapes
Collie knows, and a secret in another shape passes through.

**Events are at least once.** Each machine has its own events, and there is no order across
sessions. A program that resumes from an older cursor gets some events again, so it must be safe
against a repeat: key on the event `id`. An event carries ids and states only, never text. The
types are `session.status` (with `data.state`), `turn.end` and `ask.open`.

Leave out `--after` to start at now. The bridge keeps the last 2048 events, up to one hour old, and
two markers say when a program has missed some:

- `gap` means the cursor is older than the events kept. Events were lost between them, so read
  the state again with `sessions`.
- `reset` means the cursor is from before the bridge last started, or is not a cursor. The
  sessions may have moved, so read the state again with `sessions`.

Either marker is followed by every event kept. One answer holds at most 256 events, so ask again
from `next` until it holds fewer.

**Session ids are opaque.** Copy an id from `sessions`, and never build one from a pane id. An
id that names a session that has ended is refused with `api.session_unknown`. An id whose pane now
holds another session is refused with `api.session_replaced`, once Collie has seen the pane gone.
A multiplexer can reuse a pane id inside about 30 seconds, and until then the old id can still
answer for the new session.

The limits keep one program from crowding out the phone:

| Limit | Value |
| --- | --- |
| Open `events` waits | 4 per connection, 16 in all |
| Requests in flight on one connection | 8 |
| Screen reads at once | 4, then `api.busy` with a retry hint |
| Connections open | 32 |
| One answer | 1 MiB; a larger one is `api.answer_too_large` |

`collie api` exits with these codes:

| Code | Meaning |
| --- | --- |
| 0 | `collie api` alone, or with `--help`: the list of operations |
| 2 | The operation is not one of the list. Nothing was read |
| 3 | Any operation of the list: the one line. Nothing was read |

[ADR 0152](../.adr/0152-one-event-bus-and-a-local-read-only-api-that-exists-where-a-trick-runs.md)
and [ADR 0155](../.adr/0155-the-local-api-answers-a-run-token.md) hold the reasons. A trick reacts to the same events with `on` ([Tricks](tricks.md)).

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

`link` and `unlink` take no word after them, and refuse one. To link a harness for sending by
data, use `collie harness link claude`
([Send by data](claude-code-on-your-phone.md#send-by-data-optional-experimental)).

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
> ([ADR 0143](../.adr/0143-how-an-install-updates-and-what-a-release-offers-it.md)). Each verb is
> implemented once inside the compiled binary in `cli/`.


---

[← back to the README](../README.md)
