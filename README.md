# Collie

A phone web UI to monitor and reply to your [Herdr](https://herdr.dev) agent herd, served over
Tailscale — open a URL, see which agent needs you, and reply with your phone's native keyboard
(voice dictation included). Each agent gets a colored terminal mirror, an agent-aware
slash-command palette, and a special-keys pad.

It's a Herdr plugin (a thin launcher) plus a Bun/TypeScript bridge that runs as a `systemd --user`
service and serves a Vite + React + shadcn PWA.

## ⚠️ Security — read this before you run it

> **Collie is, by design, remote shell access to your machine.** One bridge call types arbitrary
> text and keystrokes into a live terminal pane — so anyone who can reach the web UI can drive your
> agents *and* run shell commands as you. There's no command allow-list (that would defeat the
> purpose). Treat the URL like a root login, because it is one.

### What exposing it actually grants

Putting Collie on your tailnet hands everyone who can reach the URL the ability to:

- **Read every terminal pane** — source, secrets, tokens, env, file contents and agent output all
  scroll past in the mirror.
- **Type anything into any pane** — i.e. run arbitrary shell commands as your user: read
  `~/.ssh`, `git push --force`, `rm -rf`, `sudo` if your account can.
- **Start, kill and create panes/agents**, and **upload files** onto the host.

Two things make this sharper than it sounds:

- **It acts as _you_, with your full user privileges.** There is no sandbox and no command
  allow-list — anything your shell can do, the URL can do.
- **Access is device-level, not person-level.** Tailscale identity proves the _device/account_,
  not who's holding it; there's no password and no enforced session, so an unlocked or stolen
  phone — or any other principal on your tailnet — is an open shell. The in-app idle-lock is a UX
  convenience, not authentication.

**Your blast radius is everything that can reach the URL** — by default every device and user on
your tailnet, plus whatever those devices bridge to. Narrow it with Tailscale ACLs and
`COLLIE_TRUSTED_USER`. There is no audit log: actions are indistinguishable from you typing at the
keyboard.

It's built single-user and tailnet-only. The defenses, described honestly:

- **Loopback bind only (`127.0.0.1`)** — never bind `0.0.0.0`, which turns every other check into
  theater.
- **`tailscale serve` is the sole ingress** — it terminates TLS on your tailnet and injects the
  identity header the bridge trusts.
- **Optional identity gate:** set `COLLIE_TRUSTED_USER` and requests whose
  `Tailscale-User-Login` header (added by `serve`) isn't you are rejected.
- **Same-origin gate + strict CSP**, and pane output renders as React text nodes (never `innerHTML`),
  so a hostile filename or agent line can't inject script that calls back into the socket.

> 🚫 **Never `tailscale funnel` this** — funnel exposes it to the public internet; `serve` keeps it
> tailnet-only. There is no scenario where funneling Collie is correct.

Running it means accepting that anyone with access to your tailnet node — or a borrowed, unlocked
phone — can act as you. If that's not obviously fine for your setup, don't deploy it. Provided
as-is, no warranty.

## Requirements

Install these on the **host machine** (the tailnet node your agents run on) before you start:

