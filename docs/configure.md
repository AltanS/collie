# Configure

By default, Collie answers only a device you paired with `collie pair`. A paired device has full
control, so anyone on your tailnet who can reach the URL still needs a paired phone first. Without
`COLLIE_TRUSTED_USER`, the bridge prints a `TRUSTED_USER` warning, because every tailnet login can
reach the pair screen. Restrict access further:

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
| `access` | the Tailscale identity gate, the device header, the audit trail, the secret mask |
| `push` | the three Web Push (VAPID) values |
| `uploads` | the attachment size cap and the extra text types accepted |
| `journal` | where each harness keeps its own session log |
| `crew` | the budgets a lead gives a member, and a peer's own browser |
| `standby` | the deputy's second door: port, bind address, arming |
| `update` | where releases come from, how many versions stay, a GitHub token for the release check |
| `serve` | whether Collie publishes the front door, on what, and under which path (`base_path`) |

The durable agents one Collie runs beside its multiplexer are not in `config.toml`. Each is one entry in
`sources.json`, in the same folder as `.env` ([Durable agents](durable-agents.md#attach-a-durable-agent)).
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
| `launchers.toml` | none, matched by exact command instead; `[phone]` switches the rows a phone adds | none | yes, but an already-open tab re-reads the rows only on its next load |
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
| opencode | Model, Compact, Resume |
| Grok Build | Model, Compact, Resume |
| Muse Code | Model, Effort, Compact, Resume |
| Antigravity (agy) | Model, Compact, Resume |

Codex, Grok and Antigravity have no Effort button, because their `/model` picker also sets the
reasoning effort. A bare `/effort` in Grok opens no picker at all.

pi and opencode have no effort command. pi keeps that dial inside `/settings`, a modal the keys pad
cannot usefully drive, and opencode cycles its variants on a key.

opencode spells two buttons its own way: Model sends `/models` and Resume sends `/sessions`. Its
Compact works once the session holds a turn, because opencode offers `/compact` only then.

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

While the text box holds text or an attachment, an X sits at the belt's right end too, left of the
Switch button. One tap empties the box and its saved draft, and sends nothing to the pane. The X then
becomes Undo, which puts the text and the attachments back. Undo stays until your next act: a
keystroke, an attachment, a send, a tap on another belt button, or leaving the pane. Scrolling the
belt keeps it.

Left-handed? Set **Settings → Appearance → Hand** to **Left**. The belt turns round: the Switch button
and the X move to its left end, still above Send, and Keys becomes the rightmost button, with the rest
scrolling off toward the left. Send and Attach move to the left of the reply box. The setting is per
device and applies the next time you open a pane.

To verify, open a pane running Claude Code, Codex, pi or omp; the tinted segment sits at the right
of the row above the keyboard. Turn that segment off per device in **Settings → Appearance → Harness shortcuts**;
Collie's own controls stay.

### Stop a turn

A **Stop** button sits at the start of the belt, before Collie's other buttons, so it is in view
without a scroll. It stands there for every agent whose harness profile names a stop key, and it is
dimmed while nothing runs. It keeps its place and its size, so the other buttons never move when a
turn starts or ends. A tap on the dimmed button does nothing and sends nothing. An agent with no
stop key has no button. Stop does not type anything and does not send a message. It presses the
agent's own stop key, once, and tells you what happened.

A Stop needs two taps. The first tap arms the button: the word changes to **Stop?** and the button
keeps its size. Tap it again within four seconds to stop the turn. A second tap that lands at once,
within 0.4 seconds, counts as the same touch and is ignored. If you wait, the arm lapses and nothing
is pressed. The arm also lapses when you open another pane, and the button goes dim when the turn
ends. While the second tap is in flight the button takes no more taps, so a quick third tap cannot
press a second Stop.

Which key stops a turn is the harness's own choice, and the harness profile holds it. Most agents
stop on Escape, some on Ctrl+C, and some need Escape twice. The profile decides, not this page.

After the key goes in, Collie reads the screen again for up to three seconds and tells you one of
three things under the box:

| Receipt | What it means |
| --- | --- |
| **Stopped.** | The key went in, and two reads in a row show the turn over. The box is free. |
| **Stop sent. The agent still looks busy.** | The key went in, but Collie did not see the turn over on two reads in a row. Give it a moment, then tap Stop again if you need to. |
| A refusal | Nothing was pressed. The sentence says why. |

If the stop key opened a dialog instead, Collie says so and points you to its card.

Collie refuses before it presses when pressing could do harm:

- **A dialog is open.** Escape would answer that dialog. Answer it on its card instead.
- **The box holds your text, and this harness's stop key would clear it.** Clear the box, or use the
  Clear button on the Keys board, then tap Stop again.
- **Collie cannot read this pane.** It does not press a key into a screen it cannot read. This also
  covers a screen where Collie cannot tell whether a turn runs.
- **The turn had already ended.** There was nothing to stop, so nothing was pressed.
- **This machine cannot stop from the phone yet.** Over a crew, the machine that runs the pane has an
  older Collie. Update it, then stop.

If no answer comes back from a crew machine in time, Collie says so. The Stop may have gone in, so
check the pane before you tap Stop again.

A Stop is always your tap. A walky talky message, a hook, the command line and a queued action never
press one. Over a crew, the machine that runs the pane presses the key, reads the screen and sends
the receipt back through the lead.

A program that runs as a durable agent keeps the Stop it already had. It stops the turn it names,
with its own receipt, and it does not use the arm.

### Clear the box

The **Clear** button at the end of the chip row on the Keys board empties the harness's input box
in one tap, with no arm. Collie presses the harness's own delete key as often as the text needs,
reads the box again, and tells you in a notice above the belt whether the box is clear or why it was
not. The button is greyed when the box is empty, a dialog is open or the link is down, and if the box
does not empty Collie leaves what remains alone and does not press again.

After a Clear, the notice offers **Restore** for two minutes. One tap types the text back into the
box, as one line and without Enter, so nothing is sent. Restore goes away once you type in the box
again or open another pane. The bridge keeps the cleared text in memory with the Clear's receipt,
and never writes it to a log or to disk.

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
C/D/U/R/L/Z buttons ([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). These
rows are yours as the operator and reach every phone. The pad above them (Esc, the arrows,
Enter/Tab/Space, the modifiers) is not set here: each phone arranges its own, see the next section.

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

## Your own key pad

You can rearrange the Keys pad. Open **Keys** and tap the pencil beside the label:

1. Tap the pencil next to **Keys**. A tall sheet opens over the pane.
2. Drag a key to another place, or tap it and use the four arrow buttons.
3. Tap a dashed **+** to add a key in a free cell, or select a key and tap **Change** or **Remove**.

The pad is a grid of 7 columns. A key sits on one cell and can be wider (1, 2 or 3 columns) and taller
(1 or 2 rows). Select a key and tap **Width** or **Height** to resize it. It grows to the right and
down. A size that would cover another key, or leave the pad, looks dim, and tapping it tells you which
key is in the way. Collie never moves a second key for you. **Add row** puts a row at the bottom, up to
eight. Changes show in the dock at once. Collie keeps your pad in this browser, so a different browser
starts with the default pad until you share a layout into it. The default is the pad you had before,
with the Space bar three cells wide and Enter at the left end of the second row:

```
Esc    Tab    Shift  Ctrl   Alt    Up     ^C
Enter  Space (3 wide)        Left   Down   Right
```

Dragging a key moves its whole area. Drop it on a key of the same size and the two swap. Drop it on
anything else that is in the way and the target outline turns grey and dashed, a line says which key is
in the way, and the key goes back. An arrow button skips over keys in the way and stops at the next
place where the key fits; if there is none, it stays off.

A key sends a chord of up to three modifiers plus one key, for example Ctrl+Alt+Shift+T. It can also
send a short sequence of up to four steps, for example Ctrl+B and then C. A sequence goes out in
order as one call. In the key builder, pick **Character**, **Named** or **F keys** for those. Pick
**Modifier** to make a sticky Ctrl, Alt or Shift key like the ones on the default pad: tap it once to
arm the next key, again to hold it, a third time to let go. A modifier key stands alone, so it has no
steps and no name. Every key takes the same path as the built-in ones: it waits while the pane is
locked or offline, a key that can stop a program (Ctrl+D, Ctrl+Z, or a sequence with Ctrl+C) asks for
a second tap, and a key your multiplexer cannot send is grey.

| Control | What it does |
| --- | --- |
| Presets | Default, Claude Code, Prefix (Ctrl+B), Vim, Navigation. Each shows a preview and asks before it replaces your pad. |
| Share: Copy layout | Puts a short code on the clipboard. On plain http, select the code and copy it by hand. |
| Share: Import layout | Paste a layout code someone shared. Collie checks it, shows a preview and asks before it applies. |
| Restore default | Brings back the original pad, after a preview. |

Codes from earlier versions still import, with every key one cell. If Esc, Enter or an arrow is not
on your pad, a quiet line says so, with **Put back**. The Prefix (Ctrl+B) preset sends the `Ctrl+B` prefix, so it
fits a tmux running inside the pane. The Navigation preset has Home, End, PgUp and PgDn, which Herdr
cannot send, so they are grey on a Herdr pane
([ADR 0092](../.adr/0092-the-keys-pad-is-a-board-you-arrange.md)).

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
English (`yes`, `commit and push`, `drastically simplify`).

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

Where the row opens depends on where you start it, not on the row. From the **New page** (Shell,
then the row in the Command select), Start creates a new Space named after its folder, and the
row's label names the tab. From a **pane** — the switcher sheet you reach by
swiping up — a tap opens a new **tab in that pane's own Space**, beside it, named after the row.

Either way the bridge types the `command` into the fresh shell and sends Enter. The command owns
its own lifetime: one that closes itself takes the Space or tab with it, and `htop` stays until you
quit it.

`cwd` is where that new Space or tab opens. Give a row a fixed folder (as `htop` does above) and it
wins wherever you tap the row.

Leave it out and it means "here": the dashboard opens it in your home dir, a pane opens it in
*that pane's own* cwd — one cwd-less row follows you around your checkouts instead of always
landing at the top of one.

This file and the rows added from a phone (below) are the allowlist. `POST /api/launch` accepts
only a `command` that matches one of those rows exactly, an agent id from the machine's own list (the
machine types that agent's command itself), or a plain shell. Changes apply immediately without a
restart, but an already-open tab re-reads the rows only on its next load.

Two optional keys tell the phone more about a row:

```toml
[[launchers]]
command = "claude-danger"
label = "Claude Code, no prompts"
# The agent that reads the row: it is listed under Agent with that agent's mark.
harness = "claude"
# The line skips permission prompts, but an alias hides its flags.
no_prompts = true
```

Your rows appear in three places:

- **On the New page** (tap **+ New** on the dashboard). The switch at the top reads **Agent** | **Shell**.
  A row with `harness` is in the **Agent** select. A row without `harness` is in the **Command** select,
  which is the select under **Shell**.
- **In a Launch section on the dashboard.** It folds like Spaces.
- **In a Launch section in the switcher sheet** (swipe up from a pane).

On the New page a cwd-less row runs in the folder you name there, and a row with a fixed folder shows
that folder in place of the field. A row never starts in a worktree; pick an agent or Shell for that.
A row with a fixed folder shows it, shortened under home; a cwd-less row says "here" in the switcher
(the dashboard already implies home, so it says nothing there). Declare no rows and neither section
appears.

On a crew (several machines, one phone-facing lead), each machine reads its own copy of this file —
a row launches on whichever machine's dashboard or pane you tapped it from, not on the lead.

The **Agent** select on the New page is Collie's own list: Claude Code, Codex, opencode, pi, omp,
Grok, Hermes, Kiro, Muse and Antigravity. Kiro starts with its tool permissions left as you set
them. An agent that is not on the machine's login `PATH` stays in the list, disabled, marked "not
installed". For another terminal agent, declare a row for it as above: it shows in the **Command**
select under **Shell**, starts in a pane like any command, and Collie shows no status for it.

To verify, reload the dashboard and look under the herd. If a row fails to load,
`journalctl --user -u collie -n 20` prints the error.

### Launchers added from a phone

A phone can add its own rows on a machine. They are kept in that machine's state folder, in
`launchers-added.json`, never in `launchers.toml`, and never copied to another machine.

On the New page, tap **Add your own** under the **Agent** select or under the **Command** select.
It opens the page `/new/add` for the machine chosen there. Pick **Agent** or **Command** at the top.
An agent has two ways: a **recipe** (a harness, option chips, and the exact line Collie will type)
and **Write a command**. A command row is always written by hand. **Add** returns to the New page
with the new row chosen. Below the form, **Added on this machine** lists every row a phone added
there, with **Rename** and **Remove**, and the rows from `launchers.toml` with a lock and no
actions. **How adding works** opens a short explainer with this machine's `launchers.toml` path and
an example row you can copy.

```toml
[phone]
adds = true          # default true: a phone may add rows built from a recipe
free_text = false    # default false: a phone may also add a line typed by hand
run = true           # default true: a phone may run a one-off command, and run it again from history
```

Put the `[phone]` table anywhere in `launchers.toml`. A value that is not `true` or `false` reads
as `false`. The bridge enforces the switches: a refused add changes nothing, and a row a switch
turns off stops starting at once. The row stays in the file, so turning the switch back on restores
it.

A **recipe** is an agent plus option chips from the bridge's own table, for example Claude Code and
"Skip permission prompts". The phone sends only the ids, and the bridge builds the line. Every chip
was read off that agent's own `--help`:

| Agent | Option | Adds |
| --- | --- | --- |
| Claude Code | Skip permission prompts | `--dangerously-skip-permissions` |
| Claude Code | Plan mode | `--permission-mode plan` |
| Claude Code | Model: opus, Model: sonnet | `--model opus`, `--model sonnet` |
| Claude Code | Continue last | `--continue` |
| Codex | Skip approvals and sandbox | `--dangerously-bypass-approvals-and-sandbox` |
| Codex | Never ask | `--ask-for-approval never` |
| Codex | Read-only sandbox, Web search | `--sandbox read-only`, `--search` |
| opencode | Auto-approve, Plan agent, Continue last | `--auto`, `--agent plan`, `--continue` |
| pi | Continue last, Thinking: high | `--continue`, `--thinking high` |
| omp | Continue last, Thinking: high | `--continue`, `--thinking=high` |

A **free line**, such as an alias like `claude-danger` or a plain `htop`, is possible only with
`free_text = true`. Without it, **Write a command** shows one disabled row, "Turned off on" the
machine, and **Add** stays off. With it, **Check the line** shows the line with every hidden
character written as its code (for example `⟨U+200B⟩`) before **Add** turns on. It is at most 200 characters, and the bridge refuses a control character, a line
or paragraph separator and a bidi control in it, both when it is added and each time it is read.

A machine keeps at most 20 added rows. If a row has the same line as a row in `launchers.toml`, the
row in `launchers.toml` wins. Each added row records the paired device that added it. Revoking that
device removes its rows, from the phone or with `collie devices revoke`, and the audit log records
every add, rename and removal.

> **Caution.** A row that skips permission prompts carries a "No prompts" badge. Each device asks
> once before it first starts that row, and shows the command, the folder and the machine. Set
> `adds = false` to turn off every phone-added row on a machine.

### Reaching a durable agent (experimental)

Each durable agent a Collie runs beside its terminal is one entry in `sources.json`, written by
`collie durable attach` ([Durable agents](durable-agents.md#attach-a-durable-agent)). The first three
variables below are the older form, for a durable-only instance (`COLLIE_MUX=durable`) that drives
one durable agent, named `default`. Set the socket, or the URL with its token, never both.

| variable | example | what it means |
| --- | --- | --- |
| `COLLIE_DURABLE_SOCKET` | `/run/user/1000/durable/session.sock` | the durable agent's private Unix socket on this machine. Absolute, at most 103 bytes, mode `0600` |
| `COLLIE_DURABLE_URL` | `https://durable-member.example.com` | the address of a durable agent you deployed behind TLS. `https://` only, or `http://127.0.0.1:<port>` for a durable agent on this machine. At most 2048 bytes, no query |
| `COLLIE_DURABLE_TOKEN` | `your-32-byte-random-token-here` | the bearer token sent with every request to the URL. At least 32 bytes. A file holding it must be mode 600, and Collie never prints it |
| `COLLIE_PROGRAMS` | `off` | the kill switch for durable agents. The bridge ignores `sources.json`, logs one line and registers no durable agent, so the phone shows no Durable agents section. `collie doctor` and `collie durable list` say durable agents are off. Unset it, then `collie restart`, to bring them back. It does not turn off the env form above |

Both set, a URL without a token, or a token without a URL is a config error: the instance starts
and shows the durable agent as unreachable with that reason. Over https every poll is a billed request,
so Collie polls every 2 s while a phone watches and every 10 s otherwise.
[Durable agents](durable-agents.md#two-ways-to-reach-a-durable-agent) says what each way keeps out, and what
it does not.

### Starters from a durable agent (experimental)

A durable agent lists its starters on the New page that you open from it, under
**New conversation**. A starter is a named way to begin a conversation, such as a code review. It
takes no text: you tap it, and the durable agent decides what to start. The new conversation opens as a
pane. A tap repeated with the same request id opens the same conversation and starts nothing new,
and if the durable agent does not answer, **Try again** sends the same request id. A durable agent that cannot
be reached lists no starters. This is experimental and may change in any minor release.

### One-off commands and their history

A phone can also run a command that is not a launcher, once. Collie opens a shell in the folder you
name and types the line there, the same way it starts a launcher row. The line follows the same rule
as a free line: at most 200 characters, and no control, separator or bidi character. A one-off command
never starts on a new branch.

This is on by default, because a paired phone can already open a shell and type into it. Set
`run = false` in the `[phone]` table to remove the shortcut on that machine.

On the New page, switch to **Shell**. The **Command** select then ends with two additions: a
**Recent** group, which lists the lines in that machine's history, and **Type a command…**. Pick
**Type a command…** and a text field appears right under the select. Type the line and tap **Start**
(or the return key, which reads **Go**). The line above **Start** says what runs and where, for
example "Runs `htop` in ~/projects on bluefin". The worktree switch stays off for a one-off line.

Before the first run, Collie asks the machine to check the line. The check runs nothing and keeps
nothing. If the line carries a flag that skips permission prompts, such as
`--dangerously-skip-permissions`, this phone asks once before it starts, the same as for a row with
the "No prompts" badge. If the line breaks the rule above, a notice says why and nothing runs.

Pick a line from **Recent** to run it again. The **Folder** field fills with the folder that line last
ran in, unless you changed the folder yourself. While a line from **Recent** is chosen,
**Remove from history** and **Clear history** show under the select. **Clear history** asks first.
The **Again** row at the top of the page repeats a one-off run too. With `run = false`, the lines in
**Recent** stay in the list but are disabled, and **Type a command…** is gone. A machine older than
1.19.0 shows neither.

Each command that started is kept in that machine's state folder, in `commands-recent.json`. The file
keeps at most 12 lines, newest first, with the folder each one last ran in. Running a line again moves
it to the top. A line that seems to carry a secret, such as `TOKEN=abc deploy`, a URL with a
password, or a word like `token`, `secret` or `password`, still runs but is not kept. You can remove
one line, or clear the list, from the phone. With `run = false` the list
is still shown, but nothing in it starts. In a crew, each machine keeps its own list, and nothing is
copied between machines.

The list is not a permission. Starting a line from it is a new one-off run, which needs a paired
device, so unpairing or revoking a device leaves the list as it is. The audit log records the first
word of a one-off command and its length, never the whole line, because a line can hold a secret you
typed.

## Your own typefaces

The interface font is a per-device setting. Under **Settings → Appearance → Typeface**, you can choose between
System, Space Grotesk, Aldrich (the default), IBM Plex Sans, Geist and Atkinson Hyperlegible Next. A
[theme](themes.md) that names a face writes it here once, when you pick the theme. You can add custom fonts in
`theme.toml`, the fourth configuration file:

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

They appear below the shipped entries, and each client device selects its own.

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

## Favourite and recent folders

The New page lists the folders you started something in before, so you tap one instead of typing
a path.

Under the Folder field sit two lists for the machine the start goes to. **Recent** holds the last
8 folders something was started in, newest first. It counts only starts that worked and named a
folder, and it never lists your home dir, because a blank field already means home. A new branch's
own folder is not added, because it is a new checkout, not a place you return to.

You may also type a path. `~/projects` and `/srv/www` mean what they say. A name with no leading `/` or
`~`, such as `projects`, is a folder under your home, like `cd projects` in a fresh shell, and the
line above Start shows the full path (`~/projects`) before you tap. A path with `..` in it is refused.
The folder must already exist on the machine that runs the start, and it must be a directory. If it is
not there, nothing starts and a notice above Start says "There is no folder … on this machine." Collie
checks only when you tap Start, never while you type. On a crew, the machine you picked checks its own
disk.

A tap on a row fills the Folder field and starts nothing, so you can still change the choice above. The star
beside a row moves it to **Favourites**, up to 12, in the order you starred them. A second tap on the
star moves it back to the top of Recent.

**Browse** sits under the two lists. A tap on it lists the sub-folders of the folder in the field, or
of home when the field is blank. Tap a folder to go into it, and the field follows. **Up**, or a part
of the path above the list, goes back. A folder that is a Git repository carries a `git` badge.
**Use this folder** fills the field, like a tap on a Recent row.

When the field holds a path that does not exist, such as `~/src/plektra-`, Browse opens at the
nearest folder that does (`~/src`) and lists only the names that start with the rest (`plektra-`).
So typing in the field narrows the list. A path outside your home shows "Nothing to browse here".

Browse reads folder names only, under your home folder, with the limits of the Files view. It hides
dot-folders unless you type the dot, never lists `.git` or Collie's own state and config folders,
does not follow a link out of home, and shows at most 200 folders. It creates nothing, and it needs
a paired device, as Files does.

The list belongs to the machine, not to the phone. Each machine keeps its own in `folders.json` in
its state directory, `~/.local/state/collie/folders.json` unless `COLLIE_STATE_DIR` moves it. Every
device you use sees the same list, and the file appears only after the first start in a folder or
the first star. The same lists fill **Other folder** under **New worktree**, where they pick the
folder the branch's own folder goes in.

In a [crew](crew.md), each machine keeps the folders that exist on it, and the page shows the list
of the machine you picked. A machine that runs an older Collie has no list, and the page then shows
none for it. Browse lists the disk of the machine you picked too, and an older machine says it needs
an update.

## Secret masking

Collie masks known secret shapes in pane text before it reaches your phone.

```bash
# in your .env; the default is on
COLLIE_REDACT=off
```

| variable | default | what it does |
| --- | --- | --- |
| `COLLIE_REDACT` | `on` | Masks API keys, JWTs, PEM private keys, bearer tokens and `password=` values in the mirror, Chat, History, push notifications, file bodies in Files and diffs in Changes. `off` sends them as they are. |

In the config file this is `[access] redact`. The mask keeps the width of what it hides, so the
mirror's layout holds. It catches high-confidence shapes only; the limits are in
[Security](security.md#what-leaves-the-machine-is-masked).

In a crew, the lead also masks the text its members send, by its own setting. A member's text
reaches your phone unmasked only when the lead and that member both set `COLLIE_REDACT=off`.

## Multi-session

By default, one Collie instance serves every Herdr session it finds.

`COLLIE_MULTI_SESSION=on` (the default) discovers and serves every named Herdr session under your
config root, switchable from the header. Setting `COLLIE_MULTI_SESSION=off` serves only the primary
Herdr session. Every discovered Herdr session is accessible through the same URL, including private or sandbox
sessions. [Security](security.md) lists this behavior as a sharp edge.

## Usage windows

The dots beside the model show your 5-hour and 7-day limits for Claude and Codex, with no setup.

```bash
# turn every source off
COLLIE_ACCOUNT_WINDOWS=0
# turn on opencode and grok too, or name the ones you want
COLLIE_ACCOUNT_WINDOWS=all
COLLIE_ACCOUNT_WINDOWS=claude,codex
```

Collie reads your Claude login file on this machine and asks Anthropic's usage endpoint, the same
call Claude Code's /usage makes; nothing of the login is stored or sent elsewhere. Collie asks only
while a pane of that harness is open, and it skips a login file that others may read (anything
looser than `0600`) and a login that has expired. Codex sends no token: it reads its own files.

| form | what it turns on |
| --- | --- |
| unset, `1`, `on`, `true`, `yes` | the default set: `claude` and `codex` |
| `0`, `off`, `false`, `no` | nothing: no login or session file is read and nothing is asked |
| `all` | every source: `claude`, `codex`, `opencode` and `grok` |
| `claude,codex` | the harnesses you name, in any case and with spaces |

An id Collie does not know is dropped with a warning, and only the ids it knows are on, so a typo
never turns on a source you did not name. In the config file, `[bridge] account_windows` takes
`true` or `false`, a string with the same forms, or an array such as `["claude", "codex"]`.

Each source reads a different thing.

- **Claude, on by default.** Collie reads `~/.claude/.credentials.json`, or `$CLAUDE_CONFIG_DIR/.credentials.json`, and asks `api.anthropic.com`.
- **Codex, on by default.** Collie reads no login and asks nobody. On a ChatGPT login Codex writes the windows into its own session files (`$CODEX_HOME/sessions`, or `~/.codex/sessions`), and Collie reads the end of the newest files from the last two hours. A Codex on an API key has no windows to show.
- **OpenCode Go, off by default.** When you turn it on, Collie reads the `opencode-go` entry of OpenCode's login store (`~/.local/share/opencode/auth.json`, or under `$XDG_DATA_HOME`) and asks `opencode.ai`. With no Go entry it asks nothing.
- **Grok, off by default.** When you turn it on, Collie reads the login `grok login` keeps (`~/.grok/auth.json`, or under `$GROK_HOME`) and asks `cli-chat-proxy.grok.com` for your credits.

> **Note.** OpenCode Go and Grok follow the shape other tools use for these endpoints, and no live account has checked them yet. That is why they are off until you name them. pi and OMP show no windows here yet.

`collie doctor` shows every source in its `account-windows` row: on or off, the file it reads and the host it asks. [Terminals](multiplexers.md#collie-writes-hooks-into-claudes-own-settings) has the statusLine road.

## Dark mode / light mode

> **Note.** Collie follows your phone's appearance by default.

To pin it, open **Settings → Appearance**, find the **Appearance** card under the **Theme** card, and pick
**System**, **Light** or **Dark**. The [Theme](themes.md) card picks the colours; this card picks the light or
the dark half of them. The setting is
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

Enable it in **Settings → Device → Zen mode** (stored per device in the browser). This adds a **Zen mode**
option to the pane menu, under the ⋮ beside Find and History. Tapping it hides all Collie UI
elements: the header, tab and pane strips, agent statusline, and composer docks. Only the terminal
mirror remains visible. A floating button in the top-right corner or the Escape key restores the
interface.

Zen mode is **transient**. The configuration persists, but the active state resets when you switch
panes or reload the page. Panes always open with standard chrome.

The terminal mirror continues polling in Zen mode, and interactive buffer elements remain
functional. Prompt buttons, "Load older", and "Show entire history" controls stay available because
they are part of the content stream rather than chrome.

## Large screens

> **Note.** On a tablet or an open Fold the pane screen shows several panes side by side. A phone held upright and flat is not changed.

The layout turns on for the pane screen when the screen is at least 600 CSS pixels wide and at least
480 pixels tall. A phone held sideways is under 480 pixels tall, so it keeps the phone layout.
To switch it off, open **Settings → Appearance → Large-screen layout** and pick **Off**. **Auto**,
the default, turns it on where the screen is big enough. The choice is stored per device.

The layout has three parts.

- **The sidebar.** It lists your panes, the same list the pane switcher shows. The button in its top
  row folds it to a narrow rail of icons, and the choice is kept on this device. The ColliePWA mark
  in the top row goes home. **New space** and **Settings** sit at its foot.
- **The row of panes.** Each space keeps its own row, and the row scrolls sideways. Tap a pane in
  the sidebar to show it. Hold it (right-click with a mouse) for **Open here**, which replaces the
  pane you are in, or **Open beside**, which adds it next to that pane. You can also drag a pane
  into the row. **Remove from view** takes a pane out of the row. The agent keeps running.
- **The space header.** It holds the space's name, its tabs and a **+** for a new tab. Hold a tab
  (right-click with a mouse) to **Rename** it or **Close tab**, as on the phone. Closing the tab you
  work in moves you to a pane of the tab beside it. Its two buttons, or a vertical swipe, move to the space
  above or below.

Each pane has a width: **1/2**, **4/5** or **Full** of the row. A pane is never narrower than 360
pixels, so a width that would make it narrower is not offered. When the row cannot hold two panes at
that size, every pane is **Full** width and the control is hidden. The row snaps to the start of a
pane when you stop scrolling, and a scroll to the side never goes back a page in the browser. The row
always ends with **Add a pane**. It lists the panes of this space that the row does not show, each
with **Open here** (the pane becomes the last one in the row). It also offers **New agent in this
space**, which opens the New page on that pane's machine and folder and adds the agent as a new tab
of this space, next to the pane you are in, and **New agent in a new space**.

Every pane has its own belt, except when you hold a foldable like a laptop (see below). The pane you
work in has a frame and the reply box. A tap on another pane's belt acts on that pane and moves you
there. Tap the pane to move without acting.

The layout is kept on this device only, and Back and shared links work as before.

**Foldables.** On a foldable held half open, Chrome and Samsung Internet split the screen at the fold.
Held like a laptop, the conversation stays above the fold, and the belt and a taller reply box sit
below it. Only the pane you work in keeps its belt, below the fold. The other panes show Chat only.
This split applies at any width, so it also changes a half-open flip phone. The layout goes back to
flat while the keyboard is up. Held like a book, the split applies from 600 pixels wide. With two
panes, each half shows one pane and the sidebar becomes the rail. With one pane, the sidebar stays
open in one half and the pane fills the other. Other browsers show the flat layout only.

### Pane navigation

A gesture moves you between panes and spaces, on a phone and in the large-screen layout. Left and
right go to the previous and next pane of the space, in the switcher's order. Up and down go to the
previous and next space. At the first or last pane or space, a move stays put. Choose the method in
**Settings → Appearance → Pane navigation**. A change shows the next time a pane opens.

| Method          | How it works                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Two fingers** | The default. Hold one finger still on the chat or the terminal, then put a second finger down. The phone buzzes and a box shows where you are. Swipe with the second finger: a short swipe is one step, a long one takes more. Lift the second finger, then the first, to go there. |
| **Joystick**    | Hold the handle just above the belt, then drag the same finger. Let go on another pane to go there, or back where you started to stay. On a phone, a quick drag up opens the pane switcher.                                                                                         |
| **Off**         | No gesture. The pane switcher still moves you, and on a large screen so do the sidebar and the space header.                                                                                                                                                                        |

The box names the pane you are moving to, with its status, its space and its place in the space,
above a map of the spaces. You stay where you are when you lift the first finger with no swipe, lift
it while the second finger is still down, or put a third finger down. Nothing under your fingers is
tapped when they lift. The first time the gesture starts on a device, a short notice above the belt
says how it works and where to turn it off.

The gesture keeps the page's own touches. One finger held alone does nothing new: a long press still
selects text and opens its menu. A pinch still zooms, because a second finger that lands within the
first 300 ms counts as a pinch. A finger that was scrolling, or that starts at the left or right
edge of the screen where the phone's own back gesture lives, never starts the gesture. From the
moment the second finger lands until you lift the first, the page holds off selection and scrolling,
and a selection you made earlier is cleared. Pane navigation is touch only, and a mouse does nothing
here. With TalkBack on, the gesture should do nothing, because TalkBack takes two-finger swipes for
itself; the pane switcher still moves you.

## Chat view

> **Note.** Chat is the default view of an agent pane since 1.17.0. Terminal is one tap away.

An agent pane opens in **Chat**. Chat draws the agent's own conversation instead of the terminal:
your turns, its replies, thinking behind a fold and a card per step. The composer,
the belt and the pane menu stay where they were. To read the terminal instead, open the pane's **⋮**
menu and tap **Terminal view**. The choice is one setting for the whole device, stored in the
browser, and a device that already chose the terminal keeps it. **Chat view** in the same menu
switches back.

When you queue a message while Claude Code works, Chat shows it on a **Waiting to send** card, and
the card's **Send now** button sends the whole queue to the running turn at once. Only Claude Code
offers it, because the button presses Ctrl+Enter, the key that agent defines for this. The button is
hidden on a read-only device and on a saved copy.

The display gear has a **Stretchtext replies** switch, off by default. With it on, Chat, the full reply card and History show a reply written with the cc-stretch plugin as its short form, and a tap on a phrase opens it. A `{{name}}` without a bar shows as `name`.

One thing in Chat is known to be incomplete. Hermes can remove a turn from its log after Collie
read it, for example when it compacts. Chat then keeps showing that turn until the session is read
again. The terminal never has this problem.

Chat reads the agent's session log, not the screen. That means a pane gets Chat only when Collie
knows which session the pane is running, and the agent has to tell the multiplexer. The pane itself
cannot work this out.

| Multiplexer | What reports the session | Chat works for |
| --- | --- | --- |
| Herdr | The matching Herdr integration for that agent, installed once with `herdr integration install <agent>` (for example `claude`, `codex`, `opencode`, `pi`, `omp`, `grok`, `hermes`), then restart the agent | Every agent that has an integration and a session log Collie reads |
| tmux, zellij, Tern (experimental) | Collie's [beacon hooks](multiplexers.md#agent-beacons-optional-linux) | Claude Code only, after `collie hooks install claude` |
| tuios | The tuios daemon | The agents the daemon reports |

OpenClaw needs no Herdr integration for Chat. Herdr does not pass an OpenClaw session on, so Collie
reads the session name off the footer of `openclaw tui` (`agent main (main) | session work | …`) and
opens that agent's session database under `$OPENCLAW_STATE_DIR`, or `~/.openclaw`, read-only. Set
`openclaw_root` when the state folder is somewhere else. The pane must report itself to Herdr as
agent `openclaw`. Collie never reads OpenClaw's config file or its gateway token.

Kiro needs no Herdr integration either: Herdr names a `kiro-cli` pane agent `kiro`, and Collie finds
the pane's session by the lock the running Kiro holds in it. Collie reads Kiro V3 sessions, started
with `--v3` or `--agent-engine v3`, or with V3 set as the engine in Kiro's own settings. A V1 or V2
session has no Chat or History. Set `kiro_root` when Kiro keeps its sessions somewhere else.

`herdr integration status` shows which integrations are installed. A hook is read when the agent
starts, so an agent that was already running when you installed it needs a restart. Oh My Pi is the
`omp` integration, not the `pi` one: they are two agents with two hooks, and they share one log
format.

A new agent pane shows Chat at once, before it has anything to read, with one line: "Send a
message to start". Codex reports its session only after your first message, and pi writes its log
only after its first reply, so both start this way. The conversation appears as soon as there is one.

A pane falls back to the terminal when something happens that Chat cannot show: the agent asks you a
question before there is anything to read, or its first turn ends and it still has no session, or no
log file to read. The terminal then shows a line that names what is missing, and the **⋮** row says
why. A first turn that runs for a minute with nothing to read and no other sign also falls back. A pane that was already busy when you first opened it, with no session, shows the terminal at
once. When the session or the log arrives later, the pane goes back to Chat. Chat never hides the
row, so you can tell a missing hook from a missing feature. `collie doctor` lists those
panes under `agent-sessions` and names the integration line (`integration-<agent>`) that fixes each.
The [troubleshooting page](troubleshooting.md) has the steps, under **a pane has no Chat or History**.

## Reading offline

When the bridge is out of reach, the phone shows the last copy it saved, and you can read it but not act on it.

The phone keeps two things for each pane: the last terminal text it saw, and the newest Chat turns as
Chat drew them. It never keeps the raw terminal screen as Chat. When you open Collie and the bridge
does not answer within about a second and a half, the phone draws this saved copy at once, and
replaces it with live data when the bridge answers.

A saved copy looks different from a live screen:

- The agent list is dimmed, each status is in the past tense ("was working", "needed you"), and the
  header shows **as of** and the time it was saved.
- A Chat pane shows "Saved copy from" and the time. The bridge still holds the older turns.
- Prompt buttons, cards and the send button are off. A tap on a saved copy cannot reach the agent.

The connection bar names one of three causes:

| Bar | Cause | What the phone shows |
| --- | --- | --- |
| You are offline | The phone says it has no network | The saved copy, with its time |
| No connection to the bridge. Check your connection or Tailscale. | Any other read that failed | The saved copy, with its time |
| Pair screen | The bridge refused this device: not paired, revoked or expired | Nothing saved. The refusal deletes the copy |

A VPN such as Tailscale keeps the phone's network flag on in airplane mode, so the bar cannot always
tell "no network" from "the bridge is down". It then says only that the bridge does not answer.

While the app is open, the bar and the saved copy appear on the first poll that gets no answer. A
poll waits at most 6 seconds, one second longer than the bridge waits for the multiplexer. A server
error (5xx) counts on the second one in a row. What is on screen stays there, and the first live
answer brings back the live view.

Right after you return to the app, the first poll that gets no answer does not count alone. A
Tailscale link can need a moment to come back, so the phone asks again half a second later, and
shows the bar only when that poll gets no answer too.

**Keep chat on this phone**, in **Settings → Device**, sets how long the Chat turns stay on the phone:

| Value | What it does |
| --- | --- |
| Off | Keeps no Chat turns, and deletes the ones already kept |
| 1 day | The default |
| 7 days | Keeps them for a week |

The terminal text has its own lifetime of 24 hours, and this setting does not change it. In the
terminal view, the only offline copy is that terminal text.

> **Note.** The phone keeps only text the bridge already masked, and drops a pane's copy while the
> pane asks for a password. [What the phone keeps](security.md#what-the-phone-keeps) lists every
> item, its size bound and its lifetime.

## Changes

The [Files screen](changes.md) shows what an agent changed in its workspace's git repos, under its
**Changes** segment. Two per-device settings decide how far it looks for repos, in **Settings → Device → Changes**:

| Setting | Default | What it does |
| --- | --- | --- |
| Look for repos inside this folder | on | Also lists repos in folders below the workspace folder, even ones the parent repo ignores |
| How deep to look | 2 | How many folder levels below the workspace folder the search goes, 1 to 4 |

See [Which folder, and which repos](changes.md#which-folder-and-which-repos) for how the search works.

## Language

Collie's interface is available in twelve languages. Configure this under **Settings → Appearance → Language**.

- English
- Deutsch
- Español
- 한국어
- 日本語
- 中文
- Русский
- Italiano
- Français
- Português
- Türkçe

The selection is saved locally in the browser per device. The terminal mirror remains untranslated:
it displays the raw output from the agent, while quick replies, menu labels, and key caps match the
underlying screen or keyboard names.

A notification's title follows the same choice: "claude needs you" arrives as "claude 입력 대기" on a
device set to Korean. The device picks up a new choice the next time Collie is open on it, and until
then its titles stay in the language it had. The body under the title is the pane's own name and
place, and is never translated ([Web Push](voice-and-push.md#web-push-optional)).


---

[← back to the README](../README.md)
