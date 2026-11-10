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

A bad body answers `400`, a body over 512 KiB answers `413`, and a message pi did not take answers `409`.
None of them runs anything.

## Install

```sh
mkdir -p ~/.pi/agent/extensions
cp pi-extension/collie-inbox.ts ~/.pi/agent/extensions/
```

Run `/reload` in a running pi to load it. To check that it works, run this in another terminal while
pi is open:

```sh
ls ~/.local/state/collie/inbox/
```

To remove it, delete `~/.pi/agent/extensions/collie-inbox.ts`.
