# Install Collie

Host requirements, the two ways in, and first-run setup. Read [Security](security.md) first:
Collie exposes remote shell access to your machine by design.

## Requirements

Supported hosts: Linux and macOS. Windows is experimental; see
[Windows](../README.md#windows-experimental).

| Tool | Needed for | Purpose |
| --- | --- | --- |
| `curl`, `tar`, sha256 tool (`sha256sum`/`shasum`) | Binary install script and updates | Download and verify release archives. |
| [Bun](https://bun.sh) | Source builds | Run the bridge and build the web UI. |
| git | Source builds and Herdr routes | Clone and update the repository. |
| Multiplexer: Herdr, [tmux](https://github.com/tmux/tmux), or [zellij](https://zellij.dev) | All installs | Mirrored backend set via `COLLIE_MUX`. tmux and zellij are experimental in 1.0; see [Pointing Collie at a multiplexer](multiplexers.md#pointing-collie-at-a-multiplexer) and [`MUX_CONTRACT.md`](../MUX_CONTRACT.md). |
| [Herdr](https://herdr.dev) ≥ 0.7.0 | Herdr backend only | Required when `COLLIE_MUX=herdr`. Check with `herdr --version`. |
| [Tailscale](https://tailscale.com) | Default access | `tailscale serve` proxies Collie to your tailnet. Optional if using [Variant C](deployment.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale). |

> **Note.** No minimum tmux or zellij version is enforced. The adapters were tested against tmux
> 3.4, tmux 3.6b and zellij 0.44.2. One tmux edge case is handled: on a server using
> `window-size manual`, tmux below 3.7 crashes when creating a window, so Collie blocks the request
> and tells you to run `tmux set -g window-size latest`.

Soft dependencies, needed only for the features next to them:

| Tool | Needed for |
| --- | --- |
| Node.js | Formats MagicDNS names in logs. |
| systemd / launchd | Service supervision; falls back to `nohup`. |
| [`web-push`](https://www.npmjs.com/package/web-push) | Optional, see [Web Push](voice-and-push.md#web-push-optional). |

## Install

Three ways in:

- **[Fresh install](#fresh-install)** — the install script, or the same result from source.
- **[Through Herdr](#through-herdr)** — Collie goes in as a Herdr plugin, driven by plugin actions.
- **[From a package](#from-a-package)** — your package manager installs Collie and owns its
  updates.

Herdr is one of the three multiplexers Collie can mirror, not a dependency of the program. Which one
you mirror is the [step after this](#name-your-multiplexer).

### Fresh install

The install script downloads the latest release into `~/.local/share/collie` (`COLLIE_DIR`) and links
the binary to `~/.local/bin/collie`:

```bash
curl -fsSL https://colliepwa.dev/install.sh | sh
```

It takes the newest stable release and refuses to touch an install that is already there — that is
what `collie update` is for. The canonical source is `scripts/install.sh` in the repository: one page
of POSIX `sh`, and it never asks for `sudo`.

```bash
curl -fsSL https://raw.githubusercontent.com/AltanS/collie/main/scripts/install.sh | less
curl -fsSL https://raw.githubusercontent.com/AltanS/collie/main/scripts/install.sh | sh
```

If `~/.local/bin` is not on your PATH, run the binary directly:

```bash
~/.local/share/collie/current/bin/collie version
```

To pin a version or rescue an existing install (see
[When collie will not run](upgrading.md#when-collie-will-not-run)):

```bash
curl -fsSL https://colliepwa.dev/install.sh | COLLIE_TAG=v1.0.0 sh
```

For prereleases, pass `--beta`: it takes the newest prerelease, and the install then tracks that
major's prereleases until the final release ships
([Prereleases](upgrading.md#prereleases)).

#### The same result, from source

```bash
# 1. Clone and checkout latest stable tag
git clone https://github.com/AltanS/collie.git ~/.local/share/collie
cd ~/.local/share/collie
git checkout --detach "$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"

# 2. Build runtime and UI
bash scripts/collie-ctl.sh build

# 3. Verify
bin/collie version

# 4. Optional: link to PATH
bin/collie link
```

Then start it. `start` creates `~/.config/collie/` and writes your multiplexer choice into its
`.env`, so there is nothing to seed by hand first:

```bash
bin/collie start
```

### Through Herdr

Start the Herdr server first (`herdr` or `herdr server &`).

**From GitHub:**

```bash
herdr plugin install AltanS/collie
herdr plugin action invoke start --plugin herdr.collie
```

**From local source:**

```bash
git clone https://github.com/AltanS/collie.git && cd collie
herdr plugin link "$(pwd)"
herdr plugin action invoke start --plugin herdr.collie
```

Manage via [Herdr actions](commands.md#herdr-actions). For a prerelease, install the tag with
`herdr plugin install AltanS/collie --ref <tag> --yes`, which is the whole opt-in
([Prereleases](upgrading.md#prereleases)).

### From a package

Where Collie is packaged for your system, install it the way you install anything else. The package
carries the compiled binary the release already publishes, so nothing is built on your machine: no
Bun, no `git`, no compilation. The whole release folder lands under one prefix, with `collie` on
your PATH as a symlink into it.

A package is not a Herdr plugin. There is no `herdr plugin link` step: the plugin path registers
action buttons that update a checkout, and this tree is your package manager's to update. Every
`collie` verb on your PATH works the same either way.

#### Arch

```bash
paru -S collie-bin     # or: yay -S collie-bin
collie start
```

`collie-bin` comes from the AUR, which plain `pacman` cannot fetch, so an AUR helper is the short
way. Without one, build it yourself:

```bash
git clone https://aur.archlinux.org/collie-bin.git && cd collie-bin
makepkg -si
```

Both routes run the same `PKGBUILD`, which downloads the release tarball for your architecture and
checks its sha256 against the release's integrity manifest. Later updates are `paru -S collie-bin`
or `yay -S collie-bin`, the same command you installed with. `sudo pacman -Syu collie-bin` works
only where a repository carries the package, such as Omarchy's.

The package installs the release tree to `/usr/lib/collie` and `/usr/bin/collie` as a symlink into
it. It provides and conflicts with `collie`, so it and a future source package cannot both be
installed. It enables no systemd unit: `collie start` writes your own `--user` unit, as it does
after any install.

> **Note.** Updates come from your package manager, and Collie will not update itself here.
> `collie update` declines instead, and the phone shows the new version with the package command
> where the update button would be. Collie names the `sudo pacman -Syu collie-bin` form, which is
> the repository spelling; on an AUR install run your helper instead.

In a [pack](pack.md), this machine never takes an update from the phone: the pack lists it as
"waits for the package manager", and it levels only when you run your helper on it.

Remove it with `collie stop` first, then:

```bash
sudo pacman -R collie-bin
```

The package owns `/usr/lib/collie` and `/usr/bin/collie`, and removing it removes only those. Your
own files stay: state in `~/.local/state/collie` (or `$COLLIE_STATE_DIR`), configuration in
`~/.config/collie`, and the `systemd --user` unit at `~/.config/systemd/user/collie.service` that
`collie start` wrote. Run `collie uninstall` before removing the package to drop that unit and the
port mapping, and delete the two directories yourself when you want them gone.

#### Nix

```bash
nix profile install github:AltanS/collie#collie
collie start
```

The flake exports `packages.<system>.collie` for `x86_64-linux`, `aarch64-linux` and
`aarch64-darwin`. It fetches that platform's release tarball by the sha256 in the release's own
integrity manifest, patches the binary's interpreter on Linux, and installs the release tree to
`<store-path>/lib/collie` with `bin/collie` as a symlink into it. Run it once without installing
with `nix run github:AltanS/collie#collie -- doctor`.

There is no source build, on purpose: installing the dependencies needs the network and a Nix
derivation has none, so the package wraps the binary the release already publishes and checksums.

There is no NixOS module yet, only the flake package, so `nix profile` is the path: install it into
your profile as above, or add the flake output to a `home-manager` or `environment.systemPackages`
list yourself.

> **Note.** Updates come from nix, and Collie will not update itself here. `collie update` declines
> and names `nix profile upgrade collie` instead, and the phone shows the new version with that
> command where the update button would be.

In a [pack](pack.md), this machine never takes an update from the phone: the pack lists it as
"waits for the package manager", and it levels only when you run nix on it.

Remove it with `collie stop` first, then:

```bash
nix profile remove collie
```

That drops the store path from your profile and nothing else. Your own files stay: state in
`~/.local/state/collie` (or `$COLLIE_STATE_DIR`), configuration in `~/.config/collie`, and the
`systemd --user` unit at `~/.config/systemd/user/collie.service` that `collie start` wrote. Run
`collie uninstall` before removing the package to drop that unit and the port mapping.

The `PKGBUILD`, the Nix expression and their notes live in `packaging/` in this repository. macOS
has no package yet; the `aarch64-darwin` flake output is the closest thing.

### Name your multiplexer

Collie mirrors one backend: `COLLIE_MUX=herdr` (default), `tmux`, or `zellij`.

> **Note.** You do not have to set it up first.

The first `start` looks for a live Herdr socket, a running tmux server and zellij sessions, prints
what it found, and writes your answer to the config `.env`, creating it. With no terminal to ask at,
it takes the only backend it found and says which; with none, or with several, it refuses to start
and names `COLLIE_MUX`.

To decide up front instead, seed that file **before** the first start. It is
`~/.config/collie/.env` standalone, or the path `herdr plugin config-dir herdr.collie` prints:

```bash
mkdir -p ~/.config/collie
cp .env.example ~/.config/collie/.env
```

Then set the backend and its endpoint:

```bash
COLLIE_MUX=tmux                                           # or: zellij
# zellij instead: COLLIE_MUX_ENDPOINT_ZELLIJ=<session>
COLLIE_MUX_ENDPOINT_TMUX=/run/user/1000/collie-tmux.sock
```

> **Caution.** Do not run that `cp` after a start: it lands `.env.example` on top of the
> `COLLIE_MUX` the start just wrote.

Afterwards, edit the file. See
[Pointing Collie at a multiplexer](multiplexers.md#pointing-collie-at-a-multiplexer).

### Start it

```bash
herdr plugin action invoke start --plugin herdr.collie   # Herdr-managed
bin/collie start                                         # standalone
```

`start` will:
1. Build `web/dist` if missing.
2. Launch the bridge under `systemd --user` (or launchd/`nohup`).
3. Run `tailscale serve --bg 8787` (HTTPS :443 → 127.0.0.1:8787).
4. Print the connection banner.

## First run — what you'll see

Output from `bin/collie start` (Herdr runs return JSON; view logs with
`herdr plugin log list --plugin herdr.collie`):

```console
$ bin/collie start
building web UI (first run)…                    # linked clone only; a GitHub install already built
…bun install · typecheck · vite build output…
bridge started (systemd --user: collie)
tailscale serve (https) → tailnet :443 -> 127.0.0.1:8787

  ✓ Collie is running  ·  v1.0.0+b158755
    service   systemd --user (collie) · active
    local     http://127.0.0.1:8787
    tailnet   https://myhost.tail1234.ts.net
```

If the health check fails (`⚠ Collie isn't answering on :8787 yet`), see
[Troubleshooting](troubleshooting.md#troubleshooting).

`stop` halts the service; `uninstall` removes the service and proxy. The bridge runs as a
`systemd --user` service, a launchd agent on macOS, that starts at login and restarts on failure
([`ARCHITECTURE.md`](../ARCHITECTURE.md) §3); on Linux `loginctl enable-linger $USER` makes it
survive a reboot ([Surviving reboots](upgrading.md#surviving-reboots)).

Configure user access in [Configure](configure.md#configure) and device access via
[pairing](security.md#pair-a-device--the-write-credential) (`bin/collie pair`).

### Open it on your phone

Open the `tailnet` URL from the banner (retrieve anytime with `bin/collie url` or generate a QR code
with `bin/collie qr`). Your client must be on the same tailnet.

1. **Pair the device**: Run `bin/collie pair` on the host. Scan the printed QR code to open
   Settings → Paired devices on the client with the code filled in, or open Settings → Paired
   devices on the client and type the code
   ([Pair a device](security.md#pair-a-device--the-write-credential)).
2. **Install PWA**: Tap *Add to Home Screen* in Safari (iOS) or Chrome (Android).

Installing the PWA requires HTTPS; `COLLIE_SERVE_MODE=http` disables service workers, so the phone
can only use the browser tab in that mode.

### Is it actually working?

Verify status and logs:

```console
$ bin/collie status

  ✓ Collie is running  ·  v1.0.0+b158755
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

To restrict access, set `COLLIE_TRUSTED_USER=you@example.com` in `.env` and run `bin/collie restart`
([Configure](configure.md#configure)). For missing dashboard content, see
[Troubleshooting](troubleshooting.md#troubleshooting).

## Keep it up to date

One command updates the current major version.

```bash
herdr plugin action invoke update --plugin herdr.collie   # Herdr-managed
bin/collie update                                         # standalone
```

Updates apply to the current major version; crossing one is `collie update --major`, or the
`update-major` action on a Herdr-managed install. For that, rollbacks and uninstalling, see
**[Manage & update](upgrading.md)**.

---

[← back to the README](../README.md)