| Tool | Why | Notes |
| --- | --- | --- |
| [**Bun**](https://bun.sh) | Runs the bridge **and** builds the web UI | The only hard runtime dependency. |
| [**Herdr**](https://herdr.dev) ≥ 0.7.0 | The agent herd Collie mirrors; the `herdr` CLI registers the plugin | Collie talks to its Unix socket (`$HERDR_SOCKET_PATH`). |
| [**Tailscale**](https://tailscale.com) | The sole ingress — `tailscale serve` exposes the bridge to your phone | Without it the bridge still runs, but on `127.0.0.1` only (no phone access). |
| **git** | To clone this repo | — |

Soft dependencies (everything still works without them, with the noted degradation):

- **Node.js** — only the `url`/`status` helpers use it to parse `tailscale status --json`. Missing
  Node just means the URL isn't auto-printed; the bridge runs fine.
- **`systemd --user`** (Linux) — supervises the bridge so it restarts on failure and survives login
  sessions. On macOS or hosts without it, the control script falls back to a `nohup` background
  process with a pidfile.

You don't install the JS/TS dependencies by hand — the first build runs `bun install` inside
`web/` for you. The backend (`src/`) needs no install step (it imports only Bun + `node:*`
built-ins; the optional [`web-push`](https://www.npmjs.com/package/web-push) is loaded lazily and
only if you opt into notifications — see [Web Push](#web-push-optional)).

## Install

Run these on the host, **not** your phone. Clone anywhere you like — the plugin is registered by
path, so it can live in your usual projects dir.

```bash
git clone https://github.com/AltanS/collie.git
cd collie

herdr plugin link "$(pwd)"                                  # register with Herdr (by path)
herdr plugin action invoke start --plugin herdr.collie      # build + start + serve + print URL
```

That second command (a thin wrapper over `scripts/collie-ctl.sh start`):

1. **builds the web UI** into `web/dist` (runs `bun install` + `bun run build` on first run),
2. **starts the bridge** as a `systemd --user` service named `collie` (or a `nohup` process where
   systemd isn't available),
3. **runs `tailscale serve`** to expose it tailnet-only over HTTPS, and
4. **prints the tailnet URL**.

Open that URL on your phone and **Add to Home Screen** to install the PWA.

> Prefer not to go through Herdr? You can run the control script directly:
> `scripts/collie-ctl.sh start`. Same effect.

### Configure (optional)

All settings have single-user defaults; override them via a `.env` in the plugin config dir
(`~/.config/collie` by default):

```bash
cp .env.example "$(herdr plugin config-dir herdr.collie)/.env"
# then edit it — e.g. set COLLIE_TRUSTED_USER, COLLIE_PORT, or COLLIE_SERVE_MODE=http for Headscale
```

See [`.env.example`](./.env.example) for every option (port, identity gate, poll cadence, push).

### Web Push (optional)

Push notifications are off unless you opt in. Install the lazy dependency and generate VAPID keys:

```bash
bun add web-push
bunx web-push generate-vapid-keys
# put COLLIE_VAPID_PUBLIC / COLLIE_VAPID_PRIVATE / COLLIE_VAPID_SUBJECT in your .env, then restart
```

## Manage & update

Day-to-day control (via Herdr actions or `scripts/collie-ctl.sh <cmd>` directly):
`start` · `stop` · `restart` · `build` · `status` · `url` · `logs`.

To update after a `git pull`:

- **Frontend only** (`web/`): rebuild with `scripts/collie-ctl.sh build` (or `bun run build`). The
  bridge serves `web/dist` from disk, so the rebuild is **live immediately — no restart**.
- **Backend** (`src/*.ts`): `systemctl --user restart collie` — Bun does **not** hot-reload the
  service.

For development hooks, run `scripts/install-hooks.sh` once to activate the repo's pre-commit /
pre-push checks (version enforcement + tests).

## Architecture

A small Bun process sits between your phone and Herdr — the browser never touches the socket.

```
  phone (PWA)
     │  HTTPS over the tailnet
     ▼
  tailscale serve        terminates TLS, injects the Tailscale-User-Login identity header
     │  127.0.0.1:PORT    (the bridge binds loopback only)
     ▼
  Collie bridge (Bun)    serves the built UI + a small JSON API; polls Herdr, fans state to browsers
     │  newline-delimited JSON, one-shot RPC over a Unix socket
     ▼
  Herdr server           owns the panes, agents and live terminal state
```

- **One module touches the socket.** `src/herdr-client.ts` is the only code that knows Herdr's
  method names; everything else speaks the bridge's HTTP API.
- **Polling, not subscriptions.** A `StateEngine` polls Herdr every `COLLIE_POLL_MS`, builds a
  snapshot (agents, shell panes, spaces/tabs) and detects status transitions (used for push). The
  browser in turn polls `/api/snapshot` on an adaptive interval — so there's no socket-resync logic
  to get wrong, and a dropped poll just retries next tick.
- **Reads and actions are plain HTTP.** The detail view `GET`s a pane's recent scrollback; a reply
  or special key `POST`s to `/api/pane/:id/{reply,keys}`, which the bridge translates into a Herdr
  `pane.send_keys`. That last hop types into a real terminal — hence the security posture above.
- **The UI is a static PWA.** Vite builds `web/` into `web/dist`, which the bridge serves from disk,
  so a frontend rebuild is live with no restart.

## More

- Design & rationale — [`DESIGN.md`](./DESIGN.md)
- Verified Herdr socket API — [`HERDR_API.md`](./HERDR_API.md)
- Ops, versioning & conventions — [`CLAUDE.md`](./CLAUDE.md)
- Changes — [`CHANGELOG.md`](./CHANGELOG.md)
