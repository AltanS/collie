#!/usr/bin/env bash
# Tests for scripts/check-flake-lock.sh — the guard that keeps a `flake.lock` MOVE inside a release
# commit.
#
# The version-file check still reads `STAGED_FILES`, exactly as the pre-commit hook passes it — no
# case below needs a real repo for that half. But the lock's own status (added / modified / removed
# / absent) is now read straight from `git diff --cached --name-status -- flake.lock`, regardless of
# STAGED_FILES, so each case that cares about status builds a scratch git repo with that exact staged
# state. Nothing here touches this checkout's own index.
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

# A throwaway repo, always torn down by the caller.
new_scratch_repo() {
  local dir
  dir="$(mktemp -d)"
  git -C "$dir" init -q
  git -C "$dir" config user.email test@example.com
  git -C "$dir" config user.name "check-flake-lock test"
  echo "$dir"
}

# Stage flake.lock in the given repo with the given status: none | A | M | D.
prep_lock() {
  local dir="$1" status="$2"
  case "$status" in
    none) ;;
    A)
      echo '{"rev":1}' >"$dir/flake.lock"
      git -C "$dir" add flake.lock
      ;;
    M)
      echo '{"rev":1}' >"$dir/flake.lock"
      git -C "$dir" add flake.lock
      git -C "$dir" commit -q -m base
      echo '{"rev":2}' >"$dir/flake.lock"
      git -C "$dir" add flake.lock
      ;;
    D)
      echo '{"rev":1}' >"$dir/flake.lock"
      git -C "$dir" add flake.lock
      git -C "$dir" commit -q -m base
      git -C "$dir" rm -q --cached flake.lock
      ;;
    *)
      fail "prep_lock: unknown status '$status'"
      ;;
  esac
}

# Run the guard with the lock at the given real status, and STAGED_FILES set as given (used only
# for the version-file check).
run_guard() {
  local lock_status="$1" staged="$2"
  local dir
  dir="$(new_scratch_repo)"
  prep_lock "$dir" "$lock_status"
  ( cd "$dir" && STAGED_FILES="$staged" bash "$SCRIPT" 2>&1 )
  local rc=$?
  rm -rf "$dir"
  return "$rc"
}

VERSIONS='herdr-plugin.toml
package.json
web/package.json'

# ── 1. Refuses: the lock moves (M) on its own ──────────────────────────────
if out="$(run_guard M 'flake.lock')"; then fail "a lone flake.lock bump must be refused: $out"; fi
assert_contains "$out" "not a release commit"
assert_contains "$out" "herdr-plugin.toml"
assert_contains "$out" "package.json"
assert_contains "$out" "web/package.json"
assert_contains "$out" "SKIP_FLAKE_LOCK_CHECK=1"

# ── 2. Refuses: the lock moves with SOME of the version files ──────────────
# Two of three is not a release commit either, and the message names the one that is missing.
if out="$(run_guard M 'flake.lock
herdr-plugin.toml
package.json')"; then fail "a partial version bump must be refused: $out"; fi
assert_contains "$out" "web/package.json"

# ── 3. Passes: the lock moves with all three version files ─────────────────
out="$(run_guard M "flake.lock
${VERSIONS}
CHANGELOG.md")" || fail "a release commit must pass: $out"
assert_contains "$out" "✓"
assert_contains "$out" "release commit"

# ── 4. Passes: the lock is not staged at all ───────────────────────────────
# The ordinary functional commit. The guard must be silent about it and must not demand a bump.
out="$(run_guard none 'bridge/crew/router.ts
CHANGELOG.md')" || fail "a commit without flake.lock must pass: $out"
assert_contains "$out" "flake.lock not staged"

# ── 5. Passes: an empty staged list ────────────────────────────────────────
out="$(run_guard none '')" || fail "an empty staged list must pass: $out"
assert_contains "$out" "flake.lock not staged"

# ── 6. Passes: STAGED_FILES naming a path that merely ENDS in flake.lock ───
# The lock's status now comes from a real, exact-path git call, not from grepping STAGED_FILES, so
# a vendored copy under another directory never trips the guard even if it's named in STAGED_FILES.
out="$(run_guard none 'contrib/example/flake.lock')" || fail "a nested flake.lock must not trip: $out"
assert_contains "$out" "flake.lock not staged"

# ── 7. The hatch disarms it ────────────────────────────────────────────────
out="$(SKIP_FLAKE_LOCK_CHECK=1 run_guard M 'flake.lock')" \
  || fail "the hatch must let the commit through: $out"
assert_contains "$out" "SKIP_FLAKE_LOCK_CHECK=1"

# ── 8. The hatch disarms THIS guard only ───────────────────────────────────
# Each guard owns its own name (CLAUDE.md → escape hatches). The other three names must do nothing
# here, or a developer skipping one would silently skip this one too.
for other in SKIP_VERSION_CHECK SKIP_LINT_CHECK SKIP_CREW_WIRE_CHECK; do
  if out="$( (export "$other=1"; run_guard M 'flake.lock') 2>&1 )"; then
    fail "$other=1 must not disarm the flake.lock guard: $out"
  fi
done

# ── 9. Passes: the lock is a first arrival (A), no version files needed ────
# This is the guard's own arrival commit — an ADDED lock is not a move.
out="$(run_guard A 'flake.lock')" || fail "an added lock must pass without the version files: $out"
assert_contains "$out" "✓"
assert_contains "$out" "first arrival"

# ── 10. Refuses: a modified lock (M) still fails without the version files ─
# Distinct from case 1: this is the exact scenario the A/M mixup risks — confirm status M keeps
# requiring the release commit even when the diff is otherwise minimal.
if out="$(run_guard M 'flake.lock')"; then fail "a modified lock without version files must be refused: $out"; fi
assert_contains "$out" "not a release commit"

# ── 11. Passes: the lock is being removed (D), no version files needed ─────
out="$(run_guard D 'flake.lock')" || fail "a removed lock must pass without the version files: $out"
assert_contains "$out" "✓"
assert_contains "$out" "removed"

echo "✓ check-flake-lock.test.sh — all cases passed"
