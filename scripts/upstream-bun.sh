#!/usr/bin/env bash
# Realise the UPSTREAM Bun archive the flake pins, and print the path of its `bun` executable on
# stdout. Everything else this script has to say goes to stderr, so the caller can write
# `upstream_bun="$(bash scripts/upstream-bun.sh)"` and get a path and nothing else.
#
# WHY the release compiles on that Bun rather than the one in the dev shell: `bun build --compile`
# copies the RUNNING bun executable as the base of the binary it emits whenever the target matches
# the host, and nixpkgs patches its own copy of bun into the Nix store — autoPatchelf writes a
# /nix/store PT_INTERP on Linux, the ICU relink names a /nix/store libicucore on Darwin. Both
# travelled into collie-1.5.4 and collie-1.5.5 and aborted in the loader on every machine without a
# store (#184). `bun.src` is the same release archive, before nixpkgs patched it.
#
# WHAT THE VERSION CHECK IS WORTH: not much, and it is here anyway. The archive's HASH is enforced
# by Nix's own fetchurl, so the bytes are already pinned and this proves nothing about them. It
# catches one thing: the flake's `version` and its `bun.src` URL drifting apart, so the compile
# would silently use a bun the dev shell never used. Sanity check, not a guarantee.
#
# WHAT THE GUARANTEE IS: scripts/check-payload-links.sh, which reads the finished binary's loader
# inputs outside `nix develop`. We do not fully understand bun's self-copy heuristic — linux-x64
# came out clean in 1.5.4 and 1.5.5 for reasons we never established — so this script is a
# reasonable precaution and the loader gate is what actually holds the property.
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }
die() { printf '%s\n' "upstream-bun: $*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not on PATH, and $2"
}

need nix "the pinned bun is a flake output"
need unzip "the pinned bun ships as a zip"

flake_root="${FLAKE_ROOT:-.}"
say "upstream-bun: realising ${flake_root}#bun.src"
zip="$(nix build "${flake_root}#bun.src" --print-out-paths --no-link)"

# On a runner, unpack beside the rest of the build. Off one, a scratch directory the caller never
# has to name.
dir="${UPSTREAM_BUN_DIR:-}"
if [ -z "$dir" ]; then
  if [ -n "${RUNNER_TEMP:-}" ]; then
    dir="$RUNNER_TEMP/upstream-bun"
  else
    dir="$(mktemp -d)"
  fi
fi
mkdir -p "$dir"
unzip -q -o "$zip" -d "$dir"

# EXACTLY ONE, never `head -1`. Two `bun` files means the archive is not the shape this assumes,
# and picking the first would decide which bun compiles the release by directory order.
matches="$(find "$dir" -type f -name bun)"
count="$(printf '%s' "$matches" | grep -c . || true)"
if [ "$count" != "1" ]; then
  say "upstream-bun: expected exactly one 'bun' executable inside $zip, found $count:"
  printf '%s\n' "$matches" >&2
  die "refusing to guess which one compiles the release"
fi
upstream_bun="$matches"
chmod 0755 "$upstream_bun"

want="$(bun --version)"
got="$("$upstream_bun" --version)"
if [ "$want" != "$got" ]; then
  die "the upstream archive is bun $got, the shell's bun is $want — the flake's version and its bun.src URL have drifted apart"
fi
say "upstream-bun: bun $got from $zip"

printf '%s\n' "$upstream_bun"
