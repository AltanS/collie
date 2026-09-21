# Configure

By default, Collie runs in open single-user mode: anyone on your tailnet who can reach the URL has
full control. This triggers the `TRUSTED_USER` warning. Restrict access:

```bash
# in your .env
COLLIE_TRUSTED_USER=you@example.com           # your tailnet login — Collie rejects anyone else
COLLIE_PUBLIC_HOSTS=myhost.tail1234.ts.net    # only behind your OWN proxy; on a tailnet `collie
                                              # start` discovers this for you
```

## The config file

Every Collie setting can be written in a TOML file. Write one with every setting and its default:

```bash
collie config init
```

That writes `~/.collie/config.toml`, the machine's own statement, and prints the path. Every key in
it is commented out, so the file as written changes nothing: uncomment a key and restart. Run
`collie config init --instance` instead to write `config.toml` beside your `.env`, which overrides
the machine's file for this one instance.

| file | layer | how it is located |
| --- | --- | --- |
| `~/.collie/config.toml` | machine | your home directory, or the path in `COLLIE_CONFIG` |
| `<config-dir>/config.toml` | instance | beside the `.env` the CLI already resolves |

The instance file wins key by key, never file by file: a key absent from it keeps the machine file's
value. There is no `config.<instance>.toml`, because on a Herdr-managed install the config dir is
already per instance, and on a binary install it is `~/.config/collie`. A second Collie on one host
therefore puts its own settings in its own config dir, see
[docs/deployment.md → Several Collies on one host](deployment.md#several-collies-on-one-host). A
`.collie/` inside a project directory is not read at all.

Three verbs drive the file:

1. `collie config init` writes a commented file with every setting and its default.
2. `collie config check` validates the two files that would be read, or one file you name.
3. `collie config show` prints both paths and every setting with its value and where it came from.

The precedence runs default, then `~/.collie/config.toml`, then `<config-dir>/config.toml`, then the
process environment, which includes your `.env`. `collie config show` names the winner for every key
at once, so "why is my poll interval still 1500" is answered in one line.

A broken key never stops the bridge. An unknown key or a wrong type is a problem that
`collie config check` prints and `collie doctor` reports, and that key alone falls back to what the
environment says. Every other key in the file still applies.

Collie reads `config.toml` only during startup. Run `collie restart` after modifying it.

> **Note.** A file holding `[push] vapid_private` or `[stt] stt_key` is held to mode 600, exactly as
> your `.env` is. If Collie cannot tighten it, those keys alone are dropped and `collie doctor` says
> so.

## The environment still wins

Collie loads configuration from a `.env` file in `~/.config/collie`. If Herdr manages the
installation, the CLI queries Herdr for the plugin config directory (typically
`~/.config/herdr/plugins/config/herdr.collie`). Both paths resolve consistently across CLI commands,
so the service reads the file seeded here:

```bash
mkdir -p ~/.config/collie && cp .env.example ~/.config/collie/.env

