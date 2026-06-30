# Herdr.dev — Plugin System Notes

Research summary of [herdr.dev](https://herdr.dev) and its plugin system, focused on
building plugins. Sources: `herdr.dev/docs/*`, the `ogulcancelik/herdr` repo, and the
`ogulcancelik/herdr-plugin-examples` cookbook.

## What Herdr is

A terminal-based **agent multiplexer** — "tmux for AI coding agents." You run multiple
coding agents (Claude Code, Codex, OpenCode, …), each in a real PTY pane. Beyond tmux,
Herdr **understands agent state** (working / blocked / done / idle) and rolls it up
through the UI, persists sessions across detach/reattach (incl. over SSH), and exposes a
programmatic socket API.

- **Distribution:** single Rust binary, self-hosted only (no SaaS).
- **License:** dual — AGPL-3.0-or-later + commercial on request. No public pricing.
- **Repo:** `github.com/ogulcancelik/herdr` (~7.7k★, v0.7.0 as of Jun 2026).

### Object model (what plugins extend)

```
Server (persistent background namespace = "session")
└── Workspace (project: one per repo/task/investigation)
    └── Tab (a layout/view inside a workspace)
        └── Pane (a real PTY terminal)
            └── Agent (recognized process in a pane, with a state)
```

The **server** owns panes + process state and runs in the background; **clients**
(terminal UI, SSH, mobile) attach/detach without killing work. Everything is
controllable via a Unix-socket JSON API (`pane.split`, `agent.send`,
`events.subscribe`, …).

## Plugin core philosophy

> "There is no separate plugin SDK or restricted command set. The entire Herdr CLI is
> the plugin API."

A plugin is **not** an SDK integration. It is just a **directory with a
`herdr-plugin.toml` manifest + executable commands** in any language (Bash, JS, Lua,
Rust, any argv). Herdr launches your command, injects context via env vars, and your
command calls back into Herdr via the CLI (`$HERDR_BIN_PATH`) or raw socket
(`$HERDR_SOCKET_PATH`).

## The four extension points

| Manifest table     | What it does                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `[[actions]]`      | Invokable commands (CLI, keybinding, or programmatic). Get pane/ws context.  |
| `[[events]]`       | Event hooks — run a command on a Herdr event (only fires for *enabled* plugins). |
| `[[panes]]`        | Custom UI panels. Placement: `overlay` (default), `split`, `tab`, `zoomed`.  |
| `[[link_handlers]]`| Ctrl-click a terminal URL matching a regex → route to an action vs. browser. |

Plus `[[build]]` steps (run on GitHub install, **not** on local link) and
`[[keys.command]]` keybindings (live in Herdr's own config, not the plugin manifest).

## Manifest — canonical example (`herdr-plugin.toml`)

```toml
id = "example.layout"
name = "Layout"
version = "0.1.0"
min_herdr_version = "0.7.0"
description = "Apply project layouts"
platforms = ["linux", "macos", "windows"]

[[build]]
command = ["npm", "ci"]

[[build]]
command = ["npm", "run", "build"]
platforms = ["linux", "macos"]

[[actions]]
id = "apply"
title = "Apply layout"
contexts = ["workspace"]
command = ["node", "dist/apply.js"]

[[events]]
on = "worktree.created"
command = ["herdr", "workspace", "list"]

[[panes]]
id = "board"
title = "Project board"
placement = "overlay"
command = ["herdr-board"]

[[link_handlers]]
id = "github-issue"
title = "Open GitHub issue"
pattern = "^https://github\\.com/[^/]+/[^/]+/(issues|pull)/[0-9]+$"
action = "apply"
```

**Required fields:** `id`, `name`, `version`, `min_herdr_version`.
**Rules:** `id` uses ASCII letters/digits/`. : _ -`; local ids (action/pane/link) may
**not** contain dots; `command` is an argv array run **without a shell**;
`min_herdr_version` is enforced (install/link fails if newer than your binary).

## Runtime environment injected into plugin commands

- **Always:** `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_ENV=1`, `HERDR_PLUGIN_ID`,
  `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`,
  `HERDR_PLUGIN_CONTEXT_JSON` (+ `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` /
  `HERDR_PANE_ID` when available)
- **Actions:** `HERDR_PLUGIN_ACTION_ID`
- **Events:** `HERDR_PLUGIN_EVENT`, `HERDR_PLUGIN_EVENT_JSON`
- **Panes:** `HERDR_PLUGIN_ENTRYPOINT_ID`
- **Link handlers:** `HERDR_PLUGIN_CLICKED_URL`, `HERDR_PLUGIN_LINK_HANDLER_ID`

**Directory contract:** config (e.g. `.env`) → `HERDR_PLUGIN_CONFIG_DIR`; runtime state
→ `HERDR_PLUGIN_STATE_DIR`; **never** store state in `HERDR_PLUGIN_ROOT` (GitHub
installs are managed checkouts replaced on reinstall). No Herdr-managed storage API in
v1 — plugins own their files.

## Subscribable events

- `workspace.{created,updated,renamed,closed,focused}`
- `tab.created`
- `pane.{created,closed,focused,moved,exited,agent_detected,output_matched,agent_status_changed}`
- `worktree.{created,opened,removed}`

Unknown event names link with a *warning* rather than failing.

## Lifecycle / CLI (the whole API is `herdr plugin …`)

```bash
# Install (GitHub shorthand only) — normal user path
herdr plugin install <owner>/<repo>[/subdir...] [--ref REF] [--yes]
herdr plugin install ogulcancelik/herdr-plugin-examples/agent-telegram-notify

# Local development — does NOT run build commands
herdr plugin link <path> [--disabled]
herdr plugin unlink <plugin_id>

# Manage
herdr plugin list [--plugin ID] [--json]
herdr plugin enable|disable <plugin_id>
herdr plugin uninstall <plugin_id|owner/repo[/subdir...]>

# Inspect & run
herdr plugin config-dir <plugin_id>
herdr plugin action list [--plugin ID]
herdr plugin action invoke <action_id> [--plugin ID]
herdr plugin pane open --plugin ID --entrypoint ID [--placement overlay|split|tab|zoomed] ...
herdr plugin log list [--plugin ID] [--limit N]
```

- **No `plugin update` in v1** — reinstall from GitHub to refresh.
- Install path (`owner/repo/subdir`) ≠ manifest `id` (`examples.agent-telegram-notify`);
  use `herdr plugin list` to map them.

## Marketplace, trust & security

- **Marketplace** (`herdr.dev/plugins`): an **automatic, unreviewed** index of public
  GitHub repos tagged with topic **`herdr-plugin`** that contain a `herdr-plugin.toml`.
  Refreshes every 30 min; forks/archived excluded. v1 listings show GitHub repo metadata
  only (doesn't yet parse the manifest).
- **Security: no sandboxing.** A plugin is ordinary code running as your user with your
  environment and full Herdr CLI access. Guardrails = manifest validation, per-plugin
  config/state dirs, and an install-time trust preview (suppressed by `--yes`). Trust is
  the user's responsibility.

## Reference example plugins (`ogulcancelik/herdr-plugin-examples`)

"Examples to copy, not maintained official plugins" — one per language, covering each
extension point:

| Plugin                 | Lang | Demonstrates                                                                  |
| ---------------------- | ---- | ---------------------------------------------------------------------------- |
| `agent-telegram-notify`| JS   | `[[events]]` on `pane.agent_status_changed` → Telegram on done/blocked; `.env` config |
| `dev-layout-bootstrap` | Lua  | `[[actions]]` driving `pane split/run/rename` to build a 3-pane layout        |
| `github-link-preview`  | Bash | `[[link_handlers]]` + `[[panes]]` (split) — Ctrl-click GH issue/PR → side pane |
| `rust-release-check`   | Rust | `[[build]]` (cargo build at install) + binary action reading context JSON     |

## Documented gaps

- No machine-readable manifest schema (prose-validated server-side).
- `contexts` values for actions undocumented (only `"workspace"` shown).
- `HERDR_PLUGIN_CONTEXT_JSON` / event payload shapes only inferable from examples
  (e.g. `focused_pane_cwd`, `workspace_cwd`, `event.data.agent_status`).
- No testing harness, packaging format, signing, or dependency resolution.

## Key links

- Plugin authoring: <https://herdr.dev/docs/plugins/>
- CLI reference: <https://herdr.dev/docs/cli-reference/>
- Socket API (events + raw methods): <https://herdr.dev/docs/socket-api/>
- Marketplace: <https://herdr.dev/docs/marketplace/>
- Examples repo: <https://github.com/ogulcancelik/herdr-plugin-examples>
