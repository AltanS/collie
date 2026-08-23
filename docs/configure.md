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

Collie reads `.env` only during startup. Run `collie restart` after modifying it. The
[`.env.example`](../.env.example) file lists all options, including `COLLIE_PORT`,
`COLLIE_SERVE_MODE=http` (for Headscale or `.internal` domains), and `COLLIE_SERVE_PORT` (to expose
HTTPS on a port other than `:443`; see
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
`commands.toml`:

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
documented in [ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md). Set
`confirm = true` to require a two-tap confirmation. Changes apply immediately without restarting. To
verify, open a pane and tap **/**; your rows appear on the first screen. Check syntax errors with
`journalctl --user -u collie -n 20`, which prints the line number.

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
C/D/U/R/L/Z buttons ([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). Set
`danger = true` to require a two-tap confirmation. The rest of the tray (Esc, arrow keys,
Enter/Tab/Space, modifiers, digits, F1–F12) is fixed. Chords use herdr's syntax: `ctrl+c` (not
`C-c`), `shift+tab`, and `ctrl+F7`. Keys like `PageUp`, `Home`, `End`, and `Delete` are not
supported. Edits apply live without restarting the service. To verify, open a pane and tap **Keys →
Presets** to view the new buttons. If Collie rejects a row, check
`journalctl --user -u collie -n 20` for the error details.

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
English (`yes`, `commit and push`). Use this file to run in other languages or to send words like
`approve` to specific harnesses. Setting `scope = "shell"` targets standard shell panes, which
otherwise only receive `y`/`n`. Changes apply immediately without a restart. To verify, open a pane
and tap **Quick** to see your groups. If a row fails to load, `journalctl --user -u collie -n 20`
prints the error.

## Your own launchers

One tap opens a new Space and runs a command you declared, in `launchers.toml` next to `keys.toml`:

```bash
cp launchers.toml.example ~/.config/collie/launchers.toml
```

```toml
[[launchers]]
command = "htop"             # required; the shell line, typed verbatim into the new Space
label = "Top"                # optional; defaults to the first word of command
# cwd = "~/dev/collie"       # optional; defaults to your home directory, ~ expanded
```

A tap creates a Space named after the row, in its `cwd`, types the `command` and sends Enter. The
command owns its own lifetime. A command that closes itself takes the Space with it, and `htop`
stays until you quit it. This file is the allowlist. `POST /api/launch` accepts only a command that
matches a row here exactly, so a phone can start nothing that is not in the file. Changes apply
immediately without a restart, but an already-open tab reads the rows once per load.

Your rows appear twice: as a **Launch** section on the dashboard, which folds like Spaces and
Recent, and behind the rocket button in the Space and pane headers, which opens them as a sheet
with each command printed under its label. Declare no rows and neither surface appears. To verify,
reload the dashboard and look under the herd. If a row fails to load,
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
nothing to shadow. They appear below the three default entries, and each client device selects its
own.

Two behaviors to note: custom fonts lack metric-matched fallbacks, which causes a minor layout shift
during initial load. Built-in fonts avoid this because their fallbacks are generated at build time.
Cold loads fetch the file with a brief delay, though cached clients paint immediately. The selected
font applies only to Collie's chrome; the terminal mirror, transcript, and rendered markdown retain
their own typography. Changes do not require a restart, taking effect on the next page reload.
Invalid configurations log errors visible via `journalctl --user -u collie -n 20`.

## Multi-session

`COLLIE_MULTI_SESSION=on` (the default) discovers and serves every named Herdr session under your
config root, switchable from the header. Setting `COLLIE_MULTI_SESSION=off` serves only the primary
session. Every discovered session is accessible through the same URL, including private or sandbox
sessions. [Security](security.md) lists this behavior as a sharp edge.

## Dark mode / light mode

**Collie follows your phone by default.** To pin it, open **Settings → Appearance** and pick
**System**, **Light** or **Dark**. The setting is stored **per device** in the browser rather than
on the bridge. Your phone can remain on Dark while a laptop tracks the OS. The preference persists
across reloads and PWA reinstalls on the same device.

### The terminal mirror is deliberately different

The mirror always renders on a **dark ground**. Light mode inverts the entire element instead of
re-colouring individual spans. Agents emit absolute 24-bit colour codes (`38;2;r;g;b`) tuned for
dark backgrounds, which downstream parsers cannot reliably remap. Rendered directly onto white, most
agent output drops below a 3:1 contrast ratio. Inversion preserves the intended contrast. The
measurements are documented in [ADR 0002](../.adr/0002-invert-the-light-terminal-mirror.md).

This implementation has two practical consequences:

- **Keep your agents configured for dark themes.** This is the default for Claude Code, codex,
  opencode and pi. If an agent uses a *light* theme, it emits dark-on-light values that become
  illegible in Collie under both modes. This stems from the agent output rather than Collie itself.
- **Diffs and highlighted rows render as dark blocks** in light mode. Contrast remains intact, but
  the visual weight is reversed.

> **Installed on iOS?** In light mode, the status-bar text remains white and can blend into the
> background. iOS does not allow web apps to update this value dynamically. Run Collie directly in
> the browser instead of as an installed PWA to avoid this limitation.

## Zen mode

**Off by default.** Enable it in **Settings → Zen mode** (stored per device in the browser). This
adds a **Zen mode** option to the pane menu, under the ⋮ beside Find and History. Tapping it hides
all Collie UI elements: the header, tab and pane strips, agent statusline, and composer docks. Only
the terminal mirror remains visible. A floating button in the top-right corner or the Escape key
restores the interface.

Zen mode is **transient**. The configuration persists, but the active state resets when you switch
panes or reload the page. Panes always open with standard chrome. The terminal mirror continues
polling in Zen mode, and interactive buffer elements remain functional. Prompt buttons, "Load
older", and "Show entire history" controls stay available because they are part of the content
stream rather than chrome.

## Language

Collie supports six languages: English, Deutsch, Español, 한국어, 日本語, and 中文. Configure this under
**Settings → Language**. The selection is saved locally in the browser per device. The terminal
mirror remains untranslated. It displays the raw output from the agent, while quick replies, menu
labels, and key caps match the underlying screen or keyboard names.


---

[← back to the README](../README.md)
