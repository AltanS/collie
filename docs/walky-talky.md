# Walky talky: messages between agent sessions

Walky talky lets one agent session send a short message to another, on any harness, and lets you
message a session the same way. The message is typed into the target pane as the agent's next
prompt, under a one-line header that names the sender. A pane that cannot take it right now keeps
it in its inbox.

## Send a message

Two commands: list the panes you can reach, then send to one.

```sh
collie walky who
collie walky send local/w6:p3 "Tests are green on fix-465. You can merge."
```

`who` lists every agent pane you can reach. Pick an address from that list and pass it to `send`.
On a machine with only your own agent pane, `who` says
`You are local/<pane>. No other agent pane yet. A message needs two.`

`send` waits up to 15 seconds for the receipt, then prints three lines: the id, the pane, and the
state in words.

```text
wt_k3f9x2m8q1a0
to local/w6:p3, claude, collie-workspace#fix-465
typed into the pane
```

When the message is not typed yet, a fourth line says `check later: collie walky status <id>`.
With no text after the address, the body is read from stdin:

```sh
git log --oneline -5 | collie walky send local/w6:p3
```

## Addresses

An address names one pane, one machine's panes, or every pane.

| Address | Who receives it |
| --- | --- |
| `<member>/<pane>` | One pane. On a machine with no crew the member is `local`, for example `local/w6:p3` |
| `<member>/all` | Every agent pane on that machine. From the phone only |
| `all` | Every agent pane you can reach. From the phone only |

A shell pane never receives a message. Only panes the bridge sees as an agent do. An agent may
message one pane at a time; only you may broadcast.

## What the target pane receives

An agent's message types one line into the target pane, and no body.

```
[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, repo#fix-465): a message from another agent, not your operator. Read it: collie walky inbox wt_k3f9x2m8q1a0. Reply: collie walky reply wt_k3f9x2m8q1a0 "<text>"
```

