#!/usr/bin/env bash
# Loader gate for a release payload's `bin/collie`: it must not name /nix/store.
#
# The release builds under `nix develop`, and nixpkgs relinks its own Bun against the Nix ICU on
# Darwin (flake.nix says so, beside the ad-hoc signature). `bun build --compile` copies the RUNNING
# Bun executable as the base of the binary it emits, so that load command travels straight into the
# artifact: collie-1.5.4 and collie-1.5.5 macos-arm64 both point at
# /nix/store/<hash>-ICU-.../lib/libicucore.A.dylib, and dyld aborts with "Library not loaded" on
# every Mac that has no Nix (#184).
#
# Nothing inside the build could see it. The derivation's install check runs INSIDE Nix, where that
# store path exists, and the GitHub runner has a /nix/store of its own after nix-installer-action —
# so even starting the binary on the runner proves nothing. Only the loader's own inputs answer the
# question, so this reads them and refuses any that live in the store.
#
# Darwin reads `otool -L`. Linux reads `readelf -l` (the program interpreter) and `readelf -d`
# (NEEDED, RPATH, RUNPATH). `CHECK_PAYLOAD_OS=Darwin|Linux` overrides the platform so one host can
# exercise both branches; scripts/check-payload-links.test.sh is why it exists.
#
# A MISSING inspection tool is a failure, never a pass. A check that cannot look has not looked.
set -euo pipefail

binary="${1:-}"
if [ -z "$binary" ]; then
  echo "usage: check-payload-links.sh <binary>" >&2
  exit 1
fi
if [ ! -f "$binary" ]; then
  echo "✗ check-payload-links: no such file: $binary" >&2
  exit 1
fi

os="${CHECK_PAYLOAD_OS:-$(uname -s)}"

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  {
    echo "✗ check-payload-links: $1 is not on PATH, so the loader inputs of $binary cannot be read."
    echo "  This exits 1 rather than passing: a check that cannot look has not looked (#184)."
  } >&2
  exit 1
}

case "$os" in
  Darwin)
    need otool
    what="otool -L"
    inputs="$(otool -L "$binary")"
    ;;
  Linux)
    need readelf
    what="readelf -l and readelf -d"
    # Two reads, both captured before anything filters them, so a readelf that cannot parse the
    # file fails here instead of being swallowed by a grep that then finds nothing.
    segments="$(readelf -l "$binary")"
    dynamic="$(readelf -d "$binary")"
    interp="$(printf '%s\n' "$segments" | grep -F 'Requesting program interpreter' || true)"
    needed="$(printf '%s\n' "$dynamic" | grep -E '\(NEEDED\)|\(RPATH\)|\(RUNPATH\)' || true)"
    inputs="$(printf '%s\n%s\n' "$interp" "$needed")"
    ;;
  *)
    echo "✗ check-payload-links: no loader inspection defined for '$os'" >&2
    echo "  Set CHECK_PAYLOAD_OS to Darwin or Linux if this host can read the payload's format." >&2
    exit 1
    ;;
esac

offenders="$(printf '%s\n' "$inputs" | grep -F '/nix/store' || true)"
if [ -n "$offenders" ]; then
  {
    echo "✗ check-payload-links: $binary loads from the build machine's Nix store."
    echo "  It will abort on any machine without that store. Offending loader inputs:"
    printf '%s\n' "$offenders" | sed 's/^[[:space:]]*/    /'
    echo "  See #184: relink these to their system paths before the payload is sealed."
  } >&2
  exit 1
fi

echo "✓ check-payload-links: $binary names no /nix/store path ($what, $os)"
