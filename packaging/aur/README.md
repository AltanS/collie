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
| `/usr/lib/collie/` | the release tree — `bin/`, `web/dist/`, `herdr-plugin.toml`, `package.json`, `docs/`, and `scripts/` once the release carries it |
| `/usr/share/licenses/collie-bin/LICENSE` | the licence |

`/usr/bin/collie` is a symlink and not the file itself on purpose. The binary resolves its own root
as `dirname(dirname(realpath(argv0)))` and accepts that root only when `herdr-plugin.toml` sits in
it, so the symlink resolves to `/usr/lib/collie` and the bridge finds `web/dist` and the manifest.
The file installed straight into `/usr/bin` would resolve to `/usr` and find neither.

> **Caution.** The 1.5.2 tarball does not carry `scripts/collie-ctl.sh`, and every action in the
> shipped `herdr-plugin.toml` is spelled `bash scripts/collie-ctl.sh <verb>`. On a package built
> from 1.5.2 the Herdr action buttons therefore cannot resolve. Every `collie` verb on your PATH
> works regardless. The release workflow is fixed in the same pull request as this package, so the
> first release cut after it carries the shim and `package()` installs it at the right path.

No systemd unit is shipped. Collie writes its own `--user` unit into your home directory when you
run `collie start`.

## Build and install locally

```
makepkg -si
```

Run it from this directory. `-s` pulls any missing dependencies, `-i` installs the built package.

## After installing

Register the installed tree as a Herdr plugin:

```
herdr plugin link /usr/lib/collie
```

Then start it:

```
collie start
```

> **Note.** Collie detects a package-managed install and defers updates to pacman rather than
> updating itself — that behaviour ships in the same pull request as this package.

## Cutting a new version

Set `pkgver` in the `PKGBUILD` — it is the only place the version is written — and replace both
`sha256sums_*` lines with the values from that release's published `<asset>.sha256` files.
