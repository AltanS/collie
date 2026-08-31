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
#
# Three environment variables steer it, and nothing else does: COLLIE_DIR (where to install),
# COLLIE_UPDATE_REPO (which repo to fetch from), and COLLIE_TAG (install one exact release tag, e.g.
# COLLIE_TAG=v1.0.0-beta.49). A pin skips the tag lookup completely — no call to api.github.com — so
# it is both the way to ask for an older version on purpose and the way back onto a known-good one
# when an install is stuck. It is an environment variable rather than an option because `curl … | sh`
# gives options to the shell, not to this script.
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

# ── A pinned tag, if the operator named one ──────────────────────────────────
# Checked here, before anything is fetched or touched, because a typo in a pinned tag would otherwise
# only surface as a 404 three requests later. The shape is the one the tag list is filtered by, so a
# prerelease pins fine and needs no --beta: naming it IS the opt-in.
PIN="${COLLIE_TAG:-}"
if [ -n "$PIN" ]; then
  printf '%s\n' "$PIN" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
    die "COLLIE_TAG='$PIN' is not a release tag. It has to look like v1.0.0, or v1.0.0-beta.49 for a prerelease."
fi

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

# ── Leave an existing install alone — unless a tag was pinned ────────────────
# Collie updates itself, in place, keeping the previous version for `collie update --rollback`. A
# fresh install over the top would throw away a config, a linked plugin registration and any local
# state the operator put there. COLLIE_TAG is the one way past that, and it is not a clobber: the
# versioned layout holds one payload per version, so a pin lays the named one down BESIDE what is
# there and flips `current`. That is the rescue when the installed version is the thing that is
# broken — the moment `collie update` cannot be the answer.
RESCUE=0
if [ -e "$DIR" ]; then
  if [ -d "$DIR/.git" ]; then
    [ -z "$PIN" ] ||
      die "$DIR is a git checkout, and COLLIE_TAG only pins a binary install. Pin it with git instead:  git -C $DIR checkout $PIN"
  elif [ -d "$DIR/versions" ] && [ -n "$PIN" ]; then
    echo "Collie is already installed at $DIR — laying $PIN down beside it, and pointing current at it."
    RESCUE=1
  fi
  if [ "$RESCUE" -eq 0 ]; then
    if [ -d "$DIR/versions" ] || [ -d "$DIR/.git" ]; then
      echo "Collie is already installed at $DIR — leaving it alone."
      echo "To move it forward, run:  collie update"
      echo "To put one specific version there instead, re-run this script with COLLIE_TAG=vX.Y.Z"
      echo "If \`collie update\` itself fails, see docs/upgrading.md, section \"When collie will not run\"."
      exit 0
    fi
    die "$DIR already exists and is not a Collie install. Move it aside, or set COLLIE_DIR to somewhere else."
  fi
fi

# ── Somewhere to work ────────────────────────────────────────────────────────
# A scratch directory beside the install root, swept by the trap on every exit. It is made this early
# because the tag lookup below writes its answer to a file — reading the HTTP status is how a rate
# limit gets named as a rate limit instead of failing as "no release tag found".
TMP="${DIR}.download.$$"
mkdir -p "$TMP" || die "could not create $TMP."
trap 'rm -rf "$TMP"' EXIT INT HUP TERM

# ── Which release ────────────────────────────────────────────────────────────
# The tags are the contract, sorted by semver — the same list `collie update` and the in-app banner
# read, and the reason docs/upgrading.md tells scripts never to ask GitHub for `releases/latest`
# (that endpoint hides prereleases, so it stalls on the last stable tag for a whole beta train).
# Default: the newest STRICT release. `--beta` widens it to prerelease tags, which is the opt-in a
# tester makes deliberately — installing a prerelease is what joins its train. COLLIE_TAG replaces
# the whole question, so a pinned run never asks GitHub anything.
if [ -n "$PIN" ]; then
  TAG="$PIN"
