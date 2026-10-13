# Durable programs

If you built an agent with Pi Durable or any long-running program, Collie can show it on your phone. Your program gets approval prompts, history and a chat view without any UI code. This is experimental: the wire may change in any minor, and today only our examples speak it.

The wire carries a version header, so a program can refuse a version it does not know, and Collie accepts the previous version for one minor release. The words are in the [Glossary](glossary.md).

## Quickstart

You need Linux and Bun 1.4 or later. Run the smallest program from a clone of Collie:

```bash
cd examples/durable-member
bun install --frozen-lockfile
bun hello.ts
```

It prints `listening /run/user/1000/hello/app.sock` and waits. In a second terminal, attach it to your Collie, then restart so Collie reads the new source:

```bash
collie durable attach hello --socket /run/user/1000/hello/app.sock
collie restart
```

Use the path your program printed. Add `--restart` to the first command to restart in the same step. Open Collie on your phone. A space named `hello` appears, with an Experimental badge, and it holds one question card: "Deploy to staging?". Tap Yes or No. The program prints your answer and exits.

## Sessions and sources

Each program you attach is a source: one entry in `sources.json`, in the config folder next to `.env`, mode `0600`. Collie turns each source into one session of its own, named after the source, beside your terminal sessions. The session is the thing, and a pane is one view of it. A conversation of the program is a pane in its session, and the phone lists the program as one space with its `mux` and where it runs under the name. Your terminal sessions look and work as before.

A program that you deployed behind TLS takes a URL and a token. Put the token in an environment variable, and name the variable. The token never goes on the command line:

```bash
export DESK_TOKEN=your-32-byte-random-token-here
collie durable attach desk --url https://desk.example.com --token-env DESK_TOKEN
```

`collie durable list` shows each source and what the running bridge says of it. `collie durable detach desk` removes one. Both `attach` and `detach` only write the file. They print "restart to apply" until you restart, or give `--restart`.

The older form still works for an instance with no terminal, such as a Windows host or a hosted program: `COLLIE_MUX=durable` with `COLLIE_DURABLE_SOCKET`, or with `COLLIE_DURABLE_URL` and `COLLIE_DURABLE_TOKEN`. The env lines, the comparison of the two transports and the reasons a program shows as unreachable are in [durable notes](multiplexers.md#durable-notes).

## Troubleshooting

`collie doctor` names the failing check. The usual causes:

- **Socket permission.** Collie connects only to a socket that you own and that has no group or other permission (mode `0600`). The path must be absolute and at most 103 bytes. The reason shows as `socket-not-private`.
- **A stale socket file.** A program that crashed can leave its socket file behind, and Collie then sees `connection refused`. Delete the file and start the program again.
- **A program restart with a question open.** An answer to a question from before the restart is `too-late`, and the card goes. A program that derives the question's id from its tool call raises the same question again, and the card comes back.
- **A version mismatch.** The reason `incompatible` shows both ranges. Update the older side.

Collie holds no model key. A program uses an API key or a ChatGPT sign-in. An Anthropic subscription may not be used through a third-party harness.

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

The home of a durable machine is its conversation list, like the chat list of a messaging app. The
back arrow of a conversation goes there. The list has no filters. The conversations that wait on you
come first, then the other open ones, newest first, then the closed ones under the label Closed. Each
row shows the title, the time of its last activity, and one line under the title: the question that
waits on you when there is one, else the line the program gives the conversation. A mark says whether
it works, waits on you (with the number of open questions beside the title) or is idle. When the phone
shows only a durable machine, the home has no tab bar, because a program has no files to browse and no
second view. Tap an open conversation to go to it. Tap a closed one to read it. That view is read-only: it has no field to type in and no belt. When the program
declares `reopen`, the view has a Reopen button, and the program shows the conversation again under
the same name.

Collie keeps its own copy of what it read for a live conversation, so Chat opens fast and works
when the program is slow to answer. That copy is a cache: it keeps the newest 2000 messages or
8 MiB of each conversation, and 256 MiB for the machine, and deletes the oldest conversation first,
with one line in Collie's log for each file it deletes. A closed conversation is always read from the
program, never from the copy. After a restart, Collie goes on reading where it stopped.
