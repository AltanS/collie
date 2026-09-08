#!/usr/bin/env bash
# Tests for scripts/upstream-bun.sh — the step that hands the release compile an UNPATCHED bun
# instead of the dev shell's own (#184).
#
# No Nix here and no download. `nix`, `unzip` and `bun` are fakes on a scratch PATH: `nix` prints
# the path of a stand-in "archive", `unzip` writes whichever files the case asked for, and every
# `bun` on that PATH answers `--version` from an environment variable and logs its argv. The
# script's whole job is a choice between executables, and a choice is testable without either one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/upstream-bun.sh"
BASH_BIN="$(command -v bash)"
TMP_ROOT="$(mktemp -d)"

cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

with_tools() {
  local dir="${TMP_ROOT}/$1"
  shift
  mkdir -p "$dir"
  local t
  for t in "$@"; do
    ln -sf "$(command -v "$t")" "$dir/$t"
  done
  printf '%s' "$dir"
}

# `nix build … --print-out-paths` answers with a path, and so does this. The stand-in never has to
# be a real zip, because the fake `unzip` never reads it.
fake_nix() {
  cat > "$1/nix" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_ZIP"
FAKE
  chmod 0755 "$1/nix"
}

# Writes one stand-in `bun` per entry in FAKE_ZIP_ENTRIES, each answering --version from
# FAKE_UPSTREAM_VERSION and appending its argv to FAKE_BUN_LOG. The last argument is the -d target.
fake_unzip() {
  cat > "$1/unzip" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
dir="${!#}"
for entry in $FAKE_ZIP_ENTRIES; do
  mkdir -p "$dir/$(dirname "$entry")"
  cat > "$dir/$entry" <<'INNER'
#!/usr/bin/env bash
[ -n "${FAKE_BUN_LOG:-}" ] && printf 'upstream %s\n' "$*" >> "$FAKE_BUN_LOG"
printf '%s\n' "$FAKE_UPSTREAM_VERSION"
INNER
  chmod 0644 "$dir/$entry"
done
FAKE
  chmod 0755 "$1/unzip"
}

# The dev shell's own bun, the one the version check compares against.
fake_bun() {
  cat > "$1/bun" <<'FAKE'
#!/usr/bin/env bash
[ -n "${FAKE_BUN_LOG:-}" ] && printf 'shell %s\n' "$*" >> "$FAKE_BUN_LOG"
printf '%s\n' "$FAKE_SHELL_BUN_VERSION"
FAKE
  chmod 0755 "$1/bun"
}

# Run the script on a scratch PATH. Stdout and stderr are kept APART, because "the path on stdout,
# everything else on stderr" is the contract the caller depends on.
run_script() {
  local dir="$1"
  shift
  local rc=0
  set +e
  PATH="$dir" env "$@" "$BASH_BIN" "$SCRIPT" \
    > "${TMP_ROOT}/stdout" 2> "${TMP_ROOT}/stderr"
  rc=$?
  set -e
  STDOUT="$(cat "${TMP_ROOT}/stdout")"
  STDERR="$(cat "${TMP_ROOT}/stderr")"
  return "$rc"
}

TOOLS="$(with_tools tools basename bash cat chmod dirname env find grep mkdir mktemp printf rm sed uname)"
fake_nix "$TOOLS"
fake_unzip "$TOOLS"
fake_bun "$TOOLS"

ZIP="${TMP_ROOT}/bun-1.4.1.zip"
printf 'not really a zip\n' > "$ZIP"

# ── 1. The happy path ───────────────────────────────────────────────────────
UNPACK="${TMP_ROOT}/unpack-ok"
LOG="${TMP_ROOT}/log-ok"
: > "$LOG"
run_script "$TOOLS" FLAKE_ROOT="$ROOT" UPSTREAM_BUN_DIR="$UNPACK" FAKE_ZIP="$ZIP" \
  FAKE_ZIP_ENTRIES="bun-linux-x64/bun" FAKE_UPSTREAM_VERSION=1.4.1 \
  FAKE_SHELL_BUN_VERSION=1.4.1 FAKE_BUN_LOG="$LOG" \
  || fail "one bun at the agreed version must succeed: $STDERR"

[ "$STDOUT" = "${UNPACK}/bun-linux-x64/bun" ] \
  || fail "stdout must be the executable's path alone, got: $STDOUT"
[ -x "$STDOUT" ] || fail "the printed bun must be executable"
# The chatter belongs on stderr, so `$(…)` around this script yields a usable path.
assert_contains "$STDERR" "bun 1.4.1"
# This script SELECTS a bun; it never compiles with one. Nothing here may pass --outfile.
[ -s "$LOG" ] || fail "the log is empty, so the assertions below would pass vacuously"
if grep -q -- '--outfile' "$LOG"; then
  fail "upstream-bun.sh must not build anything: $(cat "$LOG")"
fi
if grep -qv -- '--version' "$LOG"; then
  fail "every bun call must be a version read: $(cat "$LOG")"
fi

# ── 2. The pin drifted ──────────────────────────────────────────────────────
# The flake's `version` and its bun.src URL disagreeing is the one thing this check can see.
if run_script "$TOOLS" FLAKE_ROOT="$ROOT" UPSTREAM_BUN_DIR="${TMP_ROOT}/unpack-drift" \
  FAKE_ZIP="$ZIP" FAKE_ZIP_ENTRIES="bun-linux-x64/bun" FAKE_UPSTREAM_VERSION=1.4.0 \
  FAKE_SHELL_BUN_VERSION=1.4.1; then
  fail "a version mismatch must fail: $STDOUT"
fi
assert_contains "$STDERR" "1.4.0"
assert_contains "$STDERR" "1.4.1"
assert_contains "$STDERR" "drifted apart"

# ── 3. Two candidates ───────────────────────────────────────────────────────
# `head -1` would let directory order decide which bun compiles the release. It says so instead.
if run_script "$TOOLS" FLAKE_ROOT="$ROOT" UPSTREAM_BUN_DIR="${TMP_ROOT}/unpack-two" \
  FAKE_ZIP="$ZIP" FAKE_ZIP_ENTRIES="bun-linux-x64/bun bun-linux-x64-baseline/bun" \
  FAKE_UPSTREAM_VERSION=1.4.1 FAKE_SHELL_BUN_VERSION=1.4.1; then
  fail "two bun executables must fail: $STDOUT"
fi
assert_contains "$STDERR" "found 2"
assert_contains "$STDERR" "refusing to guess"

# ── 4. No unzip on the runner ───────────────────────────────────────────────
BARE="$(with_tools bare basename bash cat chmod dirname env find grep mkdir mktemp printf rm sed uname)"
fake_nix "$BARE"
fake_bun "$BARE"
if run_script "$BARE" FLAKE_ROOT="$ROOT" UPSTREAM_BUN_DIR="${TMP_ROOT}/unpack-nounzip" \
  FAKE_ZIP="$ZIP" FAKE_ZIP_ENTRIES="bun-linux-x64/bun" FAKE_UPSTREAM_VERSION=1.4.1 \
  FAKE_SHELL_BUN_VERSION=1.4.1; then
  fail "a missing unzip must fail: $STDOUT"
fi
assert_contains "$STDERR" "unzip is not on PATH"

echo "✓ upstream-bun.test.sh — all cases passed"
