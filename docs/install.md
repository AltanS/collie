# Install Collie

Host requirements, the four installation methods, and what the first `start` writes to disk. Read
[Security](security.md) before installing. Collie exposes remote shell access to your machine by
design.

## Requirements

On the **host** (the tailnet node your agents run on). Host requirements depend on two choices:
**the install method** (the script downloads a prebuilt binary and requires no toolchain, while
building from source requires one) and **the target multiplexer** (only the Herdr backend requires
Herdr).

| Tool | Needed for | Why |
| --- | --- | --- |
| **`curl`, `tar`, and a sha256 tool** (`sha256sum` or `shasum`) | the install script, and every later `collie update` on a binary install | Download the release for your platform and verify its digest before extraction. The binary release includes all runtime dependencies, so no compiler is required. |
| [**Bun**](https://bun.sh) | building from source | Runs the bridge and builds the web UI. Binary installs include an embedded runtime and do not require host Bun. |
| **git** | building from source, and both Herdr routes | Clones the repository and lets `update` pull new commits. Binary installs update by downloading releases instead of using git. |
| **A multiplexer** — Herdr, [tmux](https://github.com/tmux/tmux) or [zellij](https://zellij.dev) | every install | The multiplexer Collie mirrors. Select one via `COLLIE_MUX`. If unset, the first run of `start` detects available multiplexers and prompts for a choice. **tmux and zellij are experimental in 1.0**; see [Using the app on tmux or zellij](multiplexers.md#using-the-app-on-tmux-or-zellij). For feature support per backend, see [`MUX_CONTRACT.md`](../MUX_CONTRACT.md). |
| [**Herdr**](https://herdr.dev) ≥ 0.7.0 | only when Herdr is your multiplexer | Default option suggested by `start`. Check version with `herdr --version`. Not required when targeting tmux or zellij. |
| [**Tailscale**](https://tailscale.com) | the default front door | `tailscale serve` exposes Collie to your tailnet. Optional if using [Variant C](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) with a standalone reverse proxy. Without a proxy or Tailscale, Collie binds only to `127.0.0.1`. |

**No minimum tmux or zellij version is enforced**. The adapters were tested against tmux 3.4, tmux
3.6b, and zellij 0.44.2, and do not declare a minimum version. tmux 3.4 handles `-F` separator
escaping differently from 3.6b; Collie parses both formats and surfaces parse failures as
multiplexer errors instead of rendering an empty dashboard. For tmux, Collie checks one runtime edge
case: on servers using `window-size manual`, tmux versions below 3.7 crash when creating windows.
Collie detects this condition, blocks the creation request, and prompts you to run
`tmux set -g window-size latest`.

Soft dependencies: **Node.js** (used by the `collie` CLI to parse MagicDNS names from
`tailscale status --json`; if missing, the startup banner prints the loopback URL instead) and a
**service supervisor** (`systemd --user` on Linux, **launchd** on macOS). If no supervisor is found,
Collie starts an unmanaged process via `nohup`. JavaScript dependencies do not require manual
installation; the build script executes `bun install` automatically, and the backend relies strictly
on Bun built-ins and `node:*` modules. [`web-push`](https://www.npmjs.com/package/web-push) is an
optional dependency loaded on demand (see [Web Push](voice-and-push.md#web-push-optional)).

**Linux and macOS are the supported hosts.** The bridge also runs on **Windows** (experimental) with
the Herdr Windows beta; see [Windows](../README.md#windows-experimental).

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

Set `COLLIE_TAG=vX.Y.Z` to pin an exact release tag instead of taking the newest one — a
prerelease tag works too, and it skips the GitHub tags API entirely:

```bash
COLLIE_TAG=v1.0.0-beta.49 curl -fsSL https://colliepwa.dev/install.sh | sh
```

`COLLIE_TAG` also works over an existing binary install, as a rescue: it lays the pinned version
beside the current one and flips the `current` symlink, without touching anything else — see
[When collie will not run](upgrading.md#when-collie-will-not-run).

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

The transcripts below show the CLI's standard output. **Running via `invoke start` produces Herdr's
JSON envelope instead**. The same text is stored as captured stdout, accessible through
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

The `✓` marks an active health check: Collie connected to the bridge port and received a response.
It does not simply check that the unit is active. If you see
`⚠ Collie isn't answering on :8787 yet`, refer to
[Troubleshooting](troubleshooting.md#troubleshooting).

### What just happened

`start` configured three persistent items on the host:

1. **`web/dist`**: the compiled UI assets, served directly from disk so updates take effect without
   restarting the daemon.
2. **A supervised user service**: a `systemd --user` unit named `collie`, or a launchd agent on
   macOS. See [Surviving reboots](upgrading.md#surviving-reboots) for platform details.
3. **A tailnet-scoped `tailscale serve` proxy**: terminates TLS on the host's MagicDNS domain and
   proxies `:443 → 127.0.0.1:8787`. Check this with `tailscale serve status`, or remove it with
   `bin/collie unserve`.

Running `stop` pauses the service. Running `uninstall` removes the service definition and the
Tailscale proxy while leaving your `.env` and repository intact. The design choice to use a system
service instead of a Herdr pane is explained in [`ARCHITECTURE.md`](../ARCHITECTURE.md) §3.

Two access control steps remain. User authorization is controlled by `COLLIE_TRUSTED_USER`
([Configure](configure.md#configure)). Device write permissions require
[pairing](security.md#pair-a-device--the-write-credential), initiated via `bin/collie pair`.

### Open it on your phone

Access the web interface at the `tailnet` URL from the startup banner. You can display it again with
`bin/collie url`, or generate a terminal QR code with `bin/collie qr`. The URL resolves across your
tailnet, requiring the Tailscale client on your phone connected to the same tailnet as the host.
**Pair this initial phone immediately**: run `bin/collie pair` on the host, then navigate to
Settings → Paired devices. Pairing the first client enforces the write credential requirement
globally ([Pair a device](security.md#pair-a-device--the-write-credential)).

To install the client as a PWA: on **iOS**, open Safari, tap the share icon, and select *Add to Home
Screen*. On **Android**, open Chrome, tap the menu, and select *Add to Home screen* (or *Install
app*). PWA installation and Web Push require HTTPS, provided by the default serve configuration.
Running with `COLLIE_SERVE_MODE=http` loads the site, but service workers and home screen
installation are disabled.

### Is it actually working?

Verify the deployment on both the host and client:

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

**The WARNING is normal on initial setup** before you configure user identity. Host-header checks
are active because `collie start` wrote the node's tailnet hostname into the service unit. To
restrict access, set `COLLIE_TRUSTED_USER=you@example.com` in `.env` using your Tailscale identity,
then run `bin/collie restart`. See [Configure](configure.md#configure) for details. The local
loopback address in the log is expected: Collie binds exclusively to `127.0.0.1`, and
`tailscale serve` handles remote access. The `[push] disabled` entry is also standard, as
[Web Push](voice-and-push.md#web-push-optional) requires separate setup.

On your phone, verify that your agents appear in the list and that the footer version string
(`v0.9.0 · debcff9 · …`) matches `bin/collie version`. If the page renders without content, check
the same-origin configuration in [Troubleshooting](troubleshooting.md#troubleshooting).


---

[← back to the README](../README.md)
