#!/usr/bin/env bash
# Loader gate for a release payload's `bin/collie`. The property it holds: NO LOADER INPUT OUTSIDE
# THE TARGET MACHINE'S OWN SYSTEM ROOTS. Not "no /nix/store" — an allowlist, because the store is
# only the path that happened to break, and the next one will have a different name.
#
# What happened (#184): the release builds under `nix develop`, nixpkgs relinks its own Bun against
# the Nix ICU on Darwin and autopatchelfs it on Linux, and `bun build --compile` copies the RUNNING
# Bun as the base of what it emits. So collie-1.5.4 and collie-1.5.5 shipped a macos-arm64 binary
# loading /nix/store/<hash>-ICU-.../lib/libicucore.A.dylib and a linux-arm64 binary naming a
# /nix/store program interpreter, and both aborted in the loader on every machine without Nix.
#
# Nothing inside the build could see it. The derivation's install check runs INSIDE Nix, where that
# store path exists, and the GitHub runner has a /nix/store of its own after nix-installer-action —
# so even starting the binary on the runner proves nothing. Only the loader's own inputs answer the
# question, so this reads them and refuses every absolute path that is not under a system root.
#
# Darwin roots: /usr/lib/ /System/Library/. Darwin reads `otool -L` (the load commands) and
# `otool -l` (every LC_RPATH's `path`).
# Linux roots: /lib/ /lib64/ /usr/lib/ /usr/lib64/. Linux reads `readelf -l` (the program
# interpreter) and `readelf -d` (NEEDED, RPATH, RUNPATH). A NEEDED entry is normally a bare soname
# with no slash and passes untouched; one carrying a slash is a path and is checked. RPATH and
# RUNPATH are colon-separated lists and every element is checked on its own. `$ORIGIN` is refused by
# name: a Bun single-file executable has no reason to carry one.
#
# THE ACCEPTED GAP: this reads the loader's inputs, not the binary's own strings. A library opened
# with dlopen at run time from a path baked into the binary is invisible here. A raw
# `strings | grep /nix/store` is deliberately NOT used instead: Bun embeds many strings, and the
# clean linux-x64 1.5.5 binary already contains such a hit, so that check would fail every release.
#
# `CHECK_PAYLOAD_OS=Darwin|Linux` overrides the platform so one host can exercise both branches;
# scripts/check-payload-links.test.sh is why it exists.
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

# Every record is one TAB-separated `kind<TAB>value` line. `value` is a single path, except for
# RPATH and RUNPATH, where it is the colon-separated list exactly as the loader would read it.
records=""
roots=""

case "$os" in
  Darwin)
    need otool
    what="otool -L and otool -l"
    roots="/usr/lib/ /System/Library/"
    # Both reads are captured whole before anything filters them, so an otool that cannot parse the
    # file fails here instead of being swallowed by a grep that then finds nothing.
    loads="$(otool -L "$binary")"
    commands="$(otool -l "$binary")"
    records="$(
      printf '%s\n' "$loads" | awk '/^[ \t]/ && NF { printf "LC_LOAD_DYLIB\t%s\n", $1 }'
      printf '%s\n' "$commands" |
        awk '$1 == "cmd" && $2 == "LC_RPATH" { want = 1; next }
             want && $1 == "path" { printf "LC_RPATH\t%s\n", $2; want = 0 }'
    )"
    ;;
  Linux)
    need readelf
    what="readelf -l and readelf -d"
    roots="/lib/ /lib64/ /usr/lib/ /usr/lib64/"
    segments="$(readelf -l "$binary")"
    dynamic="$(readelf -d "$binary")"
    records="$(
      printf '%s\n' "$segments" |
        awk '/Requesting program interpreter/ {
               line = $0
               sub(/.*Requesting program interpreter:[ \t]*/, "", line)
               sub(/\].*/, "", line)
               printf "PT_INTERP\t%s\n", line
             }'
      printf '%s\n' "$dynamic" |
        awk '/\(NEEDED\)/  { kind = "NEEDED" }
             /\(RPATH\)/   { kind = "RPATH" }
             /\(RUNPATH\)/ { kind = "RUNPATH" }
             /\(NEEDED\)|\(RPATH\)|\(RUNPATH\)/ {
               line = $0
               sub(/.*\[/, "", line)
               sub(/\].*/, "", line)
               printf "%s\t%s\n", kind, line
             }'
    )"
    ;;
  *)
    echo "✗ check-payload-links: no loader inspection defined for '$os'" >&2
    echo "  Set CHECK_PAYLOAD_OS to Darwin or Linux if this host can read the payload's format." >&2
    exit 1
    ;;
esac

# A path is allowed when it is under one of the roots, or is the root directory itself without its
# trailing slash — `readelf` prints a RUNPATH of `/usr/lib`, not `/usr/lib/`.
under_a_root() {
  local path="$1" root
  for root in $roots; do
    case "$path" in
      "$root"*) return 0 ;;
      "${root%/}") return 0 ;;
    esac
  done
  return 1
}

offenders=""
note() {
  offenders="${offenders}    $1"$'\n'
}

judge() {
  local kind="$1" path="$2"
  # A bare soname carries no slash. The loader resolves it through the machine's own search path,
  # so there is no build-machine path to leak.
  case "$path" in
    "") return 0 ;;
    */*) ;;
    *) return 0 ;;
  esac
  case "$path" in
    *'$ORIGIN'*|*'${ORIGIN}'*)
      note "$kind: $path — \$ORIGIN is not allowed, a single-file executable has no reason to carry one"
      return 0
      ;;
  esac
  under_a_root "$path" && return 0
  note "$kind: $path — outside the system roots"
}

while IFS=$'\t' read -r kind value; do
  [ -n "${kind:-}" ] || continue
  case "$kind" in
    RPATH|RUNPATH)
      # A colon-separated list, judged element by element.
      IFS=':' read -r -a elements <<< "$value"
      for element in "${elements[@]}"; do
        judge "$kind" "$element"
      done
      ;;
    *)
      judge "$kind" "$value"
      ;;
  esac
done <<< "$records"

if [ -n "$offenders" ]; then
  {
    echo "✗ check-payload-links: $binary names loader inputs outside the system roots."
    echo "  Each of these must exist on an operator's machine, and will not. The build machine's"
    echo "  Nix store is the case that happened (#184); any other path outside the roots fails the"
    echo "  same way. Allowed roots on $os: $roots"
    echo "  Offending loader inputs:"
    printf '%s' "$offenders"
    echo "  Relink these to their system paths before the payload is sealed."
  } >&2
  exit 1
fi

echo "✓ check-payload-links: every loader input of $binary is under $roots ($what, $os)"
