# Durable programs in your crew

A durable program is an agent program that has no screen. It keeps its own conversations, and Collie
shows each one on your phone as a pane that has Chat and nothing else. This page explains why such a
program gets a Collie of its own, how that Collie joins your crew, and what you see on the phone. The
words are in the [Glossary](glossary.md).

> **Experimental.** The wire between Collie and a program may change in any minor release.

## One Collie per backend

A Collie watches one backend. You set it once at start with `COLLIE_MUX`. The list, the pane ids, the
capabilities and every pane route belong to that one adapter.

So a durable program gets a Collie of its own. This is true even on a host that already runs Collie
with Herdr. Two Collies run side by side, and each one has its own port and its own state folder.

## The crew is the join

The small Collie joins the crew that your main Collie leads. It works like a second laptop. The phone
keeps the same URL, and the lead merges the lists and relays the panes. There is no new door to open.

The lead must be 1.21.0 or newer to show the question card. An older lead shows the pane with "needs
you" and no card. On the peer, `collie doctor` shows the `durable-lead` row, and it warns you.

The peer joins like any other member. [Crews](crew.md#two-machines-one-crew) has the full steps.

## Two ways to reach a program

A peer uses exactly one of two ways.

- **A private socket.** The program runs on the same machine, as the same user. It listens on a Unix
  socket under `$XDG_RUNTIME_DIR`. The socket is yours alone, and that is the whole gate.
- **HTTPS with a bearer token.** Use this for a program on Cloudflare, or on any host with a
  certificate. Plain `http://` works only for `127.0.0.1` with `wrangler dev`.

Only the small Collie holds the token. The lead never sees it. Over HTTPS the token is the only gate,
so keep it secret and make it random.

The env lines, the table that compares the two ways, and the cost note are in
[durable notes](multiplexers.md#durable-notes). An idle peer reads once per 10 seconds over HTTPS,
and each read is a billed request on Cloudflare. Each example has its own README:

- [`examples/durable-member`](../examples/durable-member/README.md) runs on this machine, over the
  socket.
- [`examples/durable-member-cloudflare`](../examples/durable-member-cloudflare/README.md) runs on
  Cloudflare, over HTTPS.

The Cloudflare example runs on Cloudflare's PiHarness, and the Bun example runs Pi Durable plain. Both
use the same SDK core.

## Set it up on one host

You make a second instance, start it, and join it to the crew. Three steps.

1. Run the program. The example prints the socket it listens on.

   ```bash
   cd examples/durable-member
   bun install --frozen-lockfile
   bun run app
   ```

2. Make the second instance. Put these lines in
   `~/.config/herdr/plugins/config/herdr.collie-durable/.env`. For a socket:

   ```bash
   COLLIE_INSTANCE=durable
   COLLIE_PORT=8795
   COLLIE_STATE_DIR=/home/you/.local/state/collie-durable
   COLLIE_MUX=durable
   COLLIE_DURABLE_SOCKET=/run/user/1000/durable-member/app.sock
   ```

   For a program behind HTTPS, drop the socket line and set these two instead:

   ```bash
   COLLIE_DURABLE_URL=https://collie-durable-member.you.workers.dev
   COLLIE_DURABLE_TOKEN=your-32-byte-random-token-here
   ```

   Set the socket, or the URL with its token. Never set both. Then start the instance and check it:

   ```bash
   COLLIE_INSTANCE=durable collie start
   COLLIE_INSTANCE=durable collie doctor
   ```

3. Join the crew. Run `invite` on the lead. Run `join` on the peer, with a label so the host chip can
   tell the peer from the other Collies on that host.

   ```bash
   collie crew invite
   COLLIE_INSTANCE=durable collie crew join <lead> --label durable
   ```

   Replace `<lead>` with the address that `invite` prints. Restart the lead after the join, as
   [Crews](crew.md#two-machines-one-crew) says.

[Multiple Collie instances on one host](deployment.md#multiple-collie-instances-on-one-host) covers
the second instance in full. [Crews](crew.md#two-machines-one-crew) covers the join.

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

## Why not one Collie for everything

In 1.x one Collie drives one adapter, so a durable program and a Herdr session need two Collies. A
later design makes the session the unit, and that design changes this rule.
