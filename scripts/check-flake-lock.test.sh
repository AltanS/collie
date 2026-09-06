#!/usr/bin/env bash
# Tests for scripts/check-flake-lock.sh — the guard that keeps `flake.lock` inside a release commit.
#
# The script reads its staged list from `STAGED_FILES` when that variable is set, exactly as the
# pre-commit hook passes it. Every case here sets it, so no case needs a fixture repository and no
# case can be answered by this checkout's own index.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/check-flake-lock.sh"

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

# Run the guard over a staged list given as newline-separated text.
run_guard() { STAGED_FILES="$1" bash "$SCRIPT" 2>&1; }

VERSIONS='herdr-plugin.toml
package.json
web/package.json'

# ── 1. Refuses: the lock moves on its own ──────────────────────────────────
if out="$(run_guard 'flake.lock')"; then fail "a lone flake.lock bump must be refused: $out"; fi
assert_contains "$out" "not a release commit"
assert_contains "$out" "herdr-plugin.toml"
assert_contains "$out" "package.json"
assert_contains "$out" "web/package.json"
assert_contains "$out" "SKIP_FLAKE_LOCK_CHECK=1"

# ── 2. Refuses: the lock moves with SOME of the version files ──────────────
# Two of three is not a release commit either, and the message names the one that is missing.
if out="$(run_guard 'flake.lock
herdr-plugin.toml
package.json')"; then fail "a partial version bump must be refused: $out"; fi
assert_contains "$out" "web/package.json"

# ── 3. Passes: the lock moves with all three version files ─────────────────
out="$(run_guard "flake.lock
${VERSIONS}
CHANGELOG.md")" || fail "a release commit must pass: $out"
assert_contains "$out" "✓"
assert_contains "$out" "release commit"

# ── 4. Passes: the lock is not staged at all ───────────────────────────────
# The ordinary functional commit. The guard must be silent about it and must not demand a bump.
out="$(run_guard 'bridge/pack/router.ts
CHANGELOG.md')" || fail "a commit without flake.lock must pass: $out"
assert_contains "$out" "flake.lock not staged"

# ── 5. Passes: an empty staged list ────────────────────────────────────────
out="$(run_guard '')" || fail "an empty staged list must pass: $out"
assert_contains "$out" "flake.lock not staged"

# ── 6. Passes: a path that merely ENDS in flake.lock is not the lock ───────
# The match is whole-line, so a vendored copy under another directory never trips the guard.
out="$(run_guard 'contrib/example/flake.lock')" || fail "a nested flake.lock must not trip: $out"
assert_contains "$out" "flake.lock not staged"

# ── 7. The hatch disarms it ────────────────────────────────────────────────
out="$(SKIP_FLAKE_LOCK_CHECK=1 STAGED_FILES='flake.lock' bash "$SCRIPT" 2>&1)" \
  || fail "the hatch must let the commit through: $out"
assert_contains "$out" "SKIP_FLAKE_LOCK_CHECK=1"

# ── 8. The hatch disarms THIS guard only ───────────────────────────────────
# Each guard owns its own name (CLAUDE.md → escape hatches). The other three names must do nothing
# here, or a developer skipping one would silently skip this one too.
for other in SKIP_VERSION_CHECK SKIP_LINT_CHECK SKIP_PACK_WIRE_CHECK; do
  if out="$(env "$other=1" STAGED_FILES='flake.lock' bash "$SCRIPT" 2>&1)"; then
    fail "$other=1 must not disarm the flake.lock guard: $out"
  fi
done

echo "✓ check-flake-lock.test.sh — all cases passed"
