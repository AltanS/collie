# `collie-bin` in Omarchy's package repository

Omarchy hosts get their software from `pkgs.omarchy.org`, a pacman repository built from
[`omacom/omarchy-pkgs`](https://github.com/omacom/omarchy-pkgs). Getting `collie-bin` in there is a
pull request against that repository carrying two files, and nothing in this directory is built,
run or read by Collie itself.

## What the pull request consists of

| file in `omarchy-pkgs` | what to put there |
| --- | --- |
| `pkgbuilds/collie-bin/PKGBUILD` | a copy of [`../aur/PKGBUILD`](../aur/PKGBUILD) |
| `pkgbuilds/collie-bin/.omarchy/package.json` | a copy of [`package.json`](package.json) |

No `.SRCINFO`. That repository's own sync step removes it, and it is the AUR's file, not pacman's.

One PKGBUILD serves both channels, which is why the install root is `/opt/collie` with
`/usr/bin/collie` as a symlink into it: that is the layout `omarchy-pkgs` uses for every package
that ships a whole application tree, and the AUR is equally happy with it. `README.md`,
`CHANGELOG.md` and `docs/` go to `/usr/share/doc/collie-bin/` and the licence to
`/usr/share/licenses/collie-bin/`, because nothing at run time reads them.

## What `package.json` says

It declares how the repository's tooling follows our releases, so nobody there edits a version or a
hash by hand:

- `github` — the repository whose releases are watched, `AltanS/collie`. Prereleases are ignored.
- `assets` — the release asset per architecture. `{pkgver}` interpolates the tag with its leading
  `v` stripped, so `v1.5.6` resolves `collie-1.5.6-linux-x64.tar.gz` and
  `collie-1.5.6-linux-arm64.tar.gz`, which are the names `release.yml` publishes.
- `digests: true` — take each asset's sha256 from GitHub's own per-asset digest. Collie also
  publishes `collie-<version>.manifest.json` and a `.sha256` beside every asset, but GitHub's
  digest needs no extra fetch and no format agreement.

No `min_release_age`: Collie's release job publishes only after CI is green on the tagged commit,
and a delay would put Omarchy hosts behind every other channel for no gain.

## After it is merged

Omarchy hosts install with `sudo pacman -S collie-bin` and take every later version with
`sudo pacman -Syu`, the update they already run. Never an AUR helper: `pkgs.omarchy.org` is a real
pacman repository. `collie update` declines on that host and names `sudo pacman -Syu collie-bin`,
which is the same command spelled for one package.

Until the pull request is merged, an Omarchy host builds the same package from
[`../aur/PKGBUILD`](../aur/PKGBUILD) with `makepkg -si`.