# on a Herdr-managed install, seed Herdr's plugin config dir instead:
cp .env.example "$(herdr plugin config-dir herdr.collie)/.env"
```

Paths below use `~/.config/collie/…`. On a Herdr-managed install, replace that prefix with
`$(herdr plugin config-dir herdr.collie)`.

Collie reads `.env` only during startup. Run `collie restart` after modifying it.

The [`.env.example`](../.env.example) file lists all options, and so does
`collie config init --print`.

It includes `COLLIE_PORT`, `COLLIE_SERVE_MODE=http` (for Headscale or `.internal` domains), and
`COLLIE_SERVE_PORT` (to expose HTTPS on a port other than `:443`; see
[docs/deployment.md → Several Collies on one host](deployment.md#several-collies-on-one-host)). The
CLI reads the serve parameters to configure `tailscale serve`, rather than passing them to the
bridge.

## What each section holds

The config file groups every setting under a `[section]`. The environment name of a key is
`COLLIE_` plus the key in capitals, so `[bridge] poll_ms` is `COLLIE_POLL_MS`.

| section | what it holds |
| --- | --- |
| `bridge` | poll cadence, how many lines are read, where state lives |
| `network` | the port, the bind address, allowed hosts and origins |
| `mux` | which multiplexer this collie mirrors, and where it lives |
| `access` | the Tailscale identity gate, the device header, the audit trail |
| `push` | the three Web Push (VAPID) values |
| `uploads` | the attachment size cap and the extra text types accepted |
| `journal` | where each harness keeps its own session log |
| `crew` | the budgets a lead gives a member, and a peer's own browser |
| `standby` | the deputy's second door: port, bind address, arming |
| `update` | where releases come from, how many versions stay, a GitHub token for the release check |
| `serve` | whether Collie publishes the front door, on what, and under which path (`base_path`) |
| `stt` | speech-to-text, absent until `collie stt setup` runs |

To read history from multiple agent home directories, provide a comma-separated list in
`COLLIE_TRANSCRIPT_ROOT`.

[`docs/deployment.md`](deployment.md) covers custom domains and reverse proxies. Collie enforces a
same-origin policy, so any custom hostname or external TLS terminator must be explicitly
allowlisted:

```bash
COLLIE_ALLOWED_ORIGINS=https://collie.example.com
```

Without this setting, the UI will load as an empty page. See
[Troubleshooting](troubleshooting.md#troubleshooting) for details.

## Your own slash commands

Put machine-specific commands, such as a Herdr plugin `/fork-in-herdr` or a custom `/deploy`, in
`commands.toml`. This is one of six config files that share the same reader and load pattern:

| file | scope | confirm/danger flag | live reload |
| --- | --- | --- | --- |
| `commands.toml` | optional, per row | `confirm = true` | yes, no restart needed |
| `keys.toml` | optional, per row | `danger = true` | yes, no restart needed |
| `quick-replies.toml` | optional, per row | none | yes, no restart needed |
| `theme.toml` | none, the faces are a device setting | none | yes, on the next page reload |
| `launchers.toml` | none, matched by exact command instead | none | yes, but an already-open tab re-reads the rows only on its next load |
| `cache-rules.toml` | none, matched by exact rule id instead | none | yes, no restart needed |

These files are unchanged by the config file. They share the instance `config.toml`'s
directory, they keep their own formats and their own live reload, and nothing merges them into it.

Any row with the flag set requires a two-tap confirmation before it fires. Edits to any of these
files take effect without restarting the service. If Collie rejects a row, `journalctl --user -u
collie -n 20` prints the line number and the error.

```bash
cp commands.toml.example ~/.config/collie/commands.toml
```

```toml
[[commands]]
scope = "omp"                # optional; omit for every pane
command = "/fork-in-herdr"
description = "Fork this conversation into a new herdr tab"