else
  CODE=$(curl -sSL -o "$TMP/tags.json" -w '%{http_code}' -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}/tags?per_page=100") ||
    die "could not reach api.github.com to list the releases. Check your network and try again."
  case "$CODE" in
    200) ;;
    403|429) die "GitHub's API rate limit says no (HTTP ${CODE}). Without a token GitHub allows 60 calls an hour, counted per network address, so everyone behind your router shares one budget. Wait an hour, or name the version you want and skip this call entirely:  COLLIE_TAG=vX.Y.Z  (the tags are listed at https://github.com/${REPO}/releases)." ;;
    *) die "api.github.com answered HTTP ${CODE} when asked for the tags of ${REPO}. Try again later, or name the version you want and skip this call:  COLLIE_TAG=vX.Y.Z" ;;
  esac
  # One `"name"` per tag object, and no other key in that payload is called `name` — so this is a
  # grep, not a JSON parser, and the install stays dependency-light (no jq).
  TAGS=$(tr ',{}' '\n\n\n' < "$TMP/tags.json" | grep -o '"name":[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)
  if [ "$BETA" -eq 1 ]; then
    TAG=$(printf '%s\n' "$TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' | sort -V | tail -1 || true)
  else
    TAG=$(printf '%s\n' "$TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
  fi
  [ -n "${TAG:-}" ] || die "no release tag found for ${REPO}. Pass --beta to include prereleases, or report this at https://github.com/${REPO}/issues."
fi
VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
NAME="collie-${VERSION}-${PLATFORM}.tar.gz"

# ── The name on PATH ─────────────────────────────────────────────────────────
# A symlink to `current/bin/collie`, never a copy — so every later update is live through the same
# name, with nothing to refresh (ADR 0021). `collie link` publishes it and refuses to touch a name it
# did not publish, which is why this asks the binary rather than making the link itself. It is a
# function because the rescue path below reaches the end of the install without downloading anything.
publish_name() {
  "$DIR/versions/$VERSION/bin/collie" link ||
    echo "note: \`collie link\` did not publish the name — run \`$DIR/current/bin/collie link\` to see why."
  case ":${PATH}:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "note: $HOME/.local/bin is not on your PATH, so a bare \`collie\` will not resolve yet. Add it in your shell profile, or spell the verbs $DIR/current/bin/collie <verb>." ;;
  esac
}

# ── The pinned version may already be on disk ────────────────────────────────
# A rollback usually is: `collie update` keeps the version it replaced, so the rescue is a symlink
# flip and nothing else. Downloading a payload that is already here would be the only risky part of
# an otherwise free operation.
if [ "$RESCUE" -eq 1 ] && [ -d "$DIR/versions/$VERSION" ]; then
  [ -x "$DIR/versions/$VERSION/bin/collie" ] ||
    die "$DIR/versions/$VERSION is there but holds no runnable bin/collie. Move it aside and run this again."
  ln -sfn "versions/$VERSION" "$DIR/current" || die "could not point $DIR/current at versions/$VERSION."
  publish_name
  echo "✓ Collie ${TAG} was already at $DIR/versions/${VERSION} — current now points at it, and nothing was downloaded."
  exit 0
fi

# ── Download, and verify before anything is unpacked ──────────────────────────
# The `.sha256` sidecar is the digest, in coreutils format, so this is the same one command a reader
# would run by hand. The release manifest is fetched too and cross-checked: it is the release's own
# integrity document, so a digest that is not in it does not get installed. A mismatch is fatal —
# there is no flag to skip it.
echo "Downloading Collie ${TAG} for ${PLATFORM}…"
curl -fsSL -o "$TMP/$NAME" "$BASE/$NAME" ||
  die "release ${TAG} has no ${PLATFORM} artifact — either that tag does not exist or it never published one. Check the tag name against https://github.com/${REPO}/releases, or build from source instead: https://github.com/${REPO}#from-source"
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

publish_name

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
