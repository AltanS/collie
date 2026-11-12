# Collie inbox for pi

A [pi](https://pi.dev) extension that lets Collie hand a phone message to pi's live session through pi's
own API, `pi.sendUserMessage`, instead of typing it into the terminal (ADR 0141).

**This extension is experimental.** The bridge's pi door that talks to it is in progress.

What it does:

- No key reaches the pane, so a draft in pi's editor stays, and an open picker gets nothing.
- When pi is idle, the message starts a turn. When pi is busy, it waits as its own follow-up turn. It
  steers the running turn only when the person chose steer.
- A request id it has seen before answers what it answered then, and runs nothing. It keeps the last
  500 ids.
- What it answers is a hint. Collie settles the send from pi's own session log.

It listens on a private unix socket, `~/.local/state/collie/inbox/<pane key>.sock` (under
`XDG_STATE_HOME` when that is set). The pane key is the one that names the pane's beacon. The socket is
mode 0600 in a 0700 folder.

It opens nothing outside a multiplexer pane (tmux, zellij, Herdr, herdr-core, tern), and nothing in a pi
run with no terminal UI (`--print`, `--mode json`, `--mode rpc`).

## Routes

| Route | Body | Answer |
|---|---|---|
| `GET /hello` | none | `200 {agent, inbox, pid, sessionFile, markers}` |
| `POST /send` | `{text, requestId, steer?}` | `202 {state: "taken" \| "queued" \| "steered", replayed?}` |
| `GET /queue` | none | `200 {pending, left}`: request ids of the sends pi took this session |

A send moves from `pending` to `left` when pi settles a run with nothing queued: it ran, or Escape or Stop
put it back in pi's editor. Collie reads pi's session log to tell which, and a send the log does not
show turns its phone card to "back in the box".

A bad body answers `400`, a body over 512 KiB answers `413`, and a message pi did not take answers `409`.
None of them runs anything.

## Install

```sh
collie inbox install pi
```

That writes `collie-inbox.ts` into pi's extensions folder, `~/.pi/agent/extensions/` (under
`PI_CODING_AGENT_DIR` when that is set). It is the only thing that installs it: the bridge, `collie doctor`
and `collie update` never do. Run `/reload` in a running pi to load it.

```sh
collie inbox status pi     # not installed, current, stale, or a file of yours is in the way
collie inbox uninstall pi  # removes it, only when it is Collie's
```

Collie owns a file only when its first line is `// collie-inbox v<N>`. A file without that line is left alone,
and `install` refuses to write over it. An older copy of ours is replaced by the next `install`.

To check that it works, run this in another terminal while pi is open:

```sh
ls ~/.local/state/collie/inbox/
```
