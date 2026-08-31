# Configure

Out of the box Collie runs **open single-user**: anyone on your tailnet who can reach the URL has
full control — that's the TRUSTED_USER warning. Close it:

```bash
# in your .env
COLLIE_TRUSTED_USER=you@example.com           # your tailnet login — Collie rejects anyone else
COLLIE_PUBLIC_HOSTS=myhost.tail1234.ts.net    # only behind your OWN proxy; on a tailnet `collie
                                              # start` discovers this for you
```

Config is a `.env` in Collie's config dir, which is **`~/.config/collie`** unless Herdr says
otherwise: on a Herdr-managed install the CLI asks Herdr for the plugin's config dir and uses that
(typically `~/.config/herdr/plugins/config/herdr.collie`). The same dir is resolved whichever way you
run a verb, so a `.env` you seed here is the one the service reads:

```bash
mkdir -p ~/.config/collie && cp .env.example ~/.config/collie/.env

# on a Herdr-managed install, seed Herdr's plugin config dir instead:
cp .env.example "$(herdr plugin config-dir herdr.collie)/.env"
```

Every config path below is written as `~/.config/collie/…`; on a Herdr-managed install, substitute
`$(herdr plugin config-dir herdr.collie)`.

Collie reads `.env` only at startup — after any edit, `collie restart`. See
[`.env.example`](../.env.example) for the full option list — commonly `COLLIE_PORT`,
`COLLIE_SERVE_MODE=http` (Headscale / `.internal` domains) or `COLLIE_SERVE_PORT` (publish the
https front door somewhere other than :443 — see
[DEPLOYMENT.md → Several Collies on one host](../DEPLOYMENT.md#several-collies-on-one-host)). Both
serve settings are read by the CLI when it runs `tailscale serve`, not by the bridge.

Reading history from more than one agent home? List them all in `COLLIE_TRANSCRIPT_ROOT`,
comma-separated.

**Custom domain or reverse proxy?** [`DEPLOYMENT.md`](../DEPLOYMENT.md) has the full front-door setup.
The one rule to know here: Collie is same-origin only, so a different hostname or TLS terminator
needs the exact origin allowed —

```bash
COLLIE_ALLOWED_ORIGINS=https://collie.example.com
```

— and until you do, the page loads and stays empty
([Troubleshooting](troubleshooting.md#troubleshooting) has the symptom).

## Your own slash commands

Commands only this machine has (a Herdr plugin's `/fork-in-herdr`, your own `/deploy`) go in
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

A pane your rows match shows only your rows (narrowest row wins,
[ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). Add `confirm = true` for a
two-tap confirm. No restart — edits are live. Verify: open a pane, tap **/**, your rows are on the
first screen. Syntax error? `journalctl --user -u collie -n 20` names the line.

## Your own key presets

The Keys tray's **Presets** row is yours to replace, in `keys.toml` next to `commands.toml`:

```bash
cp keys.toml.example ~/.config/collie/keys.toml
```

```toml
[[keys]]
scope = "claude"             # optional; omit for every pane
label = "Yes"
keys = ["Down", "Enter"]     # several chords go out as one batch
```

A pane your rows match shows only your presets, in place of the shipped Ctrl C/D/U/R/L/Z
([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). Add `danger = true` for a
two-tap confirm. The rest of the tray — Esc, arrows, Enter/Tab/Space, modifiers, digits, F1–F12 —
is fixed and not configurable. Chords are herdr's spelling: `ctrl+c` (never `C-c`), `shift+tab`,
`ctrl+F7`; `PageUp`/`Home`/`End`/`Delete` are not accepted. No restart — edits are live. Verify:
open a pane, tap **Keys → Presets**, your buttons are there. Rejected row?
`journalctl --user -u collie -n 20` names it and why.

## Your own quick replies

The Quick dock's one-tap phrases are yours to replace, in `quick-replies.toml` next to the other two:

```bash
cp quick-replies.toml.example ~/.config/collie/quick-replies.toml
```

```toml
[[replies]]
scope = "claude"             # optional; omit for every pane
title = "confirm"
items = ["yes", "no"]        # sent verbatim, one per button
```

A pane your rows match shows only your groups, in place of the shipped ones
([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). The shipped phrases are
English (`yes`, `commit and push`); this is the way to work in another language, or to give a
harness that wants `approve` the word it wants. `scope = "shell"` reaches a plain shell pane, which
otherwise gets only `y`/`n`. No restart — edits are live. Verify: open a pane, tap **Quick**, your
groups are there. Rejected row? `journalctl --user -u collie -n 20` names it and why.

## Your own typefaces

The app's own face is a **per-device** setting — **Settings → Typeface** offers System, Space
Grotesk (the default) and Aldrich. You can add your own in `theme.toml`, the fourth file beside the
other three:

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

**Your faces ADD to the shipped list — they never replace it**
([ADR 0033](../.adr/0033-the-app-face-is-a-device-preference.md)), which is the opposite of what
`commands.toml` and its two siblings do. The reason is that a font cannot fire an action, so there
is nothing for it to shadow. They appear under the shipped three, and every phone chooses for
itself.

Two things to expect. A font Collie has never seen has no metric-matched stand-in, so the page
shifts slightly as it loads — the shipped faces don't, because their stand-ins are computed from the
files at build time. And on a cold load your face lands a beat after a shipped one would; a device
that has already chosen it paints it immediately from then on. Whatever you pick, the face dresses
Collie's own chrome and **never** an agent's words: the mirror, the transcript and rendered markdown
keep their own. No restart — edits are live, and reach a phone on its next reload. Rejected row?
`journalctl --user -u collie -n 20` names it and why.

## Multi-session

`COLLIE_MULTI_SESSION=on` (the default) discovers and serves every named Herdr session under your
config root, switchable from the header; `COLLIE_MULTI_SESSION=off` serves only the primary one. Every
session it finds is drivable through the same URL — including a private or sandbox one, which is why
[Security](security.md) lists this as a sharp edge.

## Dark mode / light mode

**Collie follows your phone by default.** To pin it, open **Settings → Appearance** and pick
**System**, **Light** or **Dark**. The choice is **per device**, stored in the browser, not on the
bridge: your phone can sit on Dark while the laptop follows the OS. It survives reloads and
reinstalls of the PWA on the same device.

### The terminal mirror is deliberately different

The mirror always renders on a **dark ground**, and light mode inverts the whole thing rather than
re-colouring it. That is not a shortcut — agents emit absolute colours (`38;2;r;g;b`) chosen for a
black terminal, and nothing downstream can re-theme them; dropped straight onto white, most of an
agent's output falls below 3:1. Inverting keeps the contrast the agent designed for. The full
measurement is in [ADR 0002](../.adr/0002-invert-the-light-terminal-mirror.md).

Two things follow that are worth knowing:

- **Keep your agents on a dark theme** — the default for Claude Code, codex, opencode and pi. An
  agent set to a *light* theme emits dark-on-light colours, which are unreadable in Collie under
  either appearance. This is a property of what the agent sends, not of Collie's rendering.
- **Diffs and highlighted rows show as dark blocks** in light mode. Legibility is unaffected; only
  the visual weight flips.

> **Installed on iOS?** In light mode the status-bar text stays white and can disappear against the
> page. iOS gives web apps no way to change this at runtime — use the browser rather than the
> installed app if it bothers you.

## Zen mode

**Off by default.** Turn it on in **Settings → Zen mode** (per device, stored in the browser) and a
**Zen mode** row joins the pane's own menu, under the ⋮ beside Find and History. One tap takes every
Collie surface off the screen — the header, the tab and pane strips, the agent's statusline, the
composer and its docks — and leaves the terminal mirror alone. A floating button in the top-right
corner brings it all back, and Escape does too.

Zen is deliberately **transient**: the setting persists, the state does not. It resets when you
switch pane or reload, so a pane always opens with its chrome. The mirror keeps polling while you
are in it, and the output stays interactive — prompt buttons and the top-of-buffer "Load older" /
"Show entire history" affordances are content, not chrome, so they stay.

## Language

Collie's UI speaks six languages — English, Deutsch, Español, 한국어, 日本語, 中文. Open **Settings →
Language** and pick one by its own name; the choice is per device, stored in the browser. The
terminal mirror is never translated — it shows exactly what the agent printed, and quick replies,
menu labels and key caps stay as the screen or the keyboard names them.


---

[← back to the README](../README.md)
