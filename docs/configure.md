# Configure

By default, Collie runs in open single-user mode: anyone on your tailnet who can reach the URL has
full control. This triggers the `TRUSTED_USER` warning. Restrict access:

```bash
# in your .env
COLLIE_TRUSTED_USER=you@example.com           # your tailnet login — Collie rejects anyone else
COLLIE_PUBLIC_HOSTS=myhost.tail1234.ts.net    # only behind your OWN proxy; on a tailnet `collie
                                              # start` discovers this for you
```

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

The [`.env.example`](../.env.example) file lists all options.

It includes `COLLIE_PORT`, `COLLIE_SERVE_MODE=http` (for Headscale or `.internal` domains), and
`COLLIE_SERVE_PORT` (to expose HTTPS on a port other than `:443`; see
[docs/deployment.md → Several Collies on one host](deployment.md#several-collies-on-one-host)). The
CLI reads the serve parameters to configure `tailscale serve`, rather than passing them to the
bridge.

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
`commands.toml`. This is one of four config files that share the same reader and load pattern:

| file | scope | confirm/danger flag | live reload |
| --- | --- | --- | --- |
| `commands.toml` | optional, per row | `confirm = true` | yes, no restart needed |
| `keys.toml` | optional, per row | `danger = true` | yes, no restart needed |
| `quick-replies.toml` | optional, per row | none | yes, no restart needed |
| `launchers.toml` | none, matched by exact command instead | none | yes, but an already-open tab re-reads the rows only on its next load |

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
```

A pane that matches your configured rows displays only those rows. The narrowest row wins, as
documented in [ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md).

To verify, open a pane and tap **/**; your rows appear on the first screen.

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

Your rows appear in two places: a **Launch** section on the dashboard, which folds like Spaces and
Recent, and a **Launch** section in the switcher sheet (swipe up from a pane). A pinned row shows
its folder, shortened under home; a cwd-less row says "here" in the switcher (the dashboard already
implies home, so it says nothing there). Declare no rows and neither section appears.

On a pack (several machines, one phone-facing lead), each machine reads its own copy of this file —
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
