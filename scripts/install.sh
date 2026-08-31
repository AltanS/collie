#!/bin/sh
# Collie's bootstrap installer — clone, check out the newest release, build, put `collie` on PATH.
#
# This file is curl-piped into a shell AND read by people who will not run what they have not read,
# so it is deliberately one page of POSIX sh with no helpers to go and find. What it will never do:
# ask for sudo, write outside $COLLIE_DIR and ~/.local/bin, start a service, or send anything
# anywhere. It ends by PRINTING the next three steps rather than taking them — choosing a
# multiplexer and seeding a config are the operator's decisions, and a script that guesses them
# guesses wrong (docs/install.md spells out the same steps by hand, for exactly this reason).
#
# It is a convenience, never the only door. Every line below has a hand equivalent in
# docs/install.md, and that section is the contract this script has to keep when M14 replaces the
# clone-and-build with a downloaded binary artifact.
set -eu

REPO="https://github.com/AltanS/collie.git"
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
# Bun is the one hard dependency: it compiles the CLI and builds the web UI. We point at bun.sh
# rather than installing it ourselves, because installing another project's toolchain behind a pipe
# is exactly the thing a reader of this file is checking that we do not do.
command -v git >/dev/null 2>&1 || die "git is required. Install it with your package manager, then run this again."
command -v bun >/dev/null 2>&1 || die "Bun is required and was not found on PATH. Install it from https://bun.sh (\`curl -fsSL https://bun.sh/install | bash\`), open a new shell, then run this again."

# ── The checkout ─────────────────────────────────────────────────────────────
# An existing checkout is left exactly as it is. Collie updates itself — `collie update` knows both
# checkout shapes and re-execs from the fetched source — and a fresh clone over the top would throw
# away a build, a linked plugin registration and any local state the operator put there.
if [ -e "$DIR" ]; then
  if [ -d "$DIR/.git" ] && [ -f "$DIR/herdr-plugin.toml" ]; then
    echo "Collie is already installed at $DIR — leaving it alone."
    echo "To move it forward, run:  cd $DIR && bin/collie update"
    exit 0
  fi
  die "$DIR already exists and is not a Collie checkout. Move it aside, or set COLLIE_DIR to somewhere else."
fi

echo "Cloning Collie into $DIR…"
mkdir -p "$(dirname "$DIR")" || die "could not create $(dirname "$DIR")."
git clone --quiet "$REPO" "$DIR" || die "git clone failed. Check your network and that $REPO is reachable."
cd "$DIR"

# ── Which release ────────────────────────────────────────────────────────────
# The tags are the contract, sorted by semver — the same rule `collie update` and the in-app banner
# follow, and the reason docs/upgrading.md tells scripts never to ask GitHub for `releases/latest`
# (that endpoint hides prereleases, so it stalls on the last stable tag for a whole beta train).
# Default: the newest STRICT release. `--beta` widens it to that same major's prerelease tags, which
# is the opt-in a tester makes deliberately — installing a prerelease is what joins its train.
if [ "$BETA" -eq 1 ]; then
  TAG=$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' | sort -V | tail -1)
else
  TAG=$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
fi
[ -n "${TAG:-}" ] || die "no release tag found in the clone. Pass --beta to include prereleases, or report this at https://github.com/AltanS/collie/issues."

echo "Checking out $TAG…"
git checkout --quiet --detach "$TAG" || die "could not check out $TAG."

# ── Build ────────────────────────────────────────────────────────────────────
# Through the shim, because a fresh checkout has no `bin/collie` yet and the shim is the one path to
# a first binary. `build` deliberately does NOT lint: oxlint's allocator aborts on a host with less
# than roughly 7 GB of RAM, and a lint gate on the operator's install path bricked real installs
# (1.0.0-beta.44). Do not add one here either.
echo "Building — first run compiles the CLI and bundles the web UI, so give it a minute…"
sh scripts/collie-ctl.sh build || die "the build failed. The error above is the build's own; re-run it with \`cd $DIR && sh scripts/collie-ctl.sh build\` once it is fixed."

# ── The name on PATH ─────────────────────────────────────────────────────────
# A symlink to this checkout's binary, never a copy, so every later build is live through it. A
# release old enough to predate the compiled CLI has no binary to link; that is worth one honest
# sentence rather than a failure.
if [ -x bin/collie ]; then
  bin/collie link || echo "note: \`collie link\` did not publish the name — run \`cd $DIR && bin/collie link\` to see why."
  case ":${PATH}:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "note: $HOME/.local/bin is not on your PATH, so a bare \`collie\` will not resolve yet. Add it in your shell profile, or spell the verbs $DIR/bin/collie <verb>." ;;
  esac
else
  echo "note: $TAG predates the compiled CLI, so there is no bin/collie to put on your PATH. Its verbs are spelled \`sh scripts/collie-ctl.sh <verb>\` from $DIR."
fi

# ── What is left, which is yours ─────────────────────────────────────────────
cat <<EOF

✓ Collie $TAG is installed at $DIR — and nothing is running yet.

Three steps left, and each one is a decision:

  1. Seed the config:
       mkdir -p ~/.config/collie
       cp $DIR/.env.example ~/.config/collie/.env

  2. Choose your multiplexer in that file — COLLIE_MUX=herdr (the default), tmux or zellij.
     Herdr needs its server running; tmux and zellij need an endpoint naming which server or
     session to mirror. Both walkthroughs: $DIR/docs/multiplexers.md

  3. Start it, and read the banner it prints:
       collie start

Read $DIR/docs/security.md before you open the URL on a phone. A Collie is remote shell access to
your machine, by design.
EOF