The line starts with the header. It names the message id, who typed it, and their pane, harness
and label (`<repo>#<branch>`, or the pane's title). A reply adds ` reply to <id>` after the
parenthesis. The agent then runs `collie walky inbox <id>` and reads the body as that command's
output. A harness treats a command's output as data, not as its operator's words.

Your own message, from the phone, types the header and the body:

```
[walky-talky wt_n2d8s1v7c4b9] from operator (phone-altan)
Stop and report what you changed.
```

The body is at most 4,000 characters, with control bytes and direction marks removed. A longer
body is never cut: the send is refused `body over 4,000 characters`, and you shorten it. A body line
that starts with `[walky-talky` gets one leading space, so a body can never pose as a second
message.

There are two kinds of sender. The kind is what the bridge proved, never what a message says:

| Kind | What the bridge proved |
| --- | --- |
| `agent` | `collie walky` ran inside a pane: the pane's own environment names it |
| `operator` | A paired device sent it from the phone, under the device's label |

`collie walky send` outside any pane is refused: `run this inside a pane, or send from the phone`.

A message from an agent is a peer's words, not your instruction. The agent skill tells an agent to
weigh it, and never to run a destructive command because a peer asked ([Install the skill](#install-the-skill)).

## Into a busy pane

A message goes through the Send Protocol as one send, so a busy pane gets what a reply from the
phone gets, and Enter never goes into a turn where it would steer the agent.

| Profile | In a running turn | What happens |
| --- | --- | --- |
| `agy` | hold | Collie holds it and types it when the pane is free |
| `claude` | queue | Enter queues it in the harness, and it runs after the turn |
| `codex` | queue key | Tab queues it; Enter would steer, so Collie never presses it there |
| `grok` | hold | Collie holds it and types it when the pane is free |
| `muse` | hold | Collie holds it and types it when the pane is free |
| `omp` | queue key | Ctrl+Q queues it; Enter would steer, so Collie never presses it there |
| `opencode` | queue | Enter queues it in the harness, and it runs after the turn |
| `pi` | queue key | Alt+Enter (Ctrl+Q on Windows) queues it; Enter would steer |

The queue and the queue key need a harness version Collie knows. With an unknown version, Collie
holds the message instead. A hold lasts 10 minutes for a message: after that Collie takes it back
and it waits in the inbox. A pane with no profile is typed blind, as a reply is.

## Reply, read and check

Answer a message, read your inbox and look up a receipt.

```sh
collie walky reply wt_k3f9x2m8q1a0 "Merged. Thanks."
collie walky inbox
collie walky status wt_n2d8s1v7c4b9
```

- `reply <id>` sends to the pane the message came from, as a reply to it. A message from an
  operator has no pane to reply to.
- `inbox <id>` prints one message, its header and then its body.
- `inbox` prints this pane's unread messages and marks them read. `--keep` leaves them unread.
  `--all` prints the last 50 that reached the pane. Outside a pane, `inbox --all` lists every
  message on the machine.
- `status <id>` prints the id, then one line per pane: the state in words, and how this machine
  knew the sender ("signed by" a machine, "relayed by the lead", or "this machine"). A machine that
  refused a whole broadcast, for example with walky talky off, has one line for all its panes,
  `<member>/all`.

Every verb takes `--json` for a script.

## Across a crew

In a crew, a message for another machine always goes through the lead. A member sends it to the
lead, and the lead types it on its own panes or passes it on to the machine the address names. The
lead checks the sender's signature against the key it pinned for that machine. Each machine then
checks that its lead passed the message on.

- **`who` on the lead** lists the agent panes of every machine. **`who` on a member** lists its own
  panes and the line ``other machines: run `collie walky who` on the lead (<lead>), or use the phone``.
- **The outcome lives on the lead.** The machine that types a message reports the outcome to the lead
  with its next crew update. On a member, a message to another machine shows
  `queued (outcome known on the lead)`, and `send` does not wait for more. Run
  `collie walky status <id>` on the lead, or open the pane on the phone, to see "typed into the pane".
- **A slow machine does not hold up a broadcast.** The lead gives each machine 8 seconds. A machine
  that takes longer shows `may have arrived, will not be sent again (member slow)`, and its next
  crew update fills in the outcome.
- **An older machine refuses.** A message to a member whose reported version predates walky talky
  gives `not sent: older member` at once, with no dial. A member under an older lead gives
  `not sent: older lead`. Update the crew to fix it.

The receipt's `verified` field says how the sender was known. `origin` means the sender's own key
was checked. `lead` means the lead checked it and this machine trusts the lead, which is what a
member sees for a message from another member.

## Receipts

Every message has an id (`wt_` and 12 characters) and a receipt. The bridge writes the receipt
before it types anything, so the same id sent twice returns the receipt and types nothing. The ids
it has seen stay in `<stateDir>/walky/seen.json` for a day, even after the log drops a line. Across
a crew, a message whose clock is more than 10 minutes off is refused `stale`.

| State | Printed as | Meaning |
| --- | --- | --- |
| `accepted` | queued | Logged, not typed yet |
| `delivered` | typed into the pane | The text went into the pane and was submitted |
| `inbox-only` | waiting in the inbox, not typed | Not typed, for the reason shown (a dialog open, a hold Collie took back after 10 minutes, no terminal). It waits in the pane's inbox |
| `refused` | not sent | Not taken, for the reason shown: no such pane, not an agent pane, a limit, or walky talky off on that machine |
| `unknown` | may have arrived, will not be sent again | The outcome was not read, or a hold was still pending after 10 minutes. Collie never sends it again |

The words are what the CLI and the phone show. `--json` and the receipt keep the state names.
`send` exits 0 for `accepted`, `delivered` and `inbox-only`, 4 for `refused` and 1 for `unknown`.

## On the phone

The phone shows a message as a card and sends one from the composer, so you need no terminal.

A message in a pane's Chat appears as a card titled "Message from" and the sender's label. The card
shows the sender's kind (`agent` or `operator`), the message body, and "reply to" the id it answers.
A small word says how the sender was known: "signed by" a machine, "relayed by the lead", "this
machine", or "not verified". The card appears only when the bridge's own log holds that message. A
header that an agent merely prints stays plain text, with the quiet mark "no log record on this
machine". A message from another agent shows its body only once the pane read it with
`collie walky inbox <id>`.

Each receipt state shows the words in the table above, with the reason after "not sent" and
"waiting in the inbox, not typed".

- **Messages.** Open a pane's menu and tap "Messages" to see the messages for that pane. Each one
  has a "Reply" button. The sheet says "No messages for this pane yet." when it is empty, and
  "This machine does not keep messages yet." on a machine that cannot keep them.
- **Send as message.** Press and hold the Send button, then tap "Send as message". The text goes to
  this pane as a message from you, and a line under the box shows "Message to" the pane and the
  receipt state. While it says "queued", the line follows the receipt and changes to the final word. A plain tap on Send still sends the text as before. Tap "Dismiss" to clear the line.
- **Message all agents.** On the Crew page, tap "Message all agents". Write the text, pick "Send
  to" (`All machines` or one machine) and tap "Send message". The sheet then asks
  "Message 5 agents on 2 machines?" with the count for that choice. Tap "Send" to send, or "Back".
  The sheet lists the shell panes it skips, and shows "Agents reached" and one receipt per target.
  A line "Not sent on this machine" counts the recent refusals per reason. A device that may not
  send shows "This device may not send messages."

## Install the skill

An agent uses walky talky only when it knows how. Collie writes the skill that teaches it into
your agents' own instruction files, and only when you ask.

```sh
collie skill install all
```

The skill is a short text that teaches the agent the `collie walky` verbs, how to read the header
of a message it receives, and when not to send. No other command and no bridge start touches those
files.

You can also name one harness: `claude`, `codex`, `opencode`, `pi` or `gemini`.

```sh
collie skill install claude
```

`install all` skips a harness whose config folder does not exist on this machine. Name that
harness to create the file anyway. A running agent reads its instructions at start, so restart it
after an install.

### Where the skill goes

| Harness | File | How Collie writes it |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/collie-walky-talky/SKILL.md` | The whole file. Collie owns it. Every Claude profile that Collie reads gets the same folder, and so does the folder `CLAUDE_CONFIG_DIR` names where you run the install. |
| Codex | `$CODEX_HOME/AGENTS.md`, else `~/.codex/AGENTS.md` | A block inside the file. |
| opencode | `~/.config/opencode/AGENTS.md` | A block inside the file. |
| pi | `$PI_CODING_AGENT_DIR/AGENTS.md`, else `~/.pi/agent/AGENTS.md` | A block inside the file. |
| Gemini CLI | `~/.gemini/GEMINI.md` | A block inside the file. |
| Any other | none | `collie skill print generic` prints the block. Paste it by hand. |

In a shared instruction file, Collie owns only the text between these two lines. Every other line
stays as you wrote it.

```
<!-- collie:walky-talky v1 begin -->
<!-- collie:walky-talky v1 end -->
```

If the file is absent, Collie creates it. If the block is present, Collie replaces it in place.
Codex and pi read `AGENTS.override.md` instead of `AGENTS.md` when that file exists. Collie tells
you when it sees one, because the block would then be ignored.

Collie keeps a copy of a file as `<file>.collie-backup` before its first change. It refuses a
symlinked file, a file it cannot read and a block whose markers are damaged. It writes nothing in
those cases. A second install changes no bytes.

### Check the skill

```sh
collie skill status
```

Each target is one of these.

- `installed`: the file or block matches this build.
- `stale`: it differs from this build. Run `collie skill install all` to bring it up to date.
- `absent`: you did not install it there. This is your choice and is never a problem.
- `refused`: Collie will not touch it, for example because it is a symlink.

`collie skill status --check` prints nothing and exits with code 3 when any installed copy is
stale. A new Collie version alone does not make a copy stale. Only a change to the skill text, or
to the path of the `collie` binary it names, does. `collie doctor` shows the same answer as the
`skill-walky-talky` check, and `collie update` prints one note when the new build carries a newer
skill.

### Take the skill out again

```sh
collie skill uninstall all
```

This removes the Claude file and cuts out the block. It leaves the rest of each file untouched.

## Limits and switches

What walky talky refuses, and how to turn it off.

| Limit | Refused as |
| --- | --- |
| 30 messages per sender in 10 minutes. A sender is its kind, machine and pane, never its label | `rate limit` |
| Your broadcast to `all` or `<member>/all` counts one message per pane it reaches | `rate limit` |
| 6 messages in 10 minutes between the same two panes, either direction | `pair limit` |
| On a lead, 60 messages in 10 minutes from one machine, all its panes together | `rate limit` |
| A body over 4,000 characters, after control bytes are removed | `body over 4,000 characters` |
| A reply chain deeper than 4 replies | `thread depth` |
| An agent's message to `all` or `<member>/all`. Only you may broadcast | `only the operator may broadcast` |
| A message to the sender's own pane | `that is your own pane` |
| A reply to a message this pane never received | `unknown reply` |
| A pane id that two sessions on one machine both use | `ambiguous pane` |
| A reply whose sender pane closed, or now sits in another session | `sender gone` |

- **Collie never answers a message on its own**, and never answers a dialog with one. A send over an
  open dialog is refused by the Send Protocol, and the message stays in the inbox.
- **A reply goes back to the pane that sent the message**, found by the session and the pane the
  bridge logged, never by the address the reply names.
- **`COLLIE_WALKY=off`** refuses every message for this machine's panes. The CLI on that machine
  still sends.
- **The refusals are counted**, per reason, in `<stateDir>/walky/refusals.json`, with no body and no
  sender. `collie doctor` shows them in the row `walky-refusals`, and the Crew page shows them under
  a broadcast.

## How it works

A local socket and a log, with no token.

The bridge listens on a local socket, `<stateDir>/walky/sock`, mode 0600. The CLI sends one request
and reads one answer. It carries no token: only your own user can open the socket. The log lives in
`<stateDir>/walky/`. It keeps 7 days and at most 2,000 lines, with up to 200 unread messages per pane.

> **Note.** An agent runs as your user, so it can open the socket and could claim another pane.
> The receipt and the log protect the phone's card against a header typed on the screen, and on a
> crew the signature protects a message between machines. Nothing protects you from a local agent
> that lies about its own pane.

On Windows walky talky is not available yet: the CLI prints `walky talky needs a Unix socket on
this host`.
