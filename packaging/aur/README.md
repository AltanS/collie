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

Set `pkgver` in the `PKGBUILD` — it is the only place the version is written — and replace both
`sha256sums_*` lines with the values from that release's published `<asset>.sha256` files. The
package currently tracks 1.5.3.
