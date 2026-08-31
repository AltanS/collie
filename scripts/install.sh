#!/bin/sh
# Collie's installer — download the release for this platform, verify its sha256, lay it down, put
# `collie` on PATH.
#
# This file is curl-piped into a shell AND read by people who will not run what they have not read,
# so it is deliberately one page of POSIX sh with no helpers to go and find. What it will never do:
# ask for sudo, write outside $COLLIE_DIR and ~/.local/bin, start a service, or send anything
# anywhere. It ends by PRINTING the next three steps rather than taking them — choosing a
# multiplexer and seeding a config are the operator's decisions, and a script that guesses them
# guesses wrong (docs/install.md spells out the same steps by hand, for exactly this reason).
#
# It is a convenience, never the only door. Every asset it fetches — tarball, `.sha256` sidecar,
# release manifest — is a plain GitHub Release file you can download and check by hand; the commands
# to do that are in docs/install.md, and this script does nothing they do not.
set -eu

REPO="${COLLIE_UPDATE_REPO:-AltanS/collie}"
DIR="${COLLIE_DIR:-$HOME/.local/share/collie}"
BETA=0

for arg in "$@"; do
  case "$arg" in
    --beta) BETA=1 ;;
    *) echo "collie install: unknown option '$arg' — the only option is --beta." >&2; exit 2 ;;
  esac
done

die() { echo "collie install: $1" >&2; exit 1; }

# ── What has to be here already ──────────────────────────────────────────────
# Three ordinary tools, and no toolchain: the payload is a compiled binary plus a built web bundle,
# so nothing is installed and nothing is built here. Bun is needed only to build FROM SOURCE, which
# is the other documented route.
command -v curl >/dev/null 2>&1 || die "curl is required. Install it with your package manager, then run this again."
command -v tar  >/dev/null 2>&1 || die "tar is required. Install it with your package manager, then run this again."
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
else die "no sha256 tool found (sha256sum or shasum). The download must be verified, so this stops here."
fi

# ── Which platform ───────────────────────────────────────────────────────────
# The same canonical ids the release manifest and `collie update` use. A platform with no artifact is
# told so plainly and pointed at the source build — never handed a binary for another machine.
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=macos ;;
  *) die "Collie publishes no binary for $(uname -s). Build from source instead: https://github.com/${REPO}#from-source" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Collie publishes no binary for $(uname -m). Build from source instead: https://github.com/${REPO}#from-source" ;;
esac
PLATFORM="${OS}-${ARCH}"

# ── Leave an existing install alone ──────────────────────────────────────────
# Collie updates itself, in place, keeping the previous version for `collie update --rollback`. A
# fresh install over the top would throw away a config, a linked plugin registration and any local
# state the operator put there.
if [ -e "$DIR" ]; then
  if [ -d "$DIR/versions" ] || [ -d "$DIR/.git" ]; then
    echo "Collie is already installed at $DIR — leaving it alone."
    echo "To move it forward, run:  collie update"
    exit 0
  fi
  die "$DIR already exists and is not a Collie install. Move it aside, or set COLLIE_DIR to somewhere else."
fi

