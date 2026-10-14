# Programs (experimental)

If you built an agent with Pi Durable or any long-running program, Collie can show it on your phone. Your program gets approval prompts, history and a chat view without any UI code. This is experimental: the wire may change, or the feature may be removed, in a later minor, and today only our examples speak it.

The wire carries a version header, so a program can refuse a version it does not know, and Collie accepts the previous version for one minor release. A program is one place a [session](sessions.md) can come from. The words are in [Terminology](terminology.md).

## Quickstart

You need Linux, and Node 22.18 or later or Bun 1.4 or later. Install the SDK in your program's folder:

```bash
npm install @colliepwa/durable-sdk@experimental
# or
bun add @colliepwa/durable-sdk@experimental
```

The package is experimental. It is published under the npm dist-tag `experimental`, never `latest`, and it follows the exit in [ADR 0104](../.adr/0104-a-program-is-a-session.md): if the durable wire goes, the package is deprecated ([ADR 0105](../.adr/0105-the-durable-sdk-is-an-npm-package.md)).

Save this program as `hello.mjs`. It is ten lines:

```js
import { openCollie } from "@colliepwa/durable-sdk";

const socket = process.env.COLLIE_DURABLE_SOCKET ?? `${process.env.XDG_RUNTIME_DIR}/hello/app.sock`;
const collie = await openCollie({ socket, hostName: "hello", caps: { asks: true } });
const pane = collie.workspace("hello", { title: "Hello" }).tab("main", { title: "Questions" }).pane("deploy", { title: "Deploy", harness: "hello" });
collie.ready();
console.log(`listening ${collie.address}`);
const options = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
const answer = await pane.ask({ kind: "choice", toolCallId: "deploy-1", itemId: "deploy-1", title: "Deploy to staging?", options });
console.log(`answer: ${answer.optionIds[0]}`);
await collie.close();
```

Run it with `node hello.mjs` or `bun hello.mjs`. It prints `listening /run/user/1000/hello/app.sock` and waits. On Node it first writes one more line: Node cannot read who connects to the program's socket, so any process of your user can answer its question. Bun can, and refuses an answer from the program itself or from a process it started. The same program is `examples/durable-member/hello.ts` in a clone of Collie.

In a second terminal, attach it to your Collie, then restart so Collie reads the new source:

```bash
collie durable attach hello --socket /run/user/1000/hello/app.sock
collie restart
```

Use the path your program printed. Add `--restart` to the first command to restart in the same step. Open Collie on your phone. A space named `hello` appears, with an Experimental badge, and it holds one question card: "Deploy to staging?". Tap Yes or No. The program prints your answer and exits.

## Attach a program

Each program you attach is one entry in `sources.json`, in the config folder next to `.env`, mode `0600`. The phone shows it in its own Programs section, with the name you gave it, its runtime, the count of questions waiting and an Experimental badge, and the section moves above your spaces when a question waits. A conversation of the program is one of its panes. Your terminals look and work as before. A name is lower case letters, digits and hyphens, at most 32, and not the name of a Herdr, tmux or zellij session.

A program that you deployed behind TLS takes a URL and a token. Put the token in an environment variable, and name the variable. The token never goes on the command line:

```bash
export DESK_TOKEN=your-32-byte-random-token-here
collie durable attach desk --url https://desk.example.com --token-env DESK_TOKEN
```

`collie durable list` shows each entry and what the running bridge says of it. `collie durable detach desk` removes one. Both `attach` and `detach` only write the file. They print "restart to apply" until you restart, or give `--restart`.

### Two ways to reach a program

| | private socket | https with a token |
| --- | --- | --- |
| Where the program runs | this machine, as your user | anywhere you deploy it |
| What keeps others out | the socket is yours, mode `0600` | the token, and only the token |
| Who can act as your phone | any process of your user | anyone who has the token |
| How often Collie asks | every 1 s while a phone watches, else every 3 s | every 2 s while a phone watches, else every 10 s |

