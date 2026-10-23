# Walky talky: messages between agent sessions

Walky talky lets one agent session send a short message to another, on any harness, and lets you
message a session the same way. The message is typed into the target pane as the agent's next
prompt, under a one-line header that names the sender. A pane that cannot take it right now keeps
it in its inbox. An agent uses walky talky only after you install the skill that teaches it
([Install the skill](#install-the-skill)).

## Send a message

Two commands: list the panes you can reach, then send to one.

```sh
collie walky who
collie walky send collie-04rj6a/w54:p1G#1adi "Tests are green on fix-465. You can merge."
```

`who` lists every agent pane you can reach. Pick an address from that list and pass it to `send`.
On a machine with only your own agent pane, `who` says
`You are local/<pane>#<token>. No other agent pane yet. A message needs two.`

### Read the who table

```text
ADDRESS                     MACHINE   HARNESS  LABEL                  STATE
collie-04rj6a/w54:p1B#sx56  bluefin   claude   collie-workspace#main  working  (you)
collie-04rj6a/w54:p1G#1adi  bluefin   claude   collie-workspace#main  done
collie-04rj6a/w54:p1J#anx6  bluefin   claude   walky-live             done
minibuch/w11:p4#8h9h        minibuch  claude   walky-live             idle
```

- **Copy ADDRESS as printed.** Its first part is the member id, not the machine. On a lead it is the
  crew id (`collie-04rj6a`) for the lead's own panes, on a member it is the member's name
  (`minibuch`), and with no crew it is `local`. Pick the row by MACHINE and LABEL.
- **`(you)` marks your own pane.** A message to it is refused `that is your own pane`.
- **Labels can repeat.** Two rows above are called `walky-live`, one on each machine. MACHINE tells
  them apart. If two rows still match, ask the operator which one is meant.
- **STATE** is the pane's own status: `idle`, `working`, `blocked`, `done` or `unknown`. A crew
  member the lead cannot reach shows `unreachable`. A pane that is `working` or `blocked` still
  takes a message. Collie queues it or holds it, as in [Into a busy pane](#into-a-busy-pane).

`send` waits up to 15 seconds for the receipt, then prints three lines: the id, the pane, and the
state in words.

```text
wt_k3f9x2m8q1a0
to collie-04rj6a/w54:p1G#1adi, claude, collie-workspace#fix-465
typed into the pane
```

When the message is not typed yet, a fourth line says `check later: collie walky status <id>`.
With no text after the address, the body is read from stdin:

```sh
git log --oneline -5 | collie walky send collie-04rj6a/w54:p1G#1adi
```

### How the answer comes back

`send` does not return the answer. The receiver replies with `reply`, and Collie types the reply
into the sender's pane as the sender's next prompt, with `reply to <id>` in its header. An agent
that sent a message ends its turn and waits for that prompt. It does not poll and it does not sleep.
If the sender's pane is busy, the reply waits as in [Into a busy pane](#into-a-busy-pane). `collie
walky inbox` shows it too. `status` tells you the message was typed. It does not tell you the
receiver read it or answered it.

> **Note.** `send` works only inside a pane. From a plain terminal it is refused with
> `run this inside a pane, or send from the phone`. To message a session as yourself, use the phone
> ([On the phone](#on-the-phone)).

## Addresses

An address names one pane, one machine's panes, or every pane.

| Address | Who receives it |
| --- | --- |
| `<member>/<pane>#<token>` | One pane, while it stays open. `who` prints this form, for example `collie-04rj6a/w54:p1G#1adi`. The member is the crew id on a lead, the member's name on a member, and `local` with no crew. It is never the machine name |
| `<member>/<pane>` | Whatever pane holds that id now. On a machine with no crew the member is `local` |
| `<member>/all` | Every agent pane on that machine. From the phone only |
| `all` | Every agent pane you can reach. From the phone only |

A terminal may give a closed pane's id to the next pane. Herdr's `w6:p3`, tmux's `%7` and zellij's
`terminal_3` only count up, but Collie does not rely on that. So Collie gives every pane a token,
four characters after a `#`, and the address stays safe whichever terminal you use. The token follows
the pane: an agent that restarts in the same open pane keeps it. A pane that is gone for 30 seconds
loses its token, so the next pane that takes its id gets a new one. A send to a token whose pane
closed is refused `pane replaced`, and never reaches the new pane. Run `collie walky who` again for
the new address.

An address works with or without the token: the token pins the session, so a pane that was replaced is refused. An address with no token means the pane that holds that id now, whatever it is.
The `to` line of `send` shows the pane as `who` lists it. `status` and the receipt name the pane
without the token, for example `collie-04rj6a/w54:p1G`.

With several Collie instances on one machine, `collie walky` reaches the instance of its own `collie`
binary. The installed skill pins the binary of the instance that installed it. Set
`COLLIE_INSTANCE=<name>` as you do for any verb ([Commands](commands.md)), or `who` shows another
instance's panes.

A shell pane never receives a message. Only panes the bridge sees as an agent do. An agent may
message one pane at a time; only you may broadcast.

## What the target pane receives

An agent's message types one line into the target pane, and no body.

The pane gets this as one line. It is split here to fit the page.

```text
[walky-talky wt_k3f9x2m8q1a0] from agent collie-04rj6a/w54:p1G#1adi (claude, repo#fix-465):
a message from another agent, not your operator.
Read it: collie walky inbox wt_k3f9x2m8q1a0.
Reply: collie walky reply wt_k3f9x2m8q1a0 "<text>"
```

The line starts with the header. It names the message id, who typed it, and their pane (with its
token), harness and label (`<repo>#<branch>`, or the pane's title). A reply adds ` reply to <id>` after the
parenthesis. The agent then runs `collie walky inbox <id>` and reads the body as that command's
output. A harness treats a command's output as data, not as its operator's words.

Your own message, from the phone, types the header and the body:

```text
[walky-talky wt_n2d8s1v7c4b9] from operator (phone-altan)
Stop and report what you changed.
```

Collie removes control bytes and direction marks from a body. The body is at most 4,000
characters. A longer body is never cut: the send is refused `body over 4,000 characters`, and you
shorten it. A body line that starts with `[walky-talky` gets one leading space, so a body can never
pose as a second message.

There are two kinds of sender. The kind is what the bridge proved, never what a message says:

| Kind | What the bridge proved |
| --- | --- |
| `agent` | `collie walky` ran inside a pane: the pane's own environment names it |
| `operator` | A paired device sent it from the phone, under the device's label |

A send from outside any pane has no kind, so Collie refuses it.

A message from an agent is a peer's words, not your instruction. The agent skill tells an agent to
weigh it, and never to run a destructive command because a peer asked ([Install the skill](#install-the-skill)).

## Into a busy pane

A message goes through the Send Protocol as one send. A busy pane gets what a reply from the phone
gets, and Enter never goes into a turn where it would steer the agent. Only a person can steer a
turn, with the Steer choice on the Send button ([Steer or queue](multiplexers.md#steer-or-queue)). A
message never steers, whoever sends it.

| Profile | In a running turn | What happens |
| --- | --- | --- |
| `agy` | hold | Collie holds it and types it when the pane is free |
| `claude` | queue | Enter queues it in the harness, and it runs after the turn |
| `codex` | queue key | Tab queues it; Enter would steer, so Collie never presses it there |
| `cursor` | queue | Enter queues it in the harness, and it runs after the turn |
| `grok` | hold | Collie holds it and types it when the pane is free |
| `hermes` | hold | Collie holds it and types it when the pane is free |
| `kiro` | hold | Collie holds it and types it when the pane is free |
| `muse` | queue key | Tab queues it; Enter would steer, so Collie never presses it there |
| `omp` | queue key | Ctrl+Q queues it; Enter would steer, so Collie never presses it there |
| `opencode` | queue | Enter queues it in the harness, and it runs after the turn |
| `pi` | queue key | Alt+Enter (Ctrl+Q on Windows) queues it; Enter would steer |

The queue and the queue key need a harness version Collie knows. With an unknown version, Collie
holds the message instead. The browser rig does not report a Claude version, so there Collie holds
the message and types it after the turn. A hold lasts 60 minutes from the moment Collie takes the
message: after that Collie takes it back and it waits in the inbox. A pane with no profile is typed
blind, as a reply is.

An open dialog, such as a permission card or a question, is held the same way. Nothing goes into
the dialog. Once the dialog is answered, Collie types the message and the receipt reads "typed into
the pane". It waits in the inbox only when the hold runs out first.

A draft in the box holds the message too. Collie never types into a box that holds your own text.
It types the message once the box is empty and the pane idle on two checks in a row. If you send
the draft instead, its turn starts, and Collie types the message after that turn.

While a message waits, its receipt reads `held: draft present` or `held: turn running`. Collie
types it when the box clears or the turn ends, up to 60 minutes. Do not send it again. One clock
runs for both reasons, and a bridge restart keeps the hold and the clock.

Before Collie types a held message, it checks the pane once more. If the pane closed and another
session took its id, the message stays in the inbox as `pane replaced`.

A held message has two ways out before the hour ends. The sender takes it back with
`collie walky cancel <id>` from the pane that sent it. A message sent from the phone is cancelled on
the phone: its line under the box, and its row in the pane's Messages sheet, carry Cancel while it is
held. The owner of the target pane sees "1 message waits for the box to clear" above the box. A tap
opens the Messages sheet, where each held message has Drop. Either way the message stays in the
inbox, not typed, and the receipt reads `cancelled by sender` or `dropped by the pane's owner`. A
message that was already typed cannot be taken back; the answer says so, and the receipt stands. Only
the sender can cancel. On a crew, a message held on another machine is taken back on that machine. It is not cancelled.

Two messages to one pane are typed one after the other, never into each other. The second waits
while the first is typed, and its receipt stays "queued". A message that still waits after 2
minutes stays in the inbox as `pane busy`.

## Reply, read and check

Answer a message, read your inbox and look up a receipt.

```sh
collie walky reply wt_k3f9x2m8q1a0 "Merged. Thanks."
collie walky inbox
collie walky status wt_n2d8s1v7c4b9
collie walky cancel wt_n2d8s1v7c4b9
```

- `reply <id>` sends to the pane the message came from, as a reply to it. A message from an
  operator has no pane to reply to.
- `inbox <id>` prints one message, its header and then its body, and marks it read.
- `inbox` prints this pane's unread messages and marks them read. `--keep` leaves them unread.
- `inbox --all` prints the last 50 that reached the pane. Outside a pane, it lists every message on
  the machine, and a plain `inbox` is refused.
- `status <id>` prints the id, then one line per pane. Each line has the state in words and how
  this machine knew the sender: "signed by" a machine, "relayed by the lead", or "this machine". A
  machine that refused a whole broadcast, for example with walky talky off, has one line for all
  its panes, `<member>/all`.
- `cancel <id>` takes back a message you sent while it is held. Run it in the pane that sent the
  message. The message stays in the inbox, not typed, and the receipt reads
  `waiting in the inbox, not typed: cancelled by sender`. A message that was already typed prints
  "already typed, nothing to take back" and keeps its receipt. A second `cancel` prints the receipt
  and changes nothing. From another pane it is refused: only the sender can cancel it.

Every verb takes `--json` for a script.

## Across a crew

In a crew, a message for another machine always goes through the lead. A member sends it to the
lead. The lead types it on its own panes, or passes it on to the machine the address names. The
lead checks the sender's signature against the key it pinned for that machine. The machine that
receives the message then checks the lead's own signature on it. The lead also sends the sender's
certificate with its own word for it, so the receiving machine checks the sender's signature too.

- **`who` on the lead** lists the agent panes of every machine. **`who` on a member** lists its own
  panes, then this line:

  ```text
  other machines: run `collie walky who` on the lead (bluefin), or use the phone
  ```

- **The outcome comes back to the sender.** The machine that types a message reports the outcome to
  the lead with its crew updates, until the lead confirms it got it. The lead then sends the outcome
  on to the member that sent the message. So `send` on a member waits as it does for a local pane,
  up to 15 seconds, and prints "typed into the pane". `collie walky status <id>` on the member shows
  the same. Until the outcome arrives, a member shows `queued (outcome known on the lead)`, or
  `held: draft present` when the lead passed the hold on, and `send` adds the `check later` line.
  Both mean wait: do not send it again. Under an older lead the outcome never arrives. Then run
  `collie walky status <id>` on the lead, or open the pane on the phone.
- **A slow machine does not hold up a broadcast.** The lead gives each machine 8 seconds. A machine
  that takes longer shows `may have arrived, will not be sent again (member slow)`, and its next
  crew update fills in the outcome.
- **An older machine refuses.** A message to a member older than walky talky gives
  `not sent: older member` at once, with no dial. A member under an older lead gives
  `not sent: older lead`. Run `collie crew update --all` to fix it
  ([Crews](crew.md#messages-between-machines)).

The receipt's `verified` field says how the sender was known. `origin` means the sender's own key
was checked. `lead` means the lead checked it, and this machine trusts the lead. `local` means
this machine built the message itself, so it needed no check. `none` means no check is on record. A member sees
`origin` for a message from another member: the lead sends that member's certificate, and the
receiving machine checks the sender's signature against it. A member under an older lead sees `lead`.

## Receipts

```sh
collie walky status wt_n2d8s1v7c4b9
```

Every message has an id (`wt_` and 12 characters) and a receipt. The bridge writes the receipt
before it types anything, so the same id sent twice returns the receipt and types nothing. The ids
it has seen stay in `<stateDir>/walky/seen.json` for a day, even after the log drops a line. Across
a crew, a message whose clock is more than 10 minutes off is refused `stale`.

| State | Printed as | Meaning |
| --- | --- | --- |
| `accepted` | queued, or held with the reason | Logged, not typed yet. `held: draft present` or `held: turn running`: Collie types it when the box clears or the turn ends, up to 60 minutes. Do not send it again |
| `delivered` | typed into the pane | The text went into the pane and was submitted |
| `inbox-only` | waiting in the inbox, not typed | Not typed, for the reason shown: `held past 60 minutes` (a draft, a busy pane or an open dialog outlasted the hold), `cancelled by sender`, `dropped by the pane's owner`, `box not free`, `pane busy`, `pane replaced`, `no terminal`, `bridge restarted`. It waits in the pane's inbox |
| `refused` | not sent | Not taken, for the reason shown: no such pane, pane replaced, not an agent pane, a limit, an older member or lead, or walky talky off on that machine |
| `unknown` | may have arrived, will not be sent again | The outcome was not read, a hold was still pending after 60 minutes, or the log lost the record. Collie never sends it again |

The words are what the CLI and the phone show. `--json` and the receipt keep the state names.
`send` exits 0 for `accepted`, `delivered` and `inbox-only`.
It exits 4 for `refused` and 1 for `unknown`.

`status`, `reply` and `inbox <id>` exit 3 when the id is unknown here. `status` prints
`no record of <id> on this machine`, `reply` prints `no message <id> on this machine`, and
`inbox <id>` prints `no message <id> for this pane` inside a pane. `collie walky` with no verb, or
with a wrong one, prints the usage and exits 2.

## On the phone

The phone shows a message as a card and sends one from the composer, so you need no terminal.

A message in a pane's Chat appears as a card titled "Message from" and the sender's label. The card
shows the sender's kind (`agent` or `operator`), the message body, and "reply to" the id it answers.
A small word says how the sender was known: "signed by" a machine, "relayed by the lead", "this
machine", or "not verified".

The card appears only when the log of the machine that owns the pane holds that message. For a pane
on a crew member, the lead reads that member's log. A header that an agent merely prints stays plain
text, with the quiet mark "no log record on this machine"
([Troubleshooting](troubleshooting.md#walky-talky)). The card shows the body from that log at once,
also for a message from another agent that its pane has not read yet.

When the phone cannot read the log, it claims nothing: no card and no mark. This happens on a member
older than 1.23.0, and on a member the lead cannot reach.

Tap the card to open the Messages sheet on that message. The sheet scrolls to it and marks it, and
its Reply button is next to it.

While a message waits for the pane's box to clear, a line above the box reads "1 message waits for
the box to clear", or the count. Tap it to open the Messages sheet. A held message from an agent has
a Drop button there: the hold ends, the message stays in the inbox, and its row reads
`waiting in the inbox, not typed: dropped by the pane's owner`. A held message you sent from the
phone has Cancel instead, on its row and on the line under the box. Its row then reads
`cancelled by sender`. A message that was already typed answers "Already typed. Nothing to take
back." The line and the buttons go when nothing is held any more.

When an agent runs `collie walky` in a tool card, the card wears a small "walky talky" badge. After
`send` or `reply`, one line under it reads "Message to" the pane and the receipt state, for example
"Message to collie-04rj6a/w54:p1G: typed into the pane". After `inbox <id>`, the message's card shows under
the tool card. Both come from the bridge's log, never from what the command printed. If the log
does not hold the id, the card shows plain output. A message id in Chat text, or in a tool's
output, becomes a small chip when the log holds it, and a tap on the chip opens the Messages sheet
on that message. Any other id stays plain text. The terminal view marks every row that prints an id
the log holds the same way as the header row.

Each receipt state shows the words in the table above, with the reason after "not sent" and
"waiting in the inbox, not typed".

- **Messages.** Open a pane's menu and tap "Messages" to see the messages for that pane, newest
  first. The list holds the messages that reached the pane and the ones the pane sent. A sent message
  has the title "To" and the pane it went to, with the receipt state in words, and no "Reply"
  button. A message from an agent has a "Reply" button, and the reply keeps the token of the sender's
  address. A pane on a crew member has the row too, and its list comes from that member's own log. A
  reply from it goes through the lead like any message. An empty sheet says "No messages for this pane
  yet." A machine whose log the phone cannot read says "This machine does not keep messages yet."
- **Send as message.** Write the text, press and hold the Send button, then tap "Send as message".
  The text goes to this pane as a message from you. The phone adds the pane's token to the address,
  so the text reaches the session you are looking at. If another pane has taken the id since, the
  line shows `not sent: pane replaced` and nothing is typed. A pane from a machine older than tokens
  gets the bare address. A line under the box shows "Message to" the pane and the receipt state.
  While it says "queued" or "held", the line follows the receipt and changes to the final word. A
  held message adds "Typed when the box clears or the turn ends, up to 60 minutes. Do not send it
  again." Tap "Dismiss" to clear the line. A plain tap on Send still sends the text as before.
- **Message all agents.** On the Crew page, tap "Message all agents". Write the text, pick "Send
  to" (`All machines` or one machine) and tap "Send message". The sheet then asks
  "Message 5 agents on 2 machines?" with the count for that choice. The count leaves out machines
  the lead cannot reach. Tap "Send" to send, or "Back". The sheet lists the shell panes it skips.
  It shows "Agents reached" and one receipt per target. The receipt for the whole broadcast reads
  "every machine". A line "Not sent on this machine" counts the recent refusals per reason. A
  device that may not send sees "This device may not send messages." under the button.

## Install the skill

An agent uses walky talky only when it knows how. Collie writes the skill that teaches it into
your agents' own instruction files.

The skill is a short text. It teaches the agent the `collie walky` verbs, how to read the header
of a message, and when not to send.

After each update, Collie installs the skill into every harness it finds on this machine, and
keeps each copy current. A rollback and a switch of release line do the same with the build they
go to. Collie finds a harness by its config folder, for example `~/.codex`. For Claude Code, each
profile folder that exists gets the skill.

Run the same step by hand at any time, for example right after a fresh install:

```sh
collie skill sync
```

It prints one line for each file it installed or updated, and one line for each file it refused.
It prints nothing when every copy is current. `--dry-run` shows the changes and writes nothing.
`--json` prints the result for a script.

For a harness that Collie did not find, name it. Collie then creates the file:
`claude`, `codex`, `opencode`, `pi` or `gemini`.

```sh
collie skill install claude
```

`collie skill install all` installs into every harness whose config folder exists. A running agent
reads its instructions at start, so restart it after an install.

Only `collie update`, `collie skill install` and `collie skill sync` write those files. The bridge
never writes them, and no bridge start touches them.

### Where the skill goes

| Harness | File | How Collie writes it |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/collie-walky-talky/SKILL.md` | The whole file. Collie owns it. Every Claude profile that Collie reads gets the same folder. So does the folder that `CLAUDE_CONFIG_DIR` names, when it is an absolute path where you run the install. |
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
- `stale`: it differs from this build. The next update brings it up to date, or run
  `collie skill sync` now.
- `absent`: the harness is not on this machine, the sync is off, or you uninstalled the skill
  there. This is never a problem.
- `refused`: Collie will not touch it, for example because it is a symlink.

`collie skill status --check` prints nothing and exits with code 3 when any installed copy is
stale. A new Collie version alone does not make a copy stale. Only a change to the skill text, or
to the path of the `collie` binary it names, does.

`collie doctor` shows the same answer as the `skill-walky-talky` check. With
`COLLIE_SKILL_SYNC=off`, `collie update` writes nothing and prints one note when the new build
carries a newer skill.

### Take the skill out again

```sh
collie skill uninstall all
```

This removes the Claude file and cuts out the block. It leaves the rest of each file untouched.

Collie records the uninstall under its state directory, so the next update does not put the skill
back. `collie skill install <harness>` removes that record again.

## Limits and switches

What walky talky refuses, and how to turn it off.

```sh
# in .env, then run `collie restart`
COLLIE_WALKY=off
```

`COLLIE_WALKY=off` makes this machine refuse every message for its panes, as `not sent: off`. The
CLI on that machine still sends.

`COLLIE_SKILL_SYNC=off` stops `collie update` from writing the skill. The update then only prints a
note when an installed copy is behind, and `collie skill install` and `collie skill sync` still
work by hand.

These are the limits that stay on:

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
| A pane id that two sessions on one machine both use, in an address with no token | `ambiguous pane` |
| An address whose token names a pane that closed, and another pane holds the id now | `pane replaced` |
| A reply whose sender pane closed, now sits in another session, or holds a new token | `sender gone` |

- **Collie never answers a message on its own**, and never answers a dialog with one. A send over an
  open dialog is held: nothing enters the dialog, the message is typed after the dialog is answered,
  and it waits in the inbox only if the 10-minute hold runs out.
- **A reply goes back to the pane that sent the message.** Collie finds that pane from the session
  and pane the bridge logged. The address in the reply plays no part. One case differs: your reply
  from the phone to a message that only a member's log holds. The address then takes the reply to
  that member, and the member's log finds the pane.
- **The refusals are counted**, per reason, in `<stateDir>/walky/refusals.json`, with no body and
  no sender. `collie doctor` shows them in the row `walky-refusals`. The Crew page shows them under
  a broadcast.

## How it works

A local socket and a log, with no password.

The bridge listens on a local socket, `<stateDir>/walky/sock`, mode 0600. The CLI sends one request
and reads one answer. It carries no password: only your own user can open the socket. The log lives in
`<stateDir>/walky/`. It keeps 7 days and at most 2,000 lines, with up to 200 unread messages per pane.

Each pane's token lives in `<stateDir>/walky/instances.json`, mode 0600. The bridge looks at its
panes every 10 seconds. A pane it has not seen for 30 seconds loses its token, and its inbox goes
with it, read or not. A pane that comes back after that gets a new token and an empty inbox. A
bridge restart inside 30 seconds keeps the tokens; a reboot gives every pane a new one. The inbox
belongs to the pane and its token, so a new session that takes an old pane id never reads the old
messages.

Across a crew, a message rides the crew link that already exists, through the lead. A member posts
it to the lead. The lead posts it to the member that owns the pane. The lead then pushes each
outcome back to the sender's machine, on `POST /crew/v1/walky/outcomes`. The phone reads a member
pane's list through the lead, which forwards the read to that member. A member keeps the
outcomes it reports in memory until the lead acks them, and drops them after 10 minutes. The routes
are in [`CREW_PROTOCOL.md` §21](../CREW_PROTOCOL.md).

> **Note.** An agent runs as your user, so it can open the socket and could claim another pane.
> The receipt and the log protect the phone's card against a header typed on the screen. On a crew,
> the signature protects a message between machines. Nothing protects you from a local agent that
> lies about its own pane. A pane token tells panes apart and proves nothing: `who` prints it to
> every agent ([Security](security.md#walky-talky)).

On Windows walky talky is not available yet. The CLI prints
`walky talky needs a Unix socket on this host`.
