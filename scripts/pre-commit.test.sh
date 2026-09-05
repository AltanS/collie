#!/usr/bin/env bash
# Tests for scripts/git-hooks/pre-commit — guard (A), the versioning and changelog gate.
#
# What this file is for: the guard decides, at commit time, whether a change owes the operator a
# CHANGELOG line. Getting that wrong is expensive in one direction and merely annoying in the other.
# Too strict and a test-only fix either invents a line nobody can act on or reaches for
# SKIP_VERSION_CHECK=1, and the override is a habit that eventually hides a real change. Too loose
# and a shipped change lands unrecorded, which the release commit cannot recover — by then the diff
# is folded into a version heading and nobody remembers what moved.
#
# Every case runs against a THROWAWAY git repository under $TMP_ROOT holding COPIES of the hook and
# the two scripts it shells out to. Copied rather than symlinked, for the reason check-tag.test.sh
# copies its script: both derive their ROOT from BASH_SOURCE and cd there, so a symlink would point
# them back at the real checkout and they would answer about THIS repository's versions.
#
# Guard (B), lint, and guard (C), pack wire, are out of scope here and are held off with their own
# SKIP_* switches: they own their file lists and their messages, and check-pack-wire.sh is covered
# against its own fixtures. What is asserted below is only which commits guard (A) lets through.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="${ROOT}/scripts/git-hooks/pre-commit"
TMP_ROOT="$(mktemp -d)"

# git exports GIT_DIR and friends into a hook's environment, and they override repository discovery
# for every git command below — `-C` included. Drop them so a fixture repo is never mistaken for the
# developer's own checkout. (check-tag.test.sh drops them for the same reason.)
unset "${!GIT_@}" 2>/dev/null || true

cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ── The fixture ──────────────────────────────────────────────────────────────
# The smallest repository the guard will talk to: the three version files it compares, a CHANGELOG
# with both an empty `## [Unreleased]` and one numbered heading (check-version.sh reads the numbered
# one), and one source file per path class the cases below stage.
REPO="${TMP_ROOT}/repo"

write_version() {
  # $1 = version to write into all three files.
  printf 'version = "%s"\n' "$1" > "${REPO}/herdr-plugin.toml"
  printf '{ "version": "%s" }\n' "$1" > "${REPO}/package.json"
  printf '{ "version": "%s" }\n' "$1" > "${REPO}/web/package.json"
}

# The CHANGELOG, with the bullets of the `## [Unreleased]` section given as arguments. No argument
# leaves the section empty, which is the state a release commit must reach.
write_changelog() {
  {
    echo "# Changelog"
    echo
    echo "## [Unreleased]"
    echo
    for line in "$@"; do echo "- $line"; done
    [ "$#" -eq 0 ] || echo
    echo "## [1.0.0] - 2026-01-01"
    echo
    echo "- the first one"
  } > "${REPO}/CHANGELOG.md"
}

mkdir -p "${REPO}/scripts/git-hooks" "${REPO}/web/src/hooks" "${REPO}/cli" "${REPO}/bridge" "${REPO}/docs"
cp "$HOOK" "${REPO}/scripts/git-hooks/pre-commit"
cp "${ROOT}/scripts/check-version.sh" "${REPO}/scripts/check-version.sh"
cp "${ROOT}/scripts/check-pack-wire.sh" "${REPO}/scripts/check-pack-wire.sh"
chmod +x "${REPO}/scripts/git-hooks/pre-commit" "${REPO}/scripts"/check-*.sh

write_version "1.0.0"
write_changelog
echo "// source" > "${REPO}/cli/pairing.ts"
echo "// test" > "${REPO}/cli/pairing.test.ts"
echo "// test" > "${REPO}/web/src/hooks/use-spaces.test.tsx"
echo "# test" > "${REPO}/scripts/collie-cli.test.sh"
echo "# doc" > "${REPO}/docs/deployment.md"

cd "$REPO"
git init -q .
git config user.email "test@example.invalid"
git config user.name "Fixture"
git add -A
git commit -q --no-verify -m "baseline"

# ── Running one case ─────────────────────────────────────────────────────────
# Each case stages a set of paths and runs the hook the way git would: from the repository root,
# with only guard (A) armed. `run_guard` leaves the verdict in $RC and the message in $OUT, and
# always resets the index and worktree, so one case can never colour the next.
RC=0
OUT=""
run_guard() {
  git add -A
  set +e
  OUT="$(SKIP_LINT_CHECK=1 SKIP_PACK_WIRE_CHECK=1 bash "${REPO}/scripts/git-hooks/pre-commit" 2>&1)"
  RC=$?
  set -e
  git reset -q --hard HEAD
}

# `touch_file` appends a line, so the staged diff is a real modification and not an empty one —
# `--diff-filter=ACMR` would drop a file whose content did not move.
touch_file() { echo "// $RANDOM" >> "$REPO/$1"; }

assert_allowed() {
  [ "$RC" -eq 0 ] || fail "$1: expected the guard to allow the commit, it exited ${RC}: ${OUT}"
}