The socket transport is for Linux and macOS. On Windows use the URL and the token. The socket path must be absolute and at most 103 bytes. Collie connects only when the socket is yours and has no group or other permission, because the socket carries no token and a private socket is the whole gate.

The URL must start with `https://`. The one exception is `http://127.0.0.1:<port>` or `http://localhost:<port>`, with a port, for a program on the same machine. Collie refuses any other `http://` address, because the token would cross the network unencrypted. Make the token 32 random bytes or more, for example with `openssl rand -hex 32`, and give the program the same value. Collie sends it with every request and never prints it.

> **Caution.** Over https the token is the only gate. Anyone who has it can read every conversation and answer every question, and the host sees the text. A program reached this way should offer Allow and Deny only, never an always-allow.

Every poll over https is a request that your host may bill, and a "nothing changed" answer counts too. With no phone open the idle poll runs every 10 s, so Collie asks 8,640 times a day. Check what your host's plan allows for that.

## A program alone in one Collie

The older form still works for an instance with no terminal, such as a Windows host or a hosted program: set `COLLIE_MUX=durable` with `COLLIE_DURABLE_SOCKET`, or with `COLLIE_DURABLE_URL` and `COLLIE_DURABLE_TOKEN`, never both. Such an instance drives one program, and it names that program `default`. A URL without a token is a config error: Collie starts, names the error in its log, and shows the program as unreachable with that reason.

```bash
# a program on this machine, as you
COLLIE_MUX=durable
COLLIE_DURABLE_SOCKET=/run/user/1000/durable/session.sock

# or a program you deployed behind TLS
COLLIE_MUX=durable
COLLIE_DURABLE_URL=https://durable-member.example.com
COLLIE_DURABLE_TOKEN=your-32-byte-random-token-here
```

To change a token, deploy the new one to the program, set it in the `.env`, and run `collie restart`. A program on another machine is reached over https with a token, or by a Collie on that machine that joins your [crew](crew.md). A durable-only instance joins under its host name, so give it a name with `collie crew join <lead-address> --label durable` when it shares a host with the lead.

## Troubleshooting

`collie doctor` names the failing check. The usual causes:

- **Socket permission.** Collie connects only to a socket that you own and that has no group or other permission (mode `0600`). The path must be absolute and at most 103 bytes. The reason shows as `socket-not-private`.
- **A stale socket file.** A program that crashed can leave its socket file behind, and Collie then sees `connection refused`. Delete the file and start the program again.
- **A program restart with a question open.** An answer to a question from before the restart is `too-late`, and the card goes. A program that derives the question's id from its tool call raises the same question again, and the card comes back.
- **A version mismatch.** The reason `incompatible` shows both ranges. Update the older side.
- **An old lead.** With a lead older than 1.21.0, a program's pane is listed but its question is not: the pane shows "needs you" with a red dot, and no card appears. Update the lead.

When Collie cannot reach a program, the rest of Collie starts anyway, and the program shows as unreachable with a reason:

| reason | what it means |
| --- | --- |
| `COLLIE_DURABLE_SOCKET is not set`, `must be an absolute path`, `is longer than 103 bytes` | the variable is missing or unusable |
| `the private socket transport is not available on Windows` | on Windows use a URL and a token instead of the socket |
| `COLLIE_DURABLE_SOCKET and COLLIE_DURABLE_URL are both set` | set the socket, or the URL with its token, not both |
| `COLLIE_DURABLE_URL is set without COLLIE_DURABLE_TOKEN` | the URL needs its token |
| `COLLIE_DURABLE_URL uses plain http to <host>` | use `https://`; plain http is for 127.0.0.1 or localhost only |
| `COLLIE_DURABLE_TOKEN is <n> bytes; it must be at least 32 bytes, for example 64 hex characters from openssl rand -hex 32` | make a longer token, and give the program the same one |
| `token-refused` | the program answered 401 or 403: the two sides hold different tokens |
| `no socket at <path>` | nothing listens there yet |
| `socket-not-private` | the path is not a socket, is not yours, or has a group or other permission |
| `connection refused`, `no answer within <n>ms` | a stale socket file, a program that hangs, or nothing at the URL yet |
| `tls refused`, `the host name does not resolve` | the URL's certificate or name is wrong |
| `incompatible: program speaks 2..3, this Collie speaks 1..1` | the version ranges do not meet. Update the older side |
| `starting` | the program is up and says it is not ready yet. Collie asks again on the next poll |

