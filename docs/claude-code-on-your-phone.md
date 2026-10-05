# Run Claude Code in tmux or Herdr, and control it from your phone

An SSH connection drops, and Claude Code terminates with it. A phone terminal keyboard lacks Esc
and Ctrl keys. You return an hour later, and Claude Code has sat idle the entire time on a prompt
waiting for approval.

This guide fixes all three issues. Run Claude Code in tmux or Herdr so it outlives dropped
connections. Then add Collie to prioritize waiting sessions on your phone and provide the missing
keys.

## Keep Claude Code running in tmux

Start Claude Code inside a tmux session. It continues running on the host when your connection
drops.

```bash
tmux new -s claude       # start a session named claude
claude                   # run Claude Code inside it
```

Detach with `Ctrl+b`, then `d`. Log in later from any machine and reattach:

```bash
tmux attach -t claude
```

The tmux server owns the session rather than your SSH login, so a dropped connection does not stop
Claude Code. Run `tmux ls` to list sessions on the host.

### Herdr

Herdr is a terminal workspace manager built for coding agents. It operates the same way.

```bash
curl -fsSL https://herdr.dev/install.sh | sh    # or: brew install herdr
herdr                                           # start Herdr, or reattach to it
claude                                          # in the pane Herdr opens
```

Detach with `Ctrl+b`, then `q`, or close the terminal. The Herdr server keeps your panes and
Claude Code running. Run `herdr` again to reattach.

### zellij

Run `zellij -s claude`, start `claude`, detach with `Ctrl o` then `d`, and reattach with
`zellij attach claude`. Collie mirrors only one zellij session. See
[zellij notes](multiplexers.md#zellij-notes).

## Run several Claude Code sessions at once

Give each session its own window and checkout so two agents do not edit the same files.

```bash
# a second checkout, on its own branch
git worktree add ~/src/app-review -b review
tmux new-window -t claude -n review -c ~/src/app-review
claude                                     # in the new window
```

Inside tmux, press `Ctrl+b` then `c` to open a window, and `Ctrl+b` then `w` to list them. Press
`Ctrl+b` then `%` to split a pane left and right, and `Ctrl+b` then `"` to split top and bottom.

On Herdr, give each agent its own workspace while Herdr runs:

```bash
herdr workspace create --label review --cwd ~/src/app-review
```

Running multiple sessions creates multiple waiting prompts. Collie groups panes by workspace and
marks the ones that need input: a red wash on the row, a dot on the workspace heading, and a count
on the line at the top, which jumps to the first of them. Hold a row to pin that pane to the top. The
clock and hourglass beside the count order the list by recent activity or by the cache that goes
cold first. On tmux and zellij, these marks require the beacon hooks from
[step 3](#3-run-claude-code-in-a-pane).

## Drive it from your phone with Collie

Collie runs on your host and mirrors your Herdr, tmux, or zellij panes to your phone browser. The
same steps work for Codex, OpenCode, and any other terminal agent. Only the command in the pane
changes.

> **Note.** Collie provides remote shell access to your machine by design. Read
> [Security](security.md) before installing it.

- Claude Code runs on your host in a Herdr, tmux, or zellij pane. No agent code runs on the phone.
- Your phone opens Collie in a browser over your tailnet. The dashboard lists panes and puts waiting
  sessions first.
- You read output, submit replies, and send Esc, Tab, arrows, or modifiers from the Keys tray. You
  do not need an SSH client.
- Optional push notifications alert you when an agent needs input.

## What you need

- A Linux or macOS host with Claude Code installed.
- A terminal multiplexer: Herdr, tmux, or zellij. Herdr detects agents directly. On tmux and zellij,
  Collie uses beacon hooks, which require Linux.
- Tailscale installed on the host and phone, with HTTPS enabled on your tailnet. For other setups,
  see [Deployment](deployment.md).
- An iPhone or an Android phone.

## 1. Install Collie

```bash
curl -fsSL https://colliepwa.dev/install.sh | sh
```

On Herdr, you can install the plugin directly: `herdr plugin install AltanS/collie`.
[Install](install.md#install) covers both methods.

## 2. Start it

```bash
collie start
```

The first run checks for Herdr, tmux, and zellij, then writes your choice to `.env`. It starts
`tailscale serve` and prints a `tailnet` URL. See [Start it](install.md#start-it).

## 3. Run Claude Code in a pane

On Herdr, open a pane and run `claude`. Herdr flags the pane as an agent to Collie.

On tmux or zellij, install beacon hooks once per host. This lets Collie distinguish agents from
plain shells. Next, open a window or tab in the session Collie mirrors, then launch Claude Code:

```bash
collie hooks install claude    # once per host, Linux only
tmux new-window -n claude      # or: zellij action new-tab --name claude
claude
```

Collie mirrors the default tmux server unless you set `COLLIE_MUX_ENDPOINT_TMUX`. The `claude`
session from above appears automatically.

Running Claude Code instances do not reload settings automatically. Restart Claude Code after you
install hooks. See [Collie writes hooks into Claude's own
settings](multiplexers.md#collie-writes-hooks-into-claudes-own-settings).

## 4. Open it on your phone

Run `collie qr` on the host to scan the code, or open the link from `collie url`. Keep the phone on
the same tailnet.

1. **Pair the phone.** Run `collie pair` on the host and scan the QR code. Pairing grants the phone
   write access to your panes ([Pair a device](security.md#pair-a-device--the-write-credential)).
2. **Put it on your home screen.** On Android, tap **Install** at the top of Settings. On an iPhone,
   tap Safari's share sheet.

## 5. Answer Claude Code

- Panes that need input carry a red mark. Tap the count at the top of the dashboard to jump to the first one, then tap a row to open it.
- The composer uses a standard text field, so phone dictation works in it.
- Tap **Keys** on the actions row above the keyboard. The tray includes Esc, arrow keys, Enter, Tab,
  Space, modifiers, digits, and F1 to F12. Esc and Ctrl chords do not depend on the phone keyboard.
- Claude Code buttons sit on the same row: Model, Effort, Compact, and Resume. See
  [Configure](configure.md#configure).

## 6. Get notified (optional)

```bash
collie push-keys     # writes the VAPID keys to your .env
collie restart
```

Turn notifications on in Collie's Settings on the phone. **Needs input** is enabled by default. On
an iPhone, install Collie to your home screen first. Safari restricts Web Push to home-screen web
apps. See [Web Push](voice-and-push.md#web-push-optional).

## Other ways to reach Claude Code from a phone

- **Claude Code Remote Control** connects the Claude app or claude.ai/code to a Claude Code session
  on your machine, and its traffic goes through the Anthropic API ([Anthropic's
  docs](https://code.claude.com/docs/en/remote-control)). Collie mirrors terminal panes instead, so
  it works with any agent in your multiplexer, and it stays on your tailnet.
- **An SSH app** such as Termius, Moshi, or Termux exposes the full terminal. That works, but
  terminal controls on mobile keyboards are awkward. Esc, Ctrl, and arrow keys require workarounds.
