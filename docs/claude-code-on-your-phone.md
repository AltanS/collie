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

On Herdr you can also do both steps from the phone. Open a pane's **⋯** menu and tap **New agent
in a worktree**. The New page opens with **New worktree** already on, for that pane's repo. Pick
the agent, then tap Start. Collie makes a worktree on a new branch, opens it as its own workspace,
and starts the agent in it. The branch is named `worktree/<word>-<word>-<hex>`, and you can change
the name before you tap Start. The same switch is on the page you open with **+ New** on the
dashboard, once you name a folder inside a repo.

Under the name, **Start from** picks where the new branch begins: the repo's default branch (for
example `main`), or **This branch**, the branch the folder is on. The choice shows only when that is
a branch other than the default, and it opens on **This branch**. Changes you have not committed
stay behind, because the new worktree starts from the last commit. Collie never fetches, so the
default is the copy of the branch you already have.

**Branch folder** says where the worktree goes. **Herdr's default** leaves it to Herdr, which uses
`~/.herdr/worktrees/<repo>/<branch>` unless its `config.toml` names another `[worktrees] directory`.
**Other folder** puts it in a folder you name, which must already exist under your home folder, and
must not be hidden, a link, or inside the repo. The page shows the full path of the new folder
before you tap Start, and Collie checks the rule again at the moment it creates it. Collie remembers
your choice for each repo.

The page is described in
[Start an agent or a shell from the phone](#start-an-agent-or-a-shell-from-the-phone). A create can
take up to a minute on a large repo. If the phone loses the reply, the page says so and does not send
it again. Look at the dashboard first. **Try again** sends the same request, so Collie answers with
the worktree it already made and does not make a second one. The switch works only on Herdr, and only
for the lead machine; elsewhere it stays on the page, off, and says why ("needs Herdr", or "only on"
the lead's name).

Running multiple sessions creates multiple waiting prompts. Collie groups panes by workspace and
marks the ones that need input: a red wash on the row, a dot on the workspace heading, and a count
on the line at the top, which jumps to the first of them. Hold a row to pin that pane to the top. The
clock and hourglass beside the count order the list by recent activity or by the cache that goes
cold first. On tmux, zellij and tern, these marks require the beacon hooks from
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
- A terminal multiplexer: Herdr, tmux, zellij, tuios or tern. Herdr and tuios detect agents directly. On tmux, zellij
  and tern, Collie uses beacon hooks, which require Linux.
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

1. **Pair the phone.** Run `collie pair` on the host and scan the QR code. Collie answers no device
   until it is paired ([Pair a device](security.md#pair-a-device--the-write-credential)).
2. **Put it on your home screen.** On Android, tap **Install** at the top of Settings. On an iPhone,
   tap Safari's share sheet.

## 5. Answer Claude Code

- Panes that need input carry a red mark. Tap the count at the top of the dashboard to jump to the first one, then tap a row to open it.
- Each dashboard row and the pane header show the git branch the pane's folder is on, or
  `detached @abc1234` on a detached head. A pane outside a git repo shows none.
- The composer uses a standard text field, so phone dictation works in it.
- Tap **Keys** on the actions row above the keyboard. The tray includes Esc, arrow keys, Enter, Tab,
  Space, modifiers, digits, and F1 to F12. Esc and Ctrl chords do not depend on the phone keyboard.
  The pad is yours to arrange: tap the pencil beside **Keys** to move keys, resize them, add your own
  chords and sticky modifiers, load a preset, or share a layout as a code
  ([Your own key pad](configure.md#your-own-key-pad)).
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

## Start an agent or a shell from the phone

You do not need the host to start work. The **+ New** button sits at the bottom right of the
Dashboard tab and folds to a round **+** while you scroll. It opens the New page, at `/new`. A card
that says **Start your first agent** opens the same page when no pane is running. The folder button
in the Spaces header, and **New agent in a worktree** in a pane's menu, open it too. The machine and
the pane ride in the address, so a reload keeps them.

The page has these parts, from the top:

- **Machine.** Shown on a [crew](crew.md) only. The start runs on the machine you pick, and each
  machine answers for itself.
- **Again.** One row that repeats your last start on that machine: the same agent or command, in the
  same folder. If the last start was in a new worktree, the row says so. Collie forgets it when the
  phone is unpaired.
- **Agent** or **Command.** One switch, and one select for each half. Collie remembers which half you
  used on each machine. Under each select a link says how to add one.
- **Folder.** Where it runs. A blank field means your home folder, and a bare name such as
  `projects` means `~/projects`. See
  [Favourite and recent folders](configure.md#favourite-and-recent-folders).
- **New worktree.** A switch, described [above](#run-several-claude-code-sessions-at-once).
- **A line** that says what will start where, and **Start**, pinned at the foot above the keyboard.

**Agent** lists Claude Code, Codex, opencode, pi, omp, Grok, Hermes, Muse and Antigravity. Each
machine checks which of them are installed, on the `PATH` your login shell uses. An agent installed
through nvm, or in your home folder, counts. An agent that is not found stays in the list. It is
disabled, and the reason follows its name in brackets, for example "not installed". Nothing
disappears from the list without a word.

**Command** lists a plain **Shell** and your [launchers](configure.md#your-own-launchers). You can
also add a launcher from the phone, with a few option chips such as "Skip permission prompts"
([Launchers added from a phone](configure.md#launchers-added-from-a-phone)). A launcher that skips
permission prompts carries a **No prompts** badge, and the phone asks you once before it first starts
it.

A refused Start shows its reason in a notice above Start, in your language. A folder that does not
exist on the machine that runs the start, for example, starts nothing and says so.

**A tap on Start never opens two panes.** Each start carries its own id. If the phone loses the
reply, the page says it could not confirm the start, and it sends nothing again. Look at the dashboard
first. **Try again** sends the same id, and Collie shows the pane the first tap made instead of
starting a second one.

## Other ways to reach Claude Code from a phone

- **Claude Code Remote Control** connects the Claude app or claude.ai/code to a Claude Code session
  on your machine, and its traffic goes through the Anthropic API ([Anthropic's
  docs](https://code.claude.com/docs/en/remote-control)). Collie mirrors terminal panes instead, so
  it works with any agent in your multiplexer, and it stays on your tailnet.
- **An SSH app** such as Termius, Moshi, or Termux exposes the full terminal. That works, but
  terminal controls on mobile keyboards are awkward. Esc, Ctrl, and arrow keys require workarounds.
