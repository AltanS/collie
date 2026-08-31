# Install Collie

What Collie needs on the host, the four ways in, and what the first `start` leaves behind. Read
[Security](security.md) before you run any of it — a Collie is remote shell access to your machine,
by design.

## Requirements

On the **host** (the tailnet node your agents run on). Two things decide what you need: **which
install route you take** (the script ships a built binary, so it needs no toolchain; building from
source needs one) and **which multiplexer you mirror** (only the Herdr one needs Herdr).

| Tool | Needed for | Why |
| --- | --- | --- |
| **`curl`, `tar`, and a sha256 tool** (`sha256sum` or `shasum`) | the install script, and every later `collie update` on a binary install | Download the release for your platform and verify its digest before anything is laid down. The payload is already built, so there is no toolchain and nothing to compile. |
| [**Bun**](https://bun.sh) | building from source | Runs the bridge and builds the web UI. A binary install carries its own runtime and does not need Bun on the host. |
| **git** | building from source, and both Herdr routes | Clone the repository, and let `update` advance that checkout. A binary install updates by fetching a release, not by pulling. |
| **A multiplexer** — Herdr, [tmux](https://github.com/tmux/tmux) or [zellij](https://zellij.dev) | every install | What Collie mirrors, one per install, picked with `COLLIE_MUX` — or by the first `start`, which probes for all three and asks when that key is unset. **tmux and zellij are experimental in 1.0** — set them up from [Using the app on tmux or zellij](multiplexers.md#using-the-app-on-tmux-or-zellij). What each one can answer: [`MUX_CONTRACT.md`](../MUX_CONTRACT.md). |
| [**Herdr**](https://herdr.dev) ≥ 0.7.0 | only when Herdr is your multiplexer | One of the three, and the default the first `start` offers. Check with `herdr --version`. On tmux or zellij it need be neither installed nor running. |
| [**Tailscale**](https://tailscale.com) | the default front door | `tailscale serve` publishes Collie on your tailnet. Optional if you run [Variant C](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) behind your own reverse proxy. Without any front door, Collie is `127.0.0.1`-only. |

**No minimum tmux or zellij version is enforced** — the adapters were probed on tmux 3.6b and zellij
0.44.2, and neither declares a floor. One tmux caveat is checked at runtime: on a server whose
`window-size` is `manual`, tmux below 3.7 crashes when a window is opened, so Collie refuses to open
one and tells you to run `tmux set -g window-size latest`.

Soft dependencies: **Node.js** (the `collie` CLI uses it to extract your MagicDNS name from
`tailscale status --json`; without it the banner falls back to the loopback URL) and a **service
supervisor** — `systemd --user` on Linux, **launchd** on macOS (both ship with the OS); a host with
neither falls back to an unsupervised `nohup` process. You never install JS
deps by hand — the build runs `bun install` for you; the backend imports only Bun + `node:*`.
[`web-push`](https://www.npmjs.com/package/web-push) is optional and lazy (see [Web
Push](voice-and-push.md#web-push-optional)).

**Linux and macOS are the supported hosts.** The bridge itself also runs on **Windows**
(experimental) against Herdr's Windows beta — see [Windows](../README.md#windows-experimental).

## Install

On the host, not your phone. Four ways in — a script, a build you drive yourself, and two through
Herdr. All four end in the same place: a `collie` on your PATH, a built UI, and one multiplexer to
mirror. Herdr is the last two routes, not the first: it is one of the three multiplexers Collie
drives, never a dependency of the program.

### The install script

The short way. It downloads the newest release for your platform, verifies its sha256, lays it down
and puts `collie` on your PATH — then stops and prints what is left, because choosing a multiplexer
and seeding a config are decisions, not steps:

```bash
curl -fsSL https://colliepwa.dev/install.sh | sh
```

That URL is a copy the site serves. **The canonical source is `scripts/install.sh` in Collie's
repository**, and reading it before you run it is the right instinct — it is one page of POSIX `sh`,
and it never asks for `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/AltanS/collie/main/scripts/install.sh | less
curl -fsSL https://raw.githubusercontent.com/AltanS/collie/main/scripts/install.sh | sh
```

It installs into `~/.local/share/collie` (`COLLIE_DIR` moves that) as
`versions/<x.y.z>/` with a `current` symlink, takes the newest **stable** release, and refuses to
touch an install that is already there — `collie update` is the tool for one of those. It needs
`curl`, `tar` and a sha256 tool, and no toolchain: the payload is already built. Pass `--beta` to
take the newest prerelease instead, which is the deliberate opt-in described in
[Testing the v1 beta](upgrading.md#testing-the-v1-beta).

#### The same result, from source

The script is a convenience and must never be the only door. Building from source is fully supported
— it is the route for musl systems, for platforms the release matrix does not publish yet, and for
anyone who will not run a downloaded binary — and it leaves you with the same three things: a
checkout, a built UI and a `collie` on your PATH.

```bash
# 1. clone, and check out the newest stable release — the tags are the contract
git clone https://github.com/AltanS/collie.git ~/.local/share/collie
cd ~/.local/share/collie
git checkout --detach "$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"

# 2. build — the shim finds Bun and compiles bin/collie, then builds the web UI
sh scripts/collie-ctl.sh build

# 3. put `collie` on your PATH, as a symlink to this checkout's binary
bin/collie link
```

Then the same finishing steps the script prints, with this route's paths:

```bash
mkdir -p ~/.config/collie
cp ~/.local/share/collie/.env.example ~/.config/collie/.env
# optional: name COLLIE_MUX in that file — herdr, tmux or zellij.
# Leave it out and the first `start` probes for all three and asks you.
collie start
```

### Without Herdr (tmux or zellij)

The route that never mentions Herdr. Herdr is one of Collie's three multiplexers, not a dependency of
the program: with `COLLIE_MUX=tmux` or `COLLIE_MUX=zellij` the bridge builds only the adapter you
named and never dials Herdr's socket, so Herdr need not be installed. Name it **before the first
start** and nothing is asked; leave it out and the first `start` asks.

```bash
git clone https://github.com/AltanS/collie.git && cd collie
mkdir -p ~/.config/collie          # `start` would create it later; the `cp` below needs it now
cp .env.example ~/.config/collie/.env
```

`~/.config/collie/` is where a Herdr-less Collie ends up: it asks Herdr where the plugin's config
dir is, and with no Herdr to ask, that is the directory it falls back to. Nothing seeds the `.env`
for you — the copy above is the whole of it. Now name your multiplexer in that file, and the
endpoint that says *which* tmux server or *which* zellij session:

```bash
COLLIE_MUX=tmux                                           # or: zellij
COLLIE_MUX_ENDPOINT_TMUX=/run/user/1000/collie-tmux.sock  # zellij: COLLIE_MUX_ENDPOINT_ZELLIJ=<session>
```

What each endpoint accepts, and how to give the multiplexer something worth mirroring, is
[Using the app on tmux or zellij](multiplexers.md#using-the-app-on-tmux-or-zellij) — worth reading before you
start rather than after. Then start it:

```bash
scripts/collie-ctl.sh start
```

That first run compiles `bin/collie` — the full build, typecheck and web bundle, so give it a
minute — and every command from then on is spelled `bin/collie <verb>` ([Commands](commands.md)).
`start` itself does the same four things the Herdr routes below list.

**Skip the `.env` and the first `start` asks you.** It looks for a live Herdr socket, a running tmux
server and zellij sessions, prints what it found, and writes your answer into the `.env` for you. With
no terminal to ask at — a provisioning run, a systemd unit — it takes the only multiplexer it found
and says which and why; with none or with several it refuses to start and names `COLLIE_MUX` as the
one line that settles it. `bin/collie doctor` reports the same decision, and the evidence behind it.

### Through Herdr

**Both Herdr routes need Herdr's server running first** — start the Herdr TUI (`herdr`), or
`herdr server &`. Without it the `invoke start` lines below fail on the socket with
`server_not_running`. None of that applies to the two routes above.

**From GitHub (turnkey)** — Herdr fetches and builds for you:

```bash
# needs Herdr 0.7.0+ (`herdr --version`), with its server already running
herdr plugin install AltanS/collie
herdr plugin action invoke start --plugin herdr.collie
```

That bare `install` line above tracks the STABLE line only. For the v1 prerelease train, see
[Testing the v1 beta](upgrading.md#testing-the-v1-beta).

**From a local clone (for development)** — registered by path:

```bash
# needs Herdr 0.7.0+ (`herdr --version`), with its server already running
git clone https://github.com/AltanS/collie.git && cd collie
herdr plugin link "$(pwd)"
herdr plugin action invoke start --plugin herdr.collie
```

Either way, `start` does four things:

1. **builds** `web/dist` if it's missing (typechecked, staged, swapped in atomically),
2. **starts the bridge** as the `systemd --user` service `collie` (`nohup` fallback without systemd),
3. **publishes it on the tailnet** — literally `tailscale serve --bg 8787`: HTTPS on the host's
   MagicDNS name, `:443 → 127.0.0.1:8787`, tailnet-only,
4. **prints the banner** with the URL to open — walked through line by line in
   [First run](#first-run--what-youll-see).

## First run — what you'll see

The transcripts below are the CLI's inline output. **Through `invoke start` you get Herdr's JSON
envelope instead** — the same text is the action's *captured stdout*, read with
`herdr plugin log list --plugin herdr.collie`.

```console
$ bin/collie start
building web UI (first run)…                    # linked clone only; a GitHub install already built
…bun install · typecheck · vite build output…
bridge started (systemd --user: collie)
tailscale serve (https) → tailnet :443 -> 127.0.0.1:8787

  ✓ Collie is running  ·  v0.15.0+174c4e4
    service   systemd --user (collie) · active
    local     http://127.0.0.1:8787
    tailnet   https://myhost.tail1234.ts.net
```

The `✓` is a real probe — Collie connected to the bridge's port and got an answer, not just
"the unit is active". If you get `⚠ Collie isn't answering on :8787 yet` instead, see
[Troubleshooting](troubleshooting.md#troubleshooting).

### What just happened

`start` left three durable things on the host:

1. **`web/dist`** — the built UI, served from disk, so later rebuilds go live without a restart.
2. **A supervised user service** — a `systemd --user` unit named `collie`, or a launchd agent on
   macOS ([Surviving reboots](upgrading.md#surviving-reboots) has the details of both).
3. **A tailnet-only `tailscale serve` mapping** — HTTPS on the host's MagicDNS name,
   `:443 → 127.0.0.1:8787`, TLS terminated by Tailscale. Inspect with `tailscale serve status`;
   remove just this mapping with `bin/collie unserve`.

`stop` merely pauses the service; `uninstall` reverses 2 + 3 and keeps your `.env` and the checkout.
Why a service and not a Herdr pane: [`ARCHITECTURE.md`](../ARCHITECTURE.md) §3.

Two questions are still open at this point, and each has one answer: *who* may reach it is
`COLLIE_TRUSTED_USER` ([Configure](configure.md#configure)), and *which devices* may write is
[pairing](security.md#pair-a-device--the-write-credential) — one command, `bin/collie pair`.

### Open it on your phone

The URL is the banner's `tailnet` line — print it again anytime with `bin/collie url`, or
`bin/collie qr` to print it as a QR code you can scan rather than type a MagicDNS name into a phone
keyboard. It resolves for any device on your tailnet, so the phone needs the Tailscale app installed
and connected to the same tailnet as the host. **Pair this phone while you are holding it** —
`bin/collie pair` on the host, then Settings → Paired devices — because pairing the first device is
what turns the requirement on for every other one
([Pair a device](security.md#pair-a-device--the-write-credential)).

Then install it as an app: **iOS** — Safari → share sheet → *Add to Home Screen*. **Android** —
Chrome → ⋮ menu → *Add to Home screen* (or *Install app*). Installing (and Web Push) needs the
HTTPS origin the default serve mode already provides; over `COLLIE_SERVE_MODE=http` the page works,
but service worker and install silently no-op.

### Is it actually working?

A sixty-second check, host side then phone side:

```console
$ bin/collie status

  ✓ Collie is running  ·  v0.15.0+174c4e4
    service   systemd --user (collie) · active
    local     http://127.0.0.1:8787
    tailnet   https://myhost.tail1234.ts.net

  serve config:
    https://myhost.tail1234.ts.net (tailnet only)
    |-- / proxy http://127.0.0.1:8787
```

```console
$ bin/collie logs        # journal timestamps trimmed here
[push] disabled (no VAPID keys configured)
[bridge] listening on http://127.0.0.1:8787  (poll 1500ms)
[bridge] WARNING: COLLIE_TRUSTED_USER is empty — any tailnet device/user that reaches the bridge gets full write access. Set it to your tailnet login (see README → Variant A).
```

**That WARNING is expected on a fresh install** — identity is still open. Host-header validation is
already on (`collie start` wrote this node's tailnet name into the unit). Closing it is one line in
your `.env` — `COLLIE_TRUSTED_USER=you@example.com`, your own tailnet login — followed by
`bin/collie restart`; [Configure](configure.md#configure) puts it in context. (The loopback URL in the log is
also correct: Collie itself only ever binds `127.0.0.1` — `tailscale serve` is what makes it
reachable.) `[push] disabled` is expected too: notifications are
opt-in, and [Web Push](voice-and-push.md#web-push-optional) is three commands.

On the phone: your agents are listed, and the footer build stamp (`v0.9.0 · debcff9 · …`) matches
`bin/collie version`. If the page loads but stays empty, that's the same-origin gate — see
[Troubleshooting](troubleshooting.md#troubleshooting).


---

[← back to the README](../README.md)