assert_blocked() {
  [ "$RC" -ne 0 ] || fail "$1: expected the guard to BLOCK the commit, it exited 0"
  case "$OUT" in
    *"$2"*) ;;
    *) fail "$1: expected the refusal to say '$2', got: ${OUT}" ;;
  esac
}

# ── What ships nothing ───────────────────────────────────────────────────────
# The carve-out, one case per suffix and one for the hooks directory. Each of these is the whole
# commit: nothing else is staged, so the guard has only a non-functional file to look at.

touch_file scripts/collie-cli.test.sh
run_guard
assert_allowed "a .test.sh alone"

touch_file cli/pairing.test.ts
run_guard
assert_allowed "a .test.ts alone"

touch_file web/src/hooks/use-spaces.test.tsx
run_guard
assert_allowed "a .test.tsx alone"

# The hooks run at commit time on a developer's machine and are not in the release tarball, so a
# change to one is not something an operator can read a line about. This case is why the commit
# that introduced the carve-out did not have to reach for its own override.
touch_file scripts/git-hooks/pre-commit
run_guard
assert_allowed "the pre-commit hook itself"

touch_file docs/deployment.md
run_guard
assert_allowed "a doc alone"

# Several non-functional files at once are still nothing to record — the filter is per file, and
# what is left over is what the guard judges.
touch_file cli/pairing.test.ts
touch_file scripts/collie-cli.test.sh
touch_file docs/deployment.md
run_guard
assert_allowed "tests and a doc together"

# ── What ships ───────────────────────────────────────────────────────────────

touch_file cli/pairing.ts
run_guard
assert_blocked "a source file with no CHANGELOG line" "functional code changed but nothing was recorded"

# The important half of the carve-out: a test does not launder the source file beside it. This is
# the case that would let a shipped change land unrecorded if the filter were applied to the commit
# rather than to each file in it.
touch_file cli/pairing.ts
touch_file cli/pairing.test.ts
run_guard
assert_blocked "a source file WITH its test" "functional code changed but nothing was recorded"

# The ordinary functional commit: the source moved and the CHANGELOG grew a bullet.
touch_file cli/pairing.ts
write_changelog "the pairing code now does the thing"
run_guard
assert_allowed "a source file with a CHANGELOG line"

# A staged CHANGELOG that did not GROW is not a record — an edit to an existing bullet leaves the
# count where it was, and the guard counts bullets rather than trusting the file to be staged.
touch_file cli/pairing.ts
write_changelog "the first bullet, reworded"
git add -A
git commit -q --no-verify -m "one bullet on record"
touch_file cli/pairing.ts
write_changelog "the first bullet, reworded again"
run_guard
assert_blocked "a reworded bullet is not a new one" "functional code changed but nothing was recorded"
git reset -q --hard HEAD~1

# ── The release commit ───────────────────────────────────────────────────────
# The version moved, so the guard switches to the other question: did the Unreleased section get
# folded away, and did the version go forward.

write_version "1.1.0"
write_changelog
sed -i.bak 's/^## \[1\.0\.0\] - 2026-01-01/## [1.1.0] - 2026-02-02/' "${REPO}/CHANGELOG.md"
rm -f "${REPO}/CHANGELOG.md.bak"
run_guard
assert_allowed "a release commit with an empty Unreleased"

write_version "1.1.0"
write_changelog "something nobody folded away"
sed -i.bak 's/^## \[1\.0\.0\] - 2026-01-01/## [1.1.0] - 2026-02-02/' "${REPO}/CHANGELOG.md"
rm -f "${REPO}/CHANGELOG.md.bak"
run_guard
assert_blocked "a release commit with a full Unreleased" "\`## [Unreleased]\` is not empty"

# A version that sorts below the last one is a typo or a bad merge, never a release.
write_version "0.9.0"
write_changelog
sed -i.bak 's/^## \[1\.0\.0\] - 2026-01-01/## [0.9.0] - 2026-02-02/' "${REPO}/CHANGELOG.md"
rm -f "${REPO}/CHANGELOG.md.bak"
run_guard
assert_blocked "a version that went backwards" "version went backwards"

# ── The override ─────────────────────────────────────────────────────────────
# It has to keep working, and it has to say so on the way past: a silent skip is one nobody reviews.
touch_file cli/pairing.ts
git add -A
set +e
OUT="$(SKIP_VERSION_CHECK=1 SKIP_LINT_CHECK=1 SKIP_PACK_WIRE_CHECK=1 \
  bash "${REPO}/scripts/git-hooks/pre-commit" 2>&1)"
RC=$?
set -e
git reset -q --hard HEAD
assert_allowed "SKIP_VERSION_CHECK=1 over an unrecorded source change"
case "$OUT" in
  *"SKIP_VERSION_CHECK=1"*) ;;
  *) fail "the override passed silently: ${OUT}" ;;
esac

echo "✓ pre-commit.test.sh — all cases passed"
