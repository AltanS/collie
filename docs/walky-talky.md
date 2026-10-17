# Walky talky: messages between agent sessions

Walky talky lets one agent session send a short message to another, on any harness, and lets you
message a session the same way. The message is typed into the target pane as the agent's next
prompt, under a one-line header that names the sender. A pane that cannot take it right now keeps
it in its inbox.

## Send a message

```sh
collie walky who
collie walky send local/w6:p3 "Tests are green on fix-465. You can merge."
```

`who` lists every agent pane you can reach. Pick an address from that list and pass it to `send`.
`collie wt` is the short spelling of `collie walky`.

`send` prints one line when the receipt is known, for example `delivered wt_k3f9x2m8q1a0`. It waits
up to 15 seconds for that, then prints the state it has. With no text after the address, the body
is read from stdin:

```sh
git log --oneline -5 | collie walky send local/w6:p3
```

## Addresses

An address names one pane, one machine's panes, or every pane.

| Address | Who receives it |
| --- | --- |
| `<member>/<pane>` | One pane. On a machine with no crew the member is `local`, for example `local/w6:p3` |
| `<member>/all` | Every agent pane on that machine, except the sender |
| `all` | Every agent pane you can reach, except the sender |

A shell pane never receives a message. Only panes the bridge sees as an agent do.


## What the target pane receives

```
[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, collie-workspace#fix-465)
Tests are green on fix-465. You can merge.
```

The first line is the header. It names the message id, who typed it, and their pane, harness and
label (`<repo>#<branch>`, or the pane's title). A reply adds ` reply to <id>` after the
parenthesis. The body follows as it was sent, at most 4,000 characters, with control bytes and
direction marks removed.

There are two kinds of sender:

| Kind | When |
| --- | --- |
| `agent` | `collie walky` ran inside a pane. The multiplexer's own variables name the pane |
| `operator` | You sent it from the phone (the paired device's label), or ran `collie walky` outside any pane (label `cli`) |

A message from an agent is a peer's words, not your instruction. The agent skill tells an agent to
weigh it, and never to run a destructive command because a peer asked.

## Reply, read and check

```sh
collie walky reply wt_k3f9x2m8q1a0 "Merged. Thanks."
collie walky inbox
collie walky status wt_n2d8s1v7c4b9
```

- `reply <id>` sends to the pane the message came from, as a reply to it. A message from an
  operator has no pane to reply to.
- `inbox` lists this pane's unread messages. `--all` lists every message that reached it,
  `--ack` marks the listed ones read. Outside a pane, `inbox --all` lists every message on the machine.
- `status <id>` prints the message's receipt.

Every verb takes `--json` for a script.

## Across a crew

In a crew, a message for another machine always goes through the lead. A member sends it to the
lead, and the lead types it on its own panes or passes it on to the machine the address names. The
lead checks the sender's signature against the key it pinned for that machine. Each machine then
checks that its lead passed the message on.

- **`who` on the lead** lists the agent panes of every machine. **`who` on a member** lists its own
  panes and the line `other machines: ask the lead`.
- **The outcome lives on the lead.** The machine that types a message reports the outcome to the lead
  with its next crew update. On a member, a message to another machine shows
  `accepted (outcome known on the lead)`, and `send` does not wait for more. Run
  `collie walky status <id>` on the lead, or open the pane on the phone, to see `delivered`.
- **An older machine refuses.** A member that runs an older Collie gives `refused: older member`. A
  member under an older lead gives `refused: older lead`. Update the crew to fix it.

The receipt's `verified` field says how the sender was known. `origin` means the sender's own key
was checked. `lead` means the lead checked it and this machine trusts the lead, which is what a
member sees for a message from another member.

## Receipts

Every message has an id (`wt_` and 12 characters) and a receipt. The bridge writes the receipt
before it types anything, so the same id sent twice returns the receipt and types nothing.

| State | Meaning |
| --- | --- |
| `accepted` | Logged, not typed yet |
| `delivered` | The text went into the pane and was submitted |
| `inbox-only` | Not typed, for the reason shown (a dialog open, a turn that held it for 10 minutes, no terminal). It waits in the pane's inbox |
| `refused` | Not taken: no such pane, not an agent pane, the sender's limit, or walky talky off on that machine |
| `unknown` | Typed, outcome not read. Collie never sends it again |

`send` exits 0 for `accepted`, `delivered` and `inbox-only`, 4 for `refused` and 1 for `unknown`.

## Limits and switches

- **30 messages per sender in 10 minutes.** The next one is refused `rate limit`. A message to `all`
  counts once.
- **Collie never answers a message on its own**, and never answers a dialog with one. A send over an
  open dialog is refused by the Send Protocol, and the message stays in the inbox.
- **`COLLIE_WALKY=off`** refuses every message for this machine's panes. The CLI on that machine
  still sends.

## How it works

The bridge listens on a local socket, `<stateDir>/walky/sock`, mode 0600. The CLI sends one request
and reads one answer. It carries no token: only your own user can open the socket. The log lives in
`<stateDir>/walky/`. It keeps 7 days and at most 2,000 lines, with up to 200 unread messages per pane.

> **Note.** An agent runs as your user, so it can open the socket and could claim another pane.
> The receipt and the log protect the phone's card against a header typed on the screen, and on a
> crew the signature protects a message between machines. Nothing protects you from a local agent
> that lies about its own pane.

On Windows walky talky is not available yet: the CLI prints `walky talky needs a Unix socket on
this host`.