`collie doctor` checks the same things in rows named `durable-env`, `durable-socket`, `durable-url`, `durable-token`, `durable-hello` and `durable-ready`, and names the failing check with a fix. With `sources.json`, a `sources` row says whether the file reads and is mode `0600`, and each program gets its own block of those rows, written `durable-socket:desk` for a program named `desk`. A `durable-lead` row warns when the lead runs a release below 1.21.0, which shows a program's panes without the question card. Update the lead.

Collie holds no model key. A program uses an API key or a ChatGPT sign-in. An Anthropic subscription may not be used through a third-party harness.

A program's own buttons run with the program's rights, and the program, not Collie, enforces what an approved action does.

On Node, a program cannot read who connects on its socket. An agent that runs a shell as the same user could answer its own question, so put the agent's shell in a sandbox, or treat the card as a notice rather than a gate.

The Cloudflare example is parked and is not part of a release. It is in `experiments/durable-member-cloudflare/`.

## What a program can do on the phone

A program says what it can do in its hello. A cap it declares draws the control on the phone, and a
cap it leaves out draws nothing. Today the caps are:

- **asks.** The program raises a question: a yes or a no, a choice, a line of text, or a short form.
  You answer it with one tap.
- **starters.** The program lists starters, and they appear as rows on the New page.
- **send.** You send text to a conversation.
- **steer.** You steer text into a turn that is running.
- **abort.** You stop a running turn.
- **rename.** You give a tab or a workspace a new name. The program applies it or refuses it.
- **close.** You close a conversation or a tab. The program decides what a close means.
- **actions.** The program puts up to four buttons of its own in the belt, and a tap runs one once.
- **history.** The program lists its conversations, open and closed, and serves the messages of each.
- **reopen.** You bring a closed conversation back. The program shows it again or refuses.

A program gets no Terminal view and no typed keys, because it has no screen. It lays out its own tabs
and workspaces, so you cannot make them by hand, and the phone has no control to close a workspace.

## History

The program keeps the record of its conversations, and Collie lists it. A program that declares
`history` serves every conversation it keeps, open and closed, newest first, and the messages of any
of them, page by page.

The home of a program is its conversation list, like the chat list of a messaging app. The
back arrow of a conversation goes there. The list has no filters. The conversations that wait on you
come first, then the other open ones, newest first, then the closed ones under the label Closed. Each
row shows the title, the time of its last activity, and one line under the title: the question that
waits on you when there is one, else the line the program gives the conversation. A mark says whether
it works, waits on you (with the number of open questions beside the title) or is idle. When the phone
shows only a program, the home has no tab bar, because a program has no files to browse and no
second view. Tap an open conversation to go to it. Tap a closed one to read it. That view is read-only: it has no field to type in and no belt. When the program
declares `reopen`, the view has a Reopen button, and the program shows the conversation again under
the same name.

Collie keeps its own copy of what it read for a live conversation, so Chat opens fast and works
when the program is slow to answer. That copy is a cache: it keeps the newest 2000 messages or
8 MiB of each conversation, and 256 MiB for the machine, and deletes the oldest conversation first,
with one line in Collie's log for each file it deletes. A closed conversation is always read from the
program, never from the copy. After a restart, Collie goes on reading where it stopped.
