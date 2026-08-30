#!/usr/bin/env bash
# Tests for scripts/check-tag.sh — the guard that catches a release which was cut but never tagged.
#
# Every case runs against a THROWAWAY git repository under $TMP_ROOT holding a COPY of the script.
# Copied rather than symlinked, for the same reason collie-ctl.test.sh copies the shim: the script
# derives its ROOT from BASH_SOURCE and cd's there, so a symlink would point it back at the real
# checkout and it would answer about THIS repository's tags instead of the fixture's.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT}/scripts/check-tag.sh"
TMP_ROOT="$(mktemp -d)"

# git exports GIT_DIR and friends into a hook's environment, and they override repository discovery
# for every git command below — `-C` included. Drop them so a fixture repo is never mistaken for the
# developer's own checkout. (The pre-push hook drops them too; this defends the standalone run.)
unset "${!GIT_@}" 2>/dev/null || true

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

assert_lacks() {
  case "$1" in
    *"$2"*) fail "expected output NOT to contain '$2', got: $1" ;;
    *) ;;
  esac
}

# A fixture repo: the two files the script reads, plus a copy of the script under test.
setup_case() {
  case_dir="$TMP_ROOT/$1"
  mkdir -p "$case_dir/scripts"
  cp "$SCRIPT" "$case_dir/scripts/check-tag.sh"
  git -C "$case_dir" init -q
  git -C "$case_dir" config user.email t@example.com
  git -C "$case_dir" config user.name Test
  git -C "$case_dir" config commit.gpgsign false
}

# Write both version surfaces at one version and commit them under the given subject.
release_commit() {
  printf '[plugin]\nversion = "%s"\n' "$2" > "$1/herdr-plugin.toml"
  printf '# Changelog\n\n## [%s] - 2026-08-30\n' "$2" > "$1/CHANGELOG.md"
  git -C "$1" add -A
  git -C "$1" commit -qm "$3"
}

run_script() { (cd "$1" && bash scripts/check-tag.sh "${@:2}" 2>&1); }

# ── 1. Mode 1: the claimed version has a tag ────────────────────────────────
setup_case tagged
d="$TMP_ROOT/tagged"
release_commit "$d" 1.2.3 "chore(release): 1.2.3"
git -C "$d" tag -a v1.2.3 -m "Collie 1.2.3"
out="$(run_script "$d")" || fail "a tagged release must pass: $out"
assert_contains "$out" "✓"

# ── 2. Mode 1: the claimed version has no tag ───────────────────────────────
setup_case untagged
d="$TMP_ROOT/untagged"
release_commit "$d" 1.2.4 "chore(release): 1.2.4"
if out="$(run_script "$d")"; then fail "an untagged release must fail: $out"; fi
assert_contains "$out" "cut but never tagged"
assert_contains "$out" 'git tag -a v1.2.4'
assert_contains "$out" 'Collie 1.2.4'

# ── 3. Mode 2: an untagged release commit inside a pushed range ─────────────
setup_case range
d="$TMP_ROOT/range"
release_commit "$d" 2.0.0 "chore(release): 2.0.0"
git -C "$d" tag -a v2.0.0 -m "Collie 2.0.0"
base="$(git -C "$d" rev-parse HEAD)"
release_commit "$d" 2.0.1 "chore(release): 2.0.1"
rel="$(git -C "$d" rev-parse --short HEAD)"
if out="$(run_script "$d" "${base}..HEAD")"; then fail "an untagged release in range must fail: $out"; fi
assert_contains "$out" "git tag -a v2.0.1 ${rel}"
# The tagged one already in the range is not re-reported.
assert_lacks "$out" 'git tag -a v2.0.0'

# ── 4. Mode 2: the version comes from the RELEASE COMMIT, not from HEAD ─────
# The docs commit that follows a release is the ordinary case, and it moves HEAD off the release.
setup_case not-head
d="$TMP_ROOT/not-head"
release_commit "$d" 3.0.0 "chore(release): 3.0.0"
git -C "$d" tag -a v3.0.0 -m "Collie 3.0.0"
base="$(git -C "$d" rev-parse HEAD)"
release_commit "$d" 3.0.1 "chore(release): 3.0.1"
# A later commit that leaves the version alone — HEAD's manifest still reads 3.0.1 here, so plant a
# manifest that DISAGREES to prove the script never reads it.
printf '[plugin]\nversion = "9.9.9"\n' > "$d/herdr-plugin.toml"
echo "docs" > "$d/README.md"
git -C "$d" add -A
git -C "$d" commit -qm "docs(readme): a change that is not a release"
if out="$(run_script "$d" "${base}..HEAD")"; then fail "must still fail on the release commit: $out"; fi
assert_contains "$out" 'git tag -a v3.0.1'
assert_lacks "$out" '9.9.9'

# ── 5. Mode 2: a range with no release commit is silent ─────────────────────
setup_case no-release
d="$TMP_ROOT/no-release"
release_commit "$d" 4.0.0 "chore(release): 4.0.0"
git -C "$d" tag -a v4.0.0 -m "Collie 4.0.0"
base="$(git -C "$d" rev-parse HEAD)"
echo "docs" > "$d/README.md"
git -C "$d" add -A
git -C "$d" commit -qm "docs(readme): no release here"
out="$(run_script "$d" "${base}..HEAD")" || fail "a range with no release must pass: $out"
assert_contains "$out" "no release to tag"

# ── 6. Mode 2: an empty/unknown range does not explode ──────────────────────
out="$(run_script "$d" "HEAD..HEAD")" || fail "an empty range must pass: $out"
assert_contains "$out" "no release to tag"

echo "✓ check-tag.test.sh — all cases passed"
