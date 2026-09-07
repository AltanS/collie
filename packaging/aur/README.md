# `collie-bin` — the Arch package

`collie-bin` installs the compiled binary Collie already publishes with every GitHub release. It
builds nothing: no Bun, no `git`, no compilation — `makepkg` downloads the release tarball for your
architecture, checks its sha256, and unpacks it. Herdr itself ships in Omarchy's pacman repo, so
this is the same channel.

`x86_64` and `aarch64` are packaged; the macOS tarball is not.

## What lands where

| path | what |
| --- | --- |
| `/usr/bin/collie` | symlink into `/usr/lib/collie/bin/collie` |
| `/usr/lib/collie/` | the release tree — `bin/`, `web/dist/`, `herdr-plugin.toml`, `package.json`, `docs/` and `scripts/` |
| `/usr/share/licenses/collie-bin/LICENSE` | the licence |

`/usr/bin/collie` is a symlink and not the file itself on purpose. The binary resolves its own root
as `dirname(dirname(realpath(argv0)))` and accepts that root only when `herdr-plugin.toml` sits in
it, so the symlink resolves to `/usr/lib/collie` and the bridge finds `web/dist` and the manifest.
The file installed straight into `/usr/bin` would resolve to `/usr` and find neither.

> **Note.** A package is not a Herdr plugin, and `herdr plugin link /usr/lib/collie` is not part of
> this install. The plugin path registers action buttons that update the checkout, and this tree is
> pacman's to update. Every `collie` verb on your PATH works the same either way.

No systemd unit is shipped. Collie writes its own `--user` unit into your home directory when you
run `collie start`.

## Build and install locally

```
makepkg -si
```

Run it from this directory. `-s` pulls any missing dependencies, `-i` installs the built package.

## After installing

Start it:

```
collie start
```

> **Note.** Collie classifies this tree as a `packaged` install and never updates it in place.
> `collie update` declines and names `sudo pacman -Syu collie-bin` instead, and the phone shows the
> new version with that command where the update button would be.

## Cutting a new version

Nobody edits `pkgver` or a hash by hand. `.github/workflows/release.yml`'s `refresh-packages` job
runs after every non-prerelease release, downloads that release's `collie-<version>.manifest.json`,
and runs `scripts/refresh-packages.ts`, which writes `pkgver` and both `sha256sums_*` lines from the
manifest and then re-reads the file to prove every value matches. A mismatch fails the job before
anything is pushed.

To do it locally against a manifest you already have:

```bash
bun scripts/refresh-packages.ts --manifest collie-1.5.5.manifest.json
bun scripts/refresh-packages.ts --manifest collie-1.5.5.manifest.json --check
```

`--manifest` also takes a URL. `--check` verifies and writes nothing.

`.SRCINFO` is regenerated with `makepkg --printsrcinfo` when `makepkg` is on PATH. On a machine
without it the script leaves the file alone and says so, and the release job runs on Ubuntu, so the
job's `.SRCINFO` comes from the container step described below.

## The AUR account and the push key — a manual step, done once

The refresh job pushes to `ssh://aur@aur.archlinux.org/collie-bin.git` with an SSH key held as a
repository secret. Nothing in this tree holds a private key, and nothing ever should.

1. Register an account on [aur.archlinux.org](https://aur.archlinux.org/register), under our own
   name, and confirm the address it mails you.
2. Generate a key pair used for nothing else:

   ```bash
   ssh-keygen -t ed25519 -C "aur@collie" -f ~/.ssh/aur_collie -N ""
   ```

3. Paste `~/.ssh/aur_collie.pub` into the **SSH Public Key** field of your AUR account, under My
   Account, and save.
4. Store the private half as the repository secret `AUR_SSH_KEY`:

   ```bash
   gh secret set AUR_SSH_KEY -R AltanS/collie < ~/.ssh/aur_collie
   ```

5. Create the package on the AUR by pushing it once by hand, because the AUR creates a repository on
   its first push and the job does not:

   ```bash
   git clone ssh://aur@aur.archlinux.org/collie-bin.git /tmp/collie-bin
   cp packaging/aur/PKGBUILD packaging/aur/.SRCINFO /tmp/collie-bin/
   cd /tmp/collie-bin && git add PKGBUILD .SRCINFO && git commit -m "Initial import" && git push
   ```

> **Note.** Until `AUR_SSH_KEY` is set, the refresh job prints a notice saying the AUR push was
> skipped and carries on. It does not fail the release. The pull request it opens against this
> repository is the other half, and that half runs either way.