# ── Which release ────────────────────────────────────────────────────────────
# The tags are the contract, sorted by semver — the same list `collie update` and the in-app banner
# read, and the reason docs/upgrading.md tells scripts never to ask GitHub for `releases/latest`
# (that endpoint hides prereleases, so it stalls on the last stable tag for a whole beta train).
# Default: the newest STRICT release. `--beta` widens it to prerelease tags, which is the opt-in a
# tester makes deliberately — installing a prerelease is what joins its train.
API=$(curl -fsSL -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${REPO}/tags?per_page=100") ||
  die "could not reach api.github.com to list the releases. Check your network and try again."
# One `"name"` per tag object, and no other key in that payload is called `name` — so this is a
# grep, not a JSON parser, and the install stays dependency-light (no jq).
TAGS=$(printf '%s' "$API" | tr ',{}' '\n\n\n' | grep -o '"name":[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)
if [ "$BETA" -eq 1 ]; then
  TAG=$(printf '%s\n' "$TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' | sort -V | tail -1 || true)
else
  TAG=$(printf '%s\n' "$TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
fi
[ -n "${TAG:-}" ] || die "no release tag found for ${REPO}. Pass --beta to include prereleases, or report this at https://github.com/${REPO}/issues."
VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
NAME="collie-${VERSION}-${PLATFORM}.tar.gz"

# ── Download, and verify before anything is unpacked ──────────────────────────
# The `.sha256` sidecar is the digest, in coreutils format, so this is the same one command a reader
# would run by hand. The release manifest is fetched too and cross-checked: it is the release's own
# integrity document, so a digest that is not in it does not get installed. A mismatch is fatal —
# there is no flag to skip it.
TMP="${DIR}.download.$$"
mkdir -p "$TMP" || die "could not create $TMP."
trap 'rm -rf "$TMP"' EXIT INT HUP TERM

echo "Downloading Collie ${TAG} for ${PLATFORM}…"
curl -fsSL -o "$TMP/$NAME" "$BASE/$NAME" ||
  die "no ${PLATFORM} artifact in release ${TAG}. Build from source instead: https://github.com/${REPO}#from-source"
curl -fsSL -o "$TMP/$NAME.sha256" "$BASE/$NAME.sha256" || die "could not download $NAME.sha256 — refusing to install an unverified binary."
curl -fsSL -o "$TMP/manifest.json" "$BASE/collie-${VERSION}.manifest.json" || die "could not download the release manifest for ${VERSION}."
grep -q '"schemaVersion":[[:space:]]*1' "$TMP/manifest.json" ||
  die "release ${VERSION} uses a manifest this installer does not understand. Get a newer install.sh from https://colliepwa.dev/install.sh"
( cd "$TMP" && $SHA -c "$NAME.sha256" >/dev/null 2>&1 ) ||
  die "CHECKSUM MISMATCH for $NAME — the download was discarded and nothing was installed. Try again; if it repeats, report it."
DIGEST=$(cd "$TMP" && $SHA "$NAME" | cut -d' ' -f1)
grep -q "\"$DIGEST\"" "$TMP/manifest.json" ||
  die "the digest of $NAME is not the one release ${VERSION}'s manifest names — nothing was installed."

# ── Lay it down ──────────────────────────────────────────────────────────────
# One complete payload per version, and a `current` symlink pointing at one of them. An update lays
# the next version down beside this one and flips that symlink, so the two halves — the binary and
# the web bundle it serves from disk — can never skew.
tar -xzf "$TMP/$NAME" -C "$TMP" || die "could not unpack $NAME."
[ -x "$TMP/collie-${VERSION}-${PLATFORM}/bin/collie" ] || die "$NAME does not contain bin/collie — refusing to install it."
mkdir -p "$DIR/versions" || die "could not create $DIR/versions."
mv "$TMP/collie-${VERSION}-${PLATFORM}" "$DIR/versions/$VERSION" || die "could not move the payload into $DIR/versions/$VERSION."
ln -sfn "versions/$VERSION" "$DIR/current" || die "could not point $DIR/current at versions/$VERSION."

# ── The name on PATH ─────────────────────────────────────────────────────────
# A symlink to `current/bin/collie`, never a copy — so every later update is live through the same
# name, with nothing to refresh (ADR 0021). `collie link` publishes it and refuses to touch a name it
# did not publish, which is why this asks the binary rather than making the link itself.
"$DIR/versions/$VERSION/bin/collie" link ||
  echo "note: \`collie link\` did not publish the name — run \`$DIR/current/bin/collie link\` to see why."
case ":${PATH}:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "note: $HOME/.local/bin is not on your PATH, so a bare \`collie\` will not resolve yet. Add it in your shell profile, or spell the verbs $DIR/current/bin/collie <verb>." ;;
esac

# ── What is left, which is yours ─────────────────────────────────────────────
cat <<EOF

✓ Collie $TAG is installed at $DIR — and nothing is running yet.

Three steps left, and each one is a decision:

  1. Seed the config:
       mkdir -p ~/.config/collie
       cp $DIR/current/.env.example ~/.config/collie/.env

  2. Name your multiplexer in that file — COLLIE_MUX=herdr, tmux or zellij. Leave it out and the
     first \`collie start\` probes for one and asks you.
     Herdr needs its server running; tmux and zellij need an endpoint naming which server or
     session to mirror. Both walkthroughs: $DIR/current/docs/multiplexers.md

  3. Start it, and read the banner it prints:
       collie start

Read $DIR/current/docs/security.md before you open the URL on a phone. A Collie is remote shell
access to your machine, by design.
EOF
