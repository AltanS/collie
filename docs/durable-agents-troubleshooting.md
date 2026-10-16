# Troubleshooting a durable agent

> **Experimental.** The wire, the SDK and this page may change, or the feature may be removed, in a
> later minor release. [Durable agents](durable-agents.md) says what decides whether it stays.

A durable agent that does not show up, shows Unreachable, or does not answer a tap: three commands find
the cause, and a table of reasons and a list of cases give the fix.
[Troubleshooting](troubleshooting.md) covers Collie as a whole.

## First checks

Run these three, in this order:

```bash
collie durable list
collie doctor
collie logs
```

| command | what it shows for a durable agent |
| --- | --- |
| `collie durable list` | One line per entry of `sources.json`, with the state the running bridge gives it: `loaded`, `not loaded (restart to apply)`, `refused (<status>)` or `bridge not answering`. `loaded` means the bridge loaded the entry. It does not mean the durable agent answers. A `not loaded` also shows when the bridge answers HTTP 400 for the name |
| `collie doctor` | Asks the durable agent itself. It prints the rows of [Doctor rows for durable agents](#doctor-rows-for-durable-agents) and names the failing check with a fix |
| `collie logs` | The boot line of each durable agent, `[bridge] program "desk": durable, private socket /run/user/1000/desk/app.sock`, and its reason when a setting breaks a rule. A bad `sources.json` prints `[bridge] FATAL:`. A failed read prints `[state] poll failed, marking disconnected: <reason>` once per outage. Lines that start `[durable]` name a version refusal, an old lead, dropped items and a deleted log |

The phone says less. A durable agent row reads Starting or Unreachable and gives no reason. A wire version
refusal has its own word, Version mismatch, and a caution box on the durable agent's home. A refused token
has its own words in the connection bar. `collie doctor` and `collie logs` name every other reason.

## The reasons table

When Collie cannot reach a durable agent, the rest of Collie starts anyway, and the durable agent shows as
unreachable with one reason.

A reason names the environment variable even when the durable agent is an entry of `sources.json`.
Read `COLLIE_DURABLE_SOCKET` as the entry's `socket`, `COLLIE_DURABLE_URL` as its `url` and
`COLLIE_DURABLE_TOKEN` as its `token`. The fix for an entry is in `sources.json`. The fix for the
durable-only form is in `.env`, then `collie restart`.

### The setting breaks a rule

Collie reports these without dialling the durable agent. Rules that sit in `sources.json` entries are
refused at the start of the bridge as well ([A typo in sources.json](#a-typo-in-sourcesjson)).

| reason | what it means and the fix |
| --- | --- |
| `COLLIE_DURABLE_SOCKET is not set` | The durable-only form has no socket path. Set it, or set the URL with its token |
| `COLLIE_DURABLE_SOCKET must be an absolute path` | Give the full path, starting with `/` |
| `COLLIE_DURABLE_SOCKET is longer than 103 bytes` | Shorten the path. Keep it under `$XDG_RUNTIME_DIR` |
| `the private socket transport is not available on Windows; set COLLIE_DURABLE_URL and COLLIE_DURABLE_TOKEN instead` | Windows has no socket transport. Use a URL and a token |
| `COLLIE_DURABLE_SOCKET and COLLIE_DURABLE_URL are both set; set the socket, or the URL with its token, not both` | The durable-only form got both. Keep one transport |
| `COLLIE_DURABLE_URL is set without COLLIE_DURABLE_TOKEN; the durable agent refuses a caller with no token` | The durable-only form got a URL and no token. Set the token |
| `COLLIE_DURABLE_TOKEN is set without COLLIE_DURABLE_URL; a token is only sent to a URL` | The durable-only form got a token and no URL. Set the URL, or remove the token |
| `COLLIE_DURABLE_URL is longer than 2048 bytes` | Shorten the URL to the durable agent's base address |
| `COLLIE_DURABLE_URL is not a URL` | Write it as `https://host` |
| `COLLIE_DURABLE_URL must start with https://` | Any scheme but `https://` is refused. A plain `http://` has its own row below |
| `COLLIE_DURABLE_URL uses plain http to <host>, so the token would cross the network unencrypted; use https://, or http://127.0.0.1:<port> for wrangler dev` | Use `https://`. Plain http is for `127.0.0.1` or `localhost` with a port |
| `COLLIE_DURABLE_URL uses plain http on loopback without a port; name the port, for example http://127.0.0.1:8801` | Add the port |
| `COLLIE_DURABLE_URL must not carry a user name or password; the token goes in COLLIE_DURABLE_TOKEN` | Take the user name and password out of the URL |
| `COLLIE_DURABLE_URL must not carry a query or a fragment` | Take the `?` part and the `#` part out of the URL |
| `COLLIE_DURABLE_URL names the durable agent's base only; leave out /session/v1, the adapter adds it` | Cut the `/session/v1` from the path |
| `COLLIE_DURABLE_TOKEN is <n> bytes; it must be at least 32 bytes, for example 64 hex characters from openssl rand -hex 32` | Make a longer token, and give the durable agent the same one |
| `COLLIE_DURABLE_TOKEN must be printable ASCII with no spaces` | Remove spaces and other characters from the token |
| `COLLIE_DURABLE_TOKEN is longer than 4096 bytes` | A header that long is a mistake. Use a shorter token |

### The durable agent does not answer, or answers wrongly

| reason | what it means and the fix |
| --- | --- |
| `no socket at <path>` | Nothing is at the path yet. Start the durable agent, or fix the path |
| `cannot check <path>: <message>` | Collie could not read the path. Make it readable to your user |
| `socket-not-private: <check>` | The path walk failed, and the text after the colon names the part. [The privacy check fails](#the-privacy-check-fails) has the usual ones |
| `connection refused` | Nothing listens. A durable agent that crashed can leave its socket file behind: [A stale socket file](#a-stale-socket-file). Over https, nothing listens at the URL |
| `no answer within <n>ms` | The durable agent hangs, or is cold. Collie waits 1000 ms on a socket and 5000 ms over https |
| `tls refused: <message>` | The certificate of the URL is refused. Collie has no switch to skip the check |
| `the host name does not resolve` | The host name in the URL is wrong, or your network cannot reach it |
| `token-refused: the durable agent answered 401` or `403` | The durable agent refused the token. [The durable agent refused the token](#the-durable-agent-refused-the-token) |
| `too-large` | The durable agent answered with more than Collie reads: 16 KiB for `hello`, 4 MiB for a snapshot. Make its reply smaller |
| `incompatible: the durable agent speaks 2..3, this Collie speaks 1..1` | The version ranges do not meet. Update the older side. `collie doctor` shows both ranges and the log gets one line per range |
| `incompatible: not a durable agent` | Something else answers at that path or URL. Point the entry at the durable agent |
| `incompatible: the durable agent asks for a token` | A durable agent on a socket wants a token, which a socket never carries. Update the older side, or reach it by URL with a token |
| `unreadable hello: <detail>` or `unreadable snapshot: <detail>` | The durable agent sent a document the wire does not allow. Read the durable agent's own log |
| `the durable agent answered <status>` or `the durable agent answered 409 <code>` | The durable agent answered with a status the wire does not use here. Read the durable agent's own log |
| `starting` | The durable agent is up and says it is not ready, or answers 503. Collie asks again on the next poll |

## Doctor rows for durable agents

`collie doctor` asks each durable agent the same questions the bridge asks, in the order the bridge asks
them. It sends nothing but `hello`.

Each entry of `sources.json` gets one block of six rows, written `durable-socket:desk` for a durable agent
named `desk`. A `sources` row before the blocks checks the file, and one `durable-lead` row follows
them. A durable-only Collie prints the same six rows with no suffix, and its `mux` row says
`durable, see the durable-* lines`.

| row | green | warning or red |
| --- | --- | --- |
| `sources` | `2 durable agents in <path>, mode 0600` | Red when the file does not parse. Its fix says the bridge does not start while it is wrong. Red when group or others can read the file, with `chmod 600` as the fix, because an entry may hold a token |
| `durable-env` | `transport: private socket` with the path, or `transport: https with a bearer token` | Red when the setting breaks a rule from [the reasons table](#the-setting-breaks-a-rule) |
| `durable-socket` | The path is a socket, yours, mode `0600`, in a folder of yours with mode `0700`, no link on the way | Red, and the row names the failed check: nothing there, unreadable, not a socket, a symlink, not a folder, a folder of another owner, a folder with the wrong mode, a folder above that others can write, a socket of another owner, or a socket with an open mode. Skipped on a durable agent behind https |
| `durable-url` | The address, `https` or loopback http, and its length in bytes | Red when the URL breaks a rule. Skipped on a socket |
| `durable-token` | `set, <n> bytes`. Collie never prints the value | Red when the token breaks a rule. Skipped on a socket |
| `durable-hello` | The durable agent answered. Both ranges, the version they agree on | Red with the cause: the token was refused, nothing answered, something that is not a durable agent answered, the durable agent asks for a token on a socket, an unreadable `hello`, or ranges that do not meet. A range mismatch shows both ranges |
| `durable-ready` | `ready`, the durable agent's host name and its epoch | A warning when the durable agent says it is not ready yet |
| `durable-lead` | The lead is new enough to show the question card | See [In a crew](#in-a-crew) |

A row that fails stops the rows after it. They print as skipped with the reason `fix the row above
first`, because Collie never asks a durable agent over a socket that fails the privacy check or with a
token that breaks its rule. A skipped row is not a fault.

## Cases

Each case says what you see, why, and the fix.

### A typo in sources.json

You see Collie down, not only one durable agent: the phone cannot connect. `collie logs` ends with
`[bridge] FATAL:`, the path of the file, the entry and the field.

The bridge reads `sources.json` at start and stops on a field it does not know, a `kind` that is not
`durable`, a name that breaks the rule, a name used twice, `socket` and `url` together, neither, a
`url` with no `token`, or a `token` with a `socket`. Fix the file, then run `collie restart`.
`collie doctor` shows the same message in its `sources` row.

Where the bridge cannot name the entry (it is not an object, it has an unknown field, or the name
breaks the rule), it counts from 0 and writes `entry 1` for the second one. `collie durable attach`
counts from 1 and writes `entry 2` for the same entry. Both say which field. Once the name is
valid, the bridge writes the name: `entry "desk"`.

`attach` and `detach` refuse to write a file they cannot read, so a typo never costs your other
entries. They stop with exit code `1`.

### A durable agent does not appear after attach

You see no durable agent on the phone, and `collie durable list` says `not loaded (restart to apply)`.

`attach` and `detach` only write `sources.json`. The bridge reads it at start. Run `collie restart`,
or add `--restart` to the verb next time. When `not loaded` survives a restart, read `collie logs`:
`list` words an HTTP 400 from the bridge the same way as a 404.

### The privacy check fails

You see `socket-not-private: the socket's folder /tmp/hello has mode 0755, not 0700`, and the doctor
row `durable-socket` is red.

Collie dials a socket only when the whole path is private. The usual causes are a folder with mode
`0755`, a socket directly in `/tmp` or another shared folder, and a symlink in the path. A symlink is
easy to miss: `/var/run` links to `/run` on many Linux hosts, so a path that starts `/var/run/`
fails with `/var/run is a symlink`. Use the real path.

Run `chmod 700` on the socket's own folder, or move the socket under `$XDG_RUNTIME_DIR`. The rules
are in [Security of a durable agent](durable-agents-security.md#the-socket-transport). A durable agent
built with the SDK refuses to start in an existing folder whose mode is not `0700`, and says so on
its own.

### A stale socket file

You see `connection refused` on a socket, and the file is there.

A durable agent that crashed leaves its socket file behind, and nothing listens on it. Start the durable agent
again. The SDK removes a dead socket file before it listens, and stops with `another instance is
already listening` when the socket is alive. Delete the file by hand only when your durable agent does
not clear it.

### A name that is also a terminal session

You see the bridge stop at start with `the name is the terminal session's own; pick another`, or a
terminal session missing on the phone.

A durable agent cannot take the name of the terminal Collie runs from. That name is `default` on most
installs, and on a durable-only Collie `default` is its durable agent's. The bridge stops at start and
names the entry. A Herdr session that has the name of a durable agent is another case: the durable agent keeps
the name, the phone does not show that session, and the log says so once. Rename one of them.

### A durable-ready warning that stays

You see `durable-ready` as a warning on every run of `collie doctor`.

The durable agent answers `hello` and says `ready: false`. The phone shows it as Starting. A durable agent says
it is ready only after it laid out its conversations and raised its open questions again. Read the
durable agent's own log for what it waits on.

### The durable agent stops at start on the descendant check

You see the durable agent stop at start with `the descendant check needs Bun on Linux to read the peer of
a socket; pass callerCheck: "off" to run without it`.

The check needs Bun on Linux. On macOS, run the durable agent with Node, or pass `callerCheck: "off"` to
`openCollie` and read [what the check protects](durable-agents-security.md#what-a-durable-agent-can-and-cannot-do)
first. The error comes from the durable agent. Collie is not involved.

### A question comes back after a restart

You see one question again after the durable agent restarted, or a card that says it was already answered.

An answer to a question from before the restart gets `too-late`, and the card says so and goes. A
durable agent that derives the question's id from its tool call raises the same question again, so an
answer sent across the restart lands and the tool runs once. A durable agent that makes a new id each
time raises a new question for the same tool call. The card shows it, and Collie sends no second
push, because the push guard keys on the tool call. The guard also allows 3 pushes per
conversation a minute, 10 per host a minute and 30 per host an hour. The push that would be the 31st
in an hour becomes one summary push for that host, and the host sends no more until an hour after
it. A card is always shown.

### 403 caller-refused

You see the phone say the answer or the message was refused, and the durable agent's reason is 403
`caller-refused`.

The durable agent's descendant check refused the caller. It refuses the durable agent itself, any process the
durable agent started, and a caller it cannot tell apart from them. Collie falls on the durable agent's side
when the durable agent, or a tool it ran, started the Collie process and the process is still its child.
Start Collie from outside the durable agent, then try again.

### Try again, and an answer that may be applied

You see "Not sure the answer arrived" with a Try again button, and after the tap "May already be
applied. Check the chat."

A timeout, a dropped connection or a 5xx after the answer left means it may have landed. Try again
sends the same request id, so the durable agent answers `replayed` and never resolves the question twice.
When the question is already closed, the first try may have closed it, so the phone says to check
the chat. A send, a stop and a button tap say the same with their own words.

### The durable agent refused the token

You see the connection bar say "The durable agent refused the token. Check COLLIE_DURABLE_TOKEN on this
peer.", and the reason is `token-refused`.

The durable agent answered 401 or 403 to the token. The most common cause is a rotation where one side
changed first. The words on the phone name `COLLIE_DURABLE_TOKEN` even for an entry of
`sources.json`: read it as the entry's `token`. Give the durable agent the new token before you restart
Collie. [Tokens](durable-agents.md#tokens) has the rotation steps. A 403 can also come from an
access proxy in front of the durable agent.

### A flip to Unreachable that takes two reads

You see a durable agent stay Ready for one failed read, then flip to Unreachable.

One failed read after a good one keeps the last layout for that poll. The second failure in a row
flips the durable agent. A refused token follows the same rule. A socket path that fails the privacy check
is the one exception: it shows at once.

Over https, a durable agent that is down or refuses the token is asked at most once every 10 s, because
each try is a billed request. Over a socket the least gap between two reads of a down durable agent is
250 ms.

## In a crew

A durable agent on a member of a crew shows on the phone of the lead, so the lead needs to know what a
durable agent is.

A lead older than 1.21.0 lists the durable agent's conversations without the question card, and its
Terminal tab polls a conversation that has no terminal. Nothing on the member fixes that. The member
says so itself: `collie doctor` warns in `durable-lead`, and the log gets one line,
`[durable] the lead is 1.20.1; it shows durable panes without the question card and its Terminal tab
polls; update the lead`, once for each release it hears. Update the lead.

| `durable-lead` | what it says |
| --- | --- |
| skipped, no crew | This machine is not in a crew, so there is no lead |
| skipped, lead | This machine is the lead and shows its own panes |
| skipped, no release | The lead stated no release: a dev build, an update in progress, or no call since the bridge started |
| warning | The lead runs a release below 1.21.0 |
| green | The lead is 1.21.0 or later |

A member that is older than the lead has the opposite fault. The phone says "This machine runs an
older Collie and cannot take answers here. Update it, or answer in the durable agent." Update that member.
