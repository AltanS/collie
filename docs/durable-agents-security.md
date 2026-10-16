# Security of a durable agent

> **Experimental.** The wire, the SDK and this page may change, or the feature may be removed, in a
> later minor release. [Durable agents](durable-agents.md) says what decides whether it stays.

A durable agent is code you run or deploy, and Collie treats its words as untrusted text. This page says
what a durable agent can reach, what keeps others out of it, what Collie does to its text, and what the
audit log keeps. [Security](security.md) covers Collie as a whole.

## What a durable agent can and cannot do

A durable agent asks, and a paired device decides. A durable agent receives what you answer and send to it, and
the requests of the wire. Collie gives it no way into your terminals.

| a durable agent can | a durable agent cannot |
| --- | --- |
| Raise a question: a yes or a no, a choice, a line of text, or a short form | Answer its own question through Collie |
| List starters and put up to four buttons of its own in the belt | Type into your terminals, or show a screen |
| Put text, code and `https://` links in a conversation | Show raw HTML, an image or a link that is not a web address |
| Choose the words of its own push, inside the caps | Push more than the guard allows |

Only a person's tap answers a question. The answer route runs for a paired device behind the write
gate, and nothing in the bridge calls it for a durable agent, a hook or a model output. On the phone,
Always allow takes a second tap. A durable agent that offers it holds the grant that needs the most care,
because one answer from a hostile tool would let every later call through without a question.

The durable agent, not Collie, enforces what an approved action does. A button of the durable agent runs with
the durable agent's rights, and Collie only sends the tap.

A durable agent cannot flood your lock screen. Collie decides each question once, keyed on the durable agent and
the tool call, and pushes it at most once. It allows 3 pushes per conversation a minute, 10 per host
a minute and 30 per host an hour. The push that would be the 31st becomes one summary push, and the
host sends no more until an hour after it. A card is always shown.

> **Caution.** The same user can answer a question on a socket. A socket keeps other users out,
> not a process of your own user, and that includes a tool your agent runs. The descendant check is
> the durable agent's own defence, and Collie cannot tell whether a durable agent runs it.

With the check, a durable agent refuses `answer`, `send`, `abort`, `action`, `rename`, `close`, `reopen`
and `starter` from itself, from any process it started, and from a caller it cannot tell apart from
them. The refusal is 403 `caller-refused`, and reads stay open. The check needs Bun on Linux, where
the SDK reads the caller of a socket. The table says what it enforces where the durable agent runs:

| where the durable agent runs | what the descendant check enforces |
| --- | --- |
| Bun on Linux | It runs by default. The SDK reads the caller of each connection and refuses an act from the durable agent, its descendants, or a caller it cannot place, with 403 `caller-refused` |
| Bun elsewhere, such as macOS | It cannot run. `openCollie` stops at start with an error, unless the durable agent passes `callerCheck: "off"`. With `off`, any process of your user can answer |
| Node | It cannot run. The durable agent starts and writes one warning line. Any process of your user can answer |

Put the agent's tools in a sandbox that cannot reach the socket, treat the card as a notice rather
than a gate, or run the durable agent on Bun. `callerCheck: "off"` is the durable agent's own choice to run
without the check.

## The socket transport

A private socket keeps out every other user, and its only gate is the path.

```bash
ls -ld /run/user/1000 /run/user/1000/desk /run/user/1000/desk/app.sock
```

The socket carries no token and no `Authorization` header. Collie connects only when the whole path
is private, and it runs this walk before each connect, from `/` down, with `lstat`, so it follows no
link:

| part | what Collie requires | what the reason says |
| --- | --- | --- |
| Every part of the path, the socket included | Not a symlink, even one that points to a good place | `socket-not-private: <path> is a symlink` |
| The socket's own folder | A real folder, yours, with mode exactly `0700` | `the socket's folder <path> has mode 0755, not 0700`, or `belongs to user <a>, not to <b>`, or `<path> is not a directory` |
| Every folder above it | A real folder that group and others cannot write to. A folder with the sticky bit, such as `/tmp`, is allowed there, never as the socket's own folder. Its owner is not checked, because a service with a private `/tmp` shows root's folders as user 65534 | `<path> has mode 0775, so group or others can write to it` |
| The socket | A socket, yours, with no group or other permission | `the path is not a socket`, `the socket belongs to user <a>, not to <b>`, `the socket has mode 0666, not 0600` |
| A platform with no user ids | Fails closed: Collie never dials | `this platform shows no file owner` |
| Windows | Only the HTTPS transport is available: `collie durable attach --socket` refuses before it writes | `a private socket needs Unix user ids; on Windows use --url <https://...> --token-env VAR` |

A path that fails is unreachable at once, with no grace. `collie doctor` names the same check in its
`durable-socket` row and gives the fix. A path with nothing at it reads `no socket at <path>`, which
is not a privacy fault.

A durable agent built with the SDK makes the socket's folder with mode `0700` when it is not there. It
refuses to start in a folder that exists with another mode. It sets the socket to mode `0600`, and
removes a dead socket file before it listens.

The socket transport is for Linux and macOS. Windows has no socket transport, so use the token
transport there.

## The token transport

A URL and a token reach a durable agent on another host, and the token is the whole gate.

```bash
openssl rand -hex 32
```

| rule | value |
| --- | --- |
| Token | 32 to 4096 bytes after trimming, printable ASCII with no space |
| URL | `https://`, or `http://127.0.0.1:<port>` or `http://localhost:<port>` for a durable agent on this machine. At most 2048 bytes. No user name, password, query or fragment |
| Certificate | Checked as any client checks it. Collie has no switch to skip it |
| Redirects | Collie follows none, so the token never reaches another host |

