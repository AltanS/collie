# Run Claude Code from your phone

This guide covers one setup end to end: Claude Code runs on your machine, and your phone controls it
through Collie. The same steps work for Codex, OpenCode, and any other terminal agent. Only the
command in the pane changes.

Read [Security](security.md) first. Collie gives remote shell access to your machine by design.

## What you end up with

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

- The dashboard sorts panes that need input to the top. Tap one to open it.
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