[[commands]]
scope = "claude"
command = "/statusline"
description = "Set the status line"
bar = true
bar_label = "Status"
```

A pane that matches your configured rows displays only those rows. The narrowest row wins, as
documented in [ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md).

To verify, open a pane and tap **/**; your rows appear on the first screen.

### Putting a command on the actions row

`bar = true` also puts the row on the actions row, the one row of buttons above the keyboard. A bar
row is still an ordinary palette row, so it appears on both surfaces. `bar_label` is the button's
text and defaults to the command name without its slash.

The actions row is a belt, one full-bleed band above the keyboard. Collie's own controls sit
directly on the band: Keys, Type, Quick, Agent and the display gear. The running harness's own
commands sit beside them, in a section tinted with the harness's brand colour, so you can see at a
glance which buttons type into the agent. A sideways drag scrolls the belt; nothing is dropped.

Each harness ships its own buttons, in this order:

| Harness | Buttons |
| --- | --- |
| Claude Code | Model, Effort, Compact, Resume |
| Codex | Model, Compact, Resume |
| pi | Model, Compact, Tree, Resume |
| omp | Model, Compact, Tree, Resume |

Codex and pi have no Effort button. Codex's `/model` picker sets the model and the reasoning effort
on one screen, so one button already reaches both. pi has no effort or thinking command at all;
that dial lives inside `/settings`, a modal the keys pad cannot usefully drive.

omp's Tree button sits between Compact and Resume. It opens omp's own session tree in the mirror, a
picker that jumps to any earlier point in the session. The same command, `/tree`, is also in omp's
command palette.

Every harness button sends its command bare. **Model sends `/model`, and the agent's own model
picker takes over in the pane.** Collie keeps no list of model names, because that list is the
harness's and it changes without telling us. Effort works the same way.

Your bar rows replace the shipped harness segment for the panes they address, and leave it alone
everywhere else. The Agent palette is a separate surface and one bar row never blanks it
([ADR 0043](../.adr/0043-operator-bar-rows-replace-the-bar-not-the-palette.md)).

A `bar_label` longer than 12 characters is shortened and the button still appears. A `bar` that is
not `true` or `false` drops that one row, the same way a bad `confirm` does.

The row sends while the agent is busy, the same as the command palette. The checkmark appears only
when the pane took the text.

A Switch button sits at the belt's right end and opens the pane switcher. It draws the layers mark
alone, behind a hairline, and carries no word. A drag up, anywhere on the belt, opens the same
switcher. A sideways drag scrolls the belt instead.

To verify, open a pane running Claude Code, Codex, pi or omp; the tinted segment sits at the right
of the row above the keyboard. Turn that segment off per device in **Settings → Harness shortcuts**;
Collie's own controls stay.

## Your own key presets

You can replace the Keys tray's **Presets** row in `keys.toml`, located next to `commands.toml`:

```bash
cp keys.toml.example ~/.config/collie/keys.toml
```

```toml
[[keys]]
scope = "claude"             # optional; omit for every pane
label = "Yes"
keys = ["Down", "Enter"]     # several chords go out as one batch
```

When a pane matches your defined rows, it displays only your presets instead of the default Ctrl
C/D/U/R/L/Z buttons ([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). The
rest of the tray (Esc, arrow keys, Enter/Tab/Space, modifiers, digits, F1–F12) is fixed.

Chords use herdr's syntax, not tmux's:

| key | chord | supported? |
| --- | --- | --- |
| Ctrl+C | `ctrl+c` (not `C-c`) | yes |
| Shift+Tab | `shift+tab` | yes |
| Ctrl+F7 | `ctrl+F7` | yes |
| Page Up | — | no |
| Home | — | no |
| End | — | no |
| Delete | — | no |

To verify, open a pane and tap **Keys → Presets** to view the new buttons. If Collie rejects a row,
check `journalctl --user -u collie -n 20` for the error details.

## Your own quick replies

You can customize the Quick dock phrases in `quick-replies.toml`:

```bash
cp quick-replies.toml.example ~/.config/collie/quick-replies.toml
```

```toml
[[replies]]
scope = "claude"             # optional; omit for every pane
title = "confirm"
items = ["yes", "no"]        # sent verbatim, one per button
```

When a pane matches your rules, your groups replace the default ones
([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). The default phrases are
English (`yes`, `commit and push`).

Use this file to run in other languages, or to send words like `approve` to specific harnesses.
Setting `scope = "shell"` targets standard shell panes, which otherwise only receive `y`/`n`.

To verify, open a pane and tap **Quick** to see your groups. If a row fails to load,
`journalctl --user -u collie -n 20` prints the error.

## Your own launchers

One tap runs a command you declared, in `launchers.toml` next to `keys.toml`:

```bash
cp launchers.toml.example ~/.config/collie/launchers.toml
```

```toml
[[launchers]]
command = "htop"             # required; the shell line, typed verbatim into the fresh shell
label = "Top"                # optional; defaults to the first word of command
# cwd = "~/dev/collie"       # optional; absent means "here" — see below
```

Where the tap opens depends on where you tap it, not on the row. From the **dashboard**, a tap
creates a new Space named after the row. From a **pane** — the switcher sheet you reach by
swiping up — a tap opens a new **tab in that pane's own Space**, beside it.

Either way the bridge types the `command` into the fresh shell and sends Enter. The command owns
its own lifetime: one that closes itself takes the Space or tab with it, and `htop` stays until you
quit it.

`cwd` is where that new Space or tab opens. Pin one (as `htop` does above) and it wins wherever you
tap the row.

Leave it out and it means "here": the dashboard opens it in your home dir, a pane opens it in
*that pane's own* cwd — one cwd-less row follows you around your checkouts instead of always
landing at the top of one.

This file is the allowlist. `POST /api/launch` accepts only a `command` that matches a row here
exactly, so a phone can start nothing that is not in the file. Changes apply immediately without a
restart, but an already-open tab re-reads the rows only on its next load.

Your rows appear in two places: a **Launch** section on the dashboard, which folds like Spaces,
and a **Launch** section in the switcher sheet (swipe up from a pane). A pinned row shows
its folder, shortened under home; a cwd-less row says "here" in the switcher (the dashboard already
implies home, so it says nothing there). Declare no rows and neither section appears.

On a crew (several machines, one phone-facing lead), each machine reads its own copy of this file —
a row launches on whichever machine's dashboard or pane you tapped it from, not on the lead.

To verify, reload the dashboard and look under the herd. If a row fails to load,
`journalctl --user -u collie -n 20` prints the error.

## Your own typefaces

The interface font is a per-device setting. Under **Settings → Typeface**, you can choose between
System, Space Grotesk (the default), and Aldrich. You can add custom fonts in `theme.toml`, the
fourth configuration file:

```bash
cp theme.toml.example ~/.config/collie/theme.toml
mkdir -p ~/.config/collie/fonts
cp departure.woff2 ~/.config/collie/fonts/
```

```toml
[[font]]
family = "Departure Mono"    # the picker's label AND the CSS family
file   = "departure.woff2"   # a bare name inside fonts/, woff2 only
weight = "400 700"           # optional
```

Custom fonts append to the built-in list rather than replacing it
([ADR 0033](../.adr/0033-the-app-face-is-a-device-preference.md)), unlike the behavior in
`commands.toml` and the other configuration files. Because fonts do not trigger actions, there is
nothing to shadow.

They appear below the three default entries, and each client device selects its own.

Three behaviors to note:

- **Layout shift on first load.** Custom fonts lack metric-matched fallbacks, which causes a minor
  layout shift during initial load. Built-in fonts avoid this because their fallbacks are generated
  at build time.
- **Cold-load delay.** A cold load fetches the file with a brief delay; a cached client paints
  immediately.
- **Chrome only.** The selected font applies only to Collie's chrome. The terminal mirror,
  transcript, and rendered markdown retain their own typography.
- **Live on next reload.** Changes do not require a restart, taking effect on the next page reload.
  Invalid configurations log errors visible via `journalctl --user -u collie -n 20`.

## Your own cache rules

Use `cache-rules.toml` to change a prompt-cache lifetime that your provider changed.

```bash
cp cache-rules.toml.example ~/.config/collie/cache-rules.toml
```

Collie ships one rule per harness and provider. Collie read each rule from a vendor page on a
recorded date. A vendor can change that value without notice. A gateway, a proxy that sits between
your agent and the vendor, can change it too. Use this file to override values until Collie ships an
update.

```toml
[[rule]]
id = "claude.api"
ttl_seconds = 3600
source_url = "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
retrieved = "2026-09-12"
note = "our gateway sends ttl 1h on every request"
```

Collie keeps a row only when all four rules hold. `id` must name a shipped rule. `ttl_seconds` must
be an integer from 1 to 86400. `source_url` must be a non-empty string. `retrieved` must parse as a
valid `YYYY-MM-DD` date, and it must not be later than today. Invalid rows are dropped and logged.
The rest of the file still applies.

Two more rules decide what a file means. Two rows with the same `id` are not an error: the later row
wins. A `note` you write as an empty string drops the whole row, so leave the field out instead.

A row binds at the tier rule, the one its `id` names. The per-model split under that tier moves with
it, so one row covers every model on that tier.

> **Note.** You may change a number. You may not remove its source page or retrieval date. The rule
> catalog requires both fields.

`collie doctor` checks three items. `cache-claims` warns when nobody has re-checked a shipped rule in
180 days. `cache-rules` names every dropped row and the reason it was dropped. `cache-env` flags when
you set `ENABLE_PROMPT_CACHING_1H` or `FORCE_PROMPT_CACHING_5M` in your shell. The bridge runs as a
separate service and cannot read your agent's environment. Mirror these Claude Code variables here so
the bridge can read them.

These are the rule ids you may write.

| rule id | what it covers |
| --- | --- |
| `claude.subscription` | Claude Code on a Claude subscription, Pro or Max |
| `claude.api` | Claude Code on an API key or a third-party provider |
| `codex.subscription` | Codex CLI signed in with a ChatGPT plan |
| `codex.api` | Codex CLI on an OpenAI API key |
| `pi.anthropic`, `opencode.anthropic` | pi or opencode talking to Anthropic |
| `pi.openai`, `opencode.openai` | pi or opencode talking to OpenAI |
| `pi.google`, `opencode.google` | pi or opencode talking to Google |
| `pi.unknown`, `opencode.unknown` | pi or opencode on an upstream that documents no TTL |

## The prompt-cache countdown

A chip on each agent pane shows how long that agent's prompt cache stays warm.

Every supported harness caches the current conversation. Harnesses charge lower rates while that
cache stays warm. The chip counts down idle time since the agent's last request. It does not track
total session age. Each new request resets the timer.

The chip's hourglass carries the state in one of three colours, and the number beside it stays grey.
The hourglass is green while the window is wide, red during the final quarter of it, and blue once
the window expires or a turn pays the full rate. The chip says `cold` in the blue state, and `<1m`
instead of seconds when under one minute remains.

Some actions drop the cache while time is still left: a `/model` switch to another model, an effort
change, a compaction, and `/reload-plugins --force`. The chip turns blue as soon as Claude Code writes
the action to its transcript, and the sheet names the action. opencode reports a compaction and a
model change the same way.

The chip sits at the right end of the pane header's second line, after the pane's workspace. On a
crew the machine's name sits beside it, on the same line. Tap the chip to view the underlying rule:
the rule id, the vendor source page, and the retrieval date.

> **Note.** Values are vendor claims with recorded dates, not live measurements, unless marked
> **measured**. Claude Code writes cache windows directly to its transcript, so Claude panes are
> usually measured.

Some panes show no chip. This is expected. A pane shows a chip only after its agent completes one
turn. Collie makes no assumptions before measurement. A pane shows nothing if its harness lacks a
journal adapter, or if its vendor publishes no lifetime data.

Collie can also send push alerts to a phone before a cache expires. One variable controls the timing.

| var | default | meaning |
| --- | --- | --- |
| `COLLIE_CACHE_WARN_SECONDS` | `300` | how many seconds before a watched pane's cache expires the push goes out; floor 30, ceiling 3600 |

This setting controls only the push alert. It does **not** control when the chip turns red. The
red threshold is fixed at one-quarter of each rule's TTL. The push itself fires at whichever is
shorter, this setting or half the pane's own cache lifetime, so a five-minute cache (Codex,
OpenCode, pi, omp) warns about two and a half minutes before it goes cold, even though that is
less than the configured 300 seconds. To enable warnings for specific panes or all panes, see
[voice-and-push.md](voice-and-push.md#which-alerts-collie-sends).

## Attachments

The paperclip beside the message box uploads a file to the host and puts its path in your message.

```bash
# in your .env
COLLIE_MAX_UPLOAD_MB=25              # default 10, floor 1, ceiling 512
COLLIE_UPLOAD_EXTRA_TYPES=rb,ex,zig  # bare extensions, no dot
```

Collie saves the file under `<state-dir>/uploads` with owner-only permissions and appends its
absolute path to your draft. The agent reads it from that path, because a terminal cannot take a
pasted file. Uploads are swept 48 hours after they are written.

| Setting | Default | What it does |
| --- | --- | --- |
| `COLLIE_MAX_UPLOAD_MB` | `10` | Largest file accepted, in whole megabytes. Out of range or not a whole number falls back to the default and logs a warning. |
| `COLLIE_UPLOAD_EXTRA_TYPES` | *(empty)* | Extra text types to accept, beyond the list below. Comma-separated bare extensions; a leading dot is forgiven and anything that is not letters and digits is dropped with a warning. |

Two kinds of file are accepted, and they are checked differently.

**Images** are identified by their signature bytes, never by their name or their declared type:
`png`, `jpg`, `gif` and `webp`. SVG is refused on purpose, because it is script-bearing markup
rather than a picture.

**Text** is identified by its extension, with the bytes as a veto: a file whose first 4 KB contain a
NUL or a stray control byte is refused whatever it is called. The shipped list is `md`, `markdown`,
`txt`, `json`, `jsonl`, `yaml`, `yml`, `toml`, `csv`, `tsv`, `log`, `xml`, `html`, `htm`, `css`,
`js`, `jsx`, `mjs`, `cjs`, `ts`, `tsx`, `py`, `go`, `rs`, `sh`, `bash`, `sql`, `diff` and `patch`.

> **Note.** `COLLIE_UPLOAD_EXTRA_TYPES` adds text types only. An image needs a signature to check it
> against, so there is no binary format you can add this way.

Raising `COLLIE_MAX_UPLOAD_MB` raises two other numbers with it. The bridge reads a whole upload into
memory before it can measure it, so a large cap plus several uploads at once is that much memory. And
the runtime's body limit applies to every route, not only the upload one, so a large cap lets a large
body reach any handler, where that handler's own limit then refuses it. Nothing is deleted before its
48 hours are up, so the uploads directory holds at most what was sent in two days. Raise the number
because you need it, not by default.

In a [crew](crew.md), both settings are per machine, and the machine that stores the file is the one
that enforces them. The lead refuses an oversize body before forwarding it, to save your uplink, but
it refuses it against its own number. Set the same values on every member, or a peer will refuse
what its lead let through.

## Multi-session

By default, one Collie instance serves every Herdr session it finds.

`COLLIE_MULTI_SESSION=on` (the default) discovers and serves every named Herdr session under your
config root, switchable from the header. Setting `COLLIE_MULTI_SESSION=off` serves only the primary
session. Every discovered session is accessible through the same URL, including private or sandbox
sessions. [Security](security.md) lists this behavior as a sharp edge.

## Dark mode / light mode

> **Note.** Collie follows your phone's appearance by default.

To pin it, open **Settings → Appearance** and pick **System**, **Light** or **Dark**. The setting is
stored **per device** in the browser rather than on the bridge. Your phone can remain on Dark while
a laptop tracks the OS. The preference persists across reloads and PWA reinstalls on the same
device.

### The terminal mirror is deliberately different

The mirror always renders on a **dark ground**. Light mode inverts the entire element instead of
re-colouring individual spans.

Agents emit absolute 24-bit colour codes (`38;2;r;g;b`) tuned for dark backgrounds, which downstream
parsers cannot reliably remap. Rendered directly onto white, most agent output drops below a 3:1
contrast ratio. Inversion preserves the intended contrast. The measurements are documented in
[ADR 0002](../.adr/0002-invert-the-light-terminal-mirror.md).

This implementation has two practical consequences:

- **Keep your agents configured for dark themes.** This is the default for Claude Code, codex,
  opencode and pi. If an agent uses a *light* theme, it emits dark-on-light values that become
  illegible in Collie under both modes. This stems from the agent output rather than Collie itself.
- **Diffs and highlighted rows render as dark blocks** in light mode. Contrast remains intact, but
  the visual weight is reversed.

> **Note.** Installed on iOS, in light mode, the status-bar text remains white and can blend into
> the background. iOS does not allow web apps to update this value dynamically. Run Collie directly
> in the browser instead of as an installed PWA to avoid this limitation.

## Zen mode

> **Note.** Zen mode is off by default.

Enable it in **Settings → Zen mode** (stored per device in the browser). This adds a **Zen mode**
option to the pane menu, under the ⋮ beside Find and History. Tapping it hides all Collie UI
elements: the header, tab and pane strips, agent statusline, and composer docks. Only the terminal
mirror remains visible. A floating button in the top-right corner or the Escape key restores the
interface.

Zen mode is **transient**. The configuration persists, but the active state resets when you switch
panes or reload the page. Panes always open with standard chrome.

The terminal mirror continues polling in Zen mode, and interactive buffer elements remain
functional. Prompt buttons, "Load older", and "Show entire history" controls stay available because
they are part of the content stream rather than chrome.

## Language

Collie's interface is available in six languages. Configure this under **Settings → Language**.

- English
- Deutsch
- Español
- 한국어
- 日本語
- 中文

The selection is saved locally in the browser per device. The terminal mirror remains untranslated:
it displays the raw output from the agent, while quick replies, menu labels, and key caps match the
underlying screen or keyboard names.


---

[← back to the README](../README.md)