Anyone who holds the token acts as your phone. They can read every conversation, answer every
question, send text, stop a turn, rename or close, and run a starter. A TLS connection from
the internet has no caller to check, so the descendant check does not exist here. A durable agent reached
this way should offer Allow and Deny only, never an always-allow.

The host sees the text. TLS ends at the host, so it sees each request, the token in its header
included, and the conversations live in its storage.

Collie keeps the token in plain text in two places. `sources.json` holds it for an entry, and a
backup or a sync of the config folder carries it. Collie holds that file at mode `0600`, tightens a
wider one at start with a line in its log, and `collie doctor` shows a red `sources` row for one
that group or others can read. The durable-only form keeps it in `.env` or `config.toml`, and a file
that holds it must be mode `0600`. Collie never prints the token. `collie durable list` says
`(token set)`, `collie doctor` says `set, <n> bytes`, and no error or log line carries the value.
`attach` reads it from the variable `--token-env` names, so it is in no command line.

The token does not expire. To rotate it, give the durable agent the new token before you restart Collie,
or the phone says the durable agent refused it. A durable agent may accept a second token while a rotation runs:
the parked Cloudflare example takes `COLLIE_TOKEN` and, while it is set, `COLLIE_TOKEN_NEXT`
([ADR 0103](../.adr/0103-the-wire-has-two-transports-a-private-socket-or-tls-with-a-token.md)). The
steps are in [Tokens](durable-agents.md#tokens).

This is an outbound call that Collie makes to the URL you configured, and it is declined by
attaching nothing. Each request carries `Authorization: Bearer <token>`, the wire version, the
ETag of the last read, and for a tap the body of what you answered or sent. A read is a `GET`
without a body.

Every poll over https is a request that your host may bill, and a "nothing changed" answer counts
too. With no phone open the idle poll runs every 10 s, so Collie asks 8,640 times a day, and every
2 s while a phone watches. A durable agent that is down or refuses the token is asked at most once every
10 s, and those requests are billed too. Use a paid plan for a durable agent that Collie polls all day.

## What Collie does to a durable agent's text

Collie cleans every string from a durable agent before anything else reads it, and draws it as text.

A durable agent should send strings inside the caps. Collie does not trust that it did. Each string goes
through three steps:

1. **Controls go.** Collie removes C0 controls, DEL and C1 controls. Fields that hold several lines
   keep the newline and the tab: an item's text, a tool call's output and summary, and a question's
   reason.
2. **Invisible and direction characters go.** Collie removes the direction marks U+200E, U+200F and
   U+061C, the overrides and isolates U+202A to U+202E and U+2066 to U+2069, the zero-width
   characters U+200B to U+200D, the word joiner U+2060, the byte order mark U+FEFF, and the tag characters
   U+E0000 to U+E007F, which can carry a whole invisible sentence.
3. **The string is cut.** Collie cuts it to its byte cap at a whole character and ends it with `…`.

A question whose title or reason changed in cleaning carries a "Text shortened" mark on its card. An
option or a belt button with no words left is dropped, so a button is never blank. A field with none
is named by its id.

| text | cap |
| --- | --- |
| A title of a workspace, a tab, a conversation or a question | 256 bytes |
| An option, a field or a starter label | 128 bytes |
| A belt button label | 16 characters |
| The reason of a question | 2048 bytes |
| The output of a tool call | 16384 bytes |
| The text of a message or a reply | 65536 bytes |
| The text of a `markdown` or `code` item | 32768 bytes |
| Text you send to a durable agent | 1 to 32768 bytes, refused before it leaves |
| One reply from a durable agent | 16 KiB for `hello`, 4 MiB for a snapshot |

Ids are never cleaned or cut. An id is 1 to 128 bytes with no control character, no whitespace and
none of `/`, `?` or `#`, or the object that carries it is dropped.

Collie draws the text as text. A `markdown` item shows headings, lists, emphasis, code spans and
links, and raw HTML never renders: a tag shows as its own characters. A link inside a `markdown`
item opens only a web address. A `link` item needs an `https://` address with a host, with no user
name or password, no space, control or invisible character, and at most 2048 characters. Otherwise
Collie drops the item and writes one line in its log for each conversation. Images and files are not
items.

## What is logged

Collie writes each write a phone makes to a durable agent in `<state-dir>/audit.log`, mode `0600`.

Each line carries the durable agent's name as `session`, the paired device, and the event:

| event | when | what the line keeps |
| --- | --- | --- |
| `answer` | A tap answered a question | The request id, the question and its revision, the option id, or the kind of answer (`optionIds`, `text` or `values`), and the outcome. Never the words you typed |
| `send` | You sent or steered text | The request id, the turn or question it named, `steer`, the outcome, and the text as a preview of 120 characters |
| `abort` | You stopped a turn | The request id, the turn or question it named, and the outcome |
| `action` | You tapped a belt button | The request id, the action id, the turn, and the outcome |
| `starter.start` | You tapped a starter | The starter id, the request id, and the outcome |
| `durable.reopen` | You reopened a closed conversation | The conversation id |
| `space.rename` | You renamed a workspace | The space id and the new name |

Closing and renaming a conversation or a tab use the usual events, `pane.close`, `pane.rename` and
`tab.rename`. `COLLIE_AUDIT_CONTENT=none` redacts every string in the detail except a few named
fields such as the request id, so the preview of a `send` goes with it. The log shows what happened
after the fact. It does not stop anything.

Collie also keeps a receipt for each answer, send, stop, button tap and starter, with no typed
text. [Where Collie keeps a durable agent's data](durable-agents.md#where-collie-keeps-a-durable-agents-data)
says how long.
