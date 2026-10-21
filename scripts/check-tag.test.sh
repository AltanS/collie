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

# ── 7. The soft release gate (M44 spec 08) ───────────────────────────────────
# The fixture repo holds only a copy of check-tag.sh, so the gate runs the real harness-drift.ts through
# HARNESS_DRIFT_SCRIPT. Every ledger agent is faked at 0.0.0 (never newer), so a machine that has
# a newer codex installed cannot change the answer. Then one agent is faked newer.
DRIFT="${ROOT}/scripts/harness-drift.ts"
LEDGER="${ROOT}/web/src/lib/harness/verified-versions.json"
quiet="$(bun -e 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(Object.keys(l.agents).map((a) => a + "=0.0.0").join(","));' "$LEDGER")"
run_gate() { (cd "$1" && HARNESS_DRIFT_SCRIPT="$DRIFT" HARNESS_DRIFT_FAKE="${quiet},$2" bash scripts/check-tag.sh "${@:3}" 2>&1); }

setup_case gate
d="$TMP_ROOT/gate"
release_commit "$d" 5.0.0 "chore(release): 5.0.0"

# 7a. A newer installed agent stops the tag step and names the agent. No tag command is printed.
if out="$(run_gate "$d" "claude=99.0.0")"; then fail "a drift must stop the tag step: $out"; fi
assert_contains "$out" "not tagging"
assert_contains "$out" "claude 99.0.0"
assert_lacks "$out" "git tag -a"

# 7b. An override that names the agent and the installed version passes the gate. The tag command
# carries the Not verified line, which release.yml puts in the release notes.
if out="$(run_gate "$d" "claude=99.0.0" --accept-drift claude=99.0.0)"; then fail "the release is still untagged: $out"; fi
assert_contains "$out" "git tag -a v5.0.0"
assert_contains "$out" "Not verified: claude 99.0.0"
assert_lacks "$out" "not tagging"

# 7c. An override for another version covers nothing.
if out="$(run_gate "$d" "claude=99.0.0" --accept-drift claude=98.0.0)"; then fail "another version must not override: $out"; fi
assert_contains "$out" "not tagging"

# 7d. An override for one agent never covers another.
if out="$(run_gate "$d" "claude=99.0.0" --accept-drift codex=99.0.0)"; then fail "another agent must not override: $out"; fi
assert_contains "$out" "not tagging"

# 7e. With no drift the tag command is plain, and the ACCEPT_DRIFT variable does the same as the flag.
if out="$(run_gate "$d" "claude=0.0.0")"; then fail "the release is still untagged: $out"; fi
assert_contains "$out" 'git tag -a v5.0.0'
assert_lacks "$out" "Not verified"
if out="$(cd "$d" && ACCEPT_DRIFT=claude=99.0.0 HARNESS_DRIFT_SCRIPT="$DRIFT" HARNESS_DRIFT_FAKE="${quiet},claude=99.0.0" bash scripts/check-tag.sh 2>&1)"; then fail "still untagged: $out"; fi
assert_contains "$out" "Not verified: claude 99.0.0"

# 7f. An already tagged release never reaches the gate: it passes even with a drift.
git -C "$d" tag -a v5.0.0 -m "Collie 5.0.0"
out="$(run_gate "$d" "claude=99.0.0")" || fail "a tagged release must pass: $out"
assert_contains "$out" "has a local v<version> tag"

# ── 8. An Edge tag publishes the cut version (M60 spec 01) ───────────────────
# The files say plain 6.0.0; only the tag carries the suffix. That version is published on Edge, so
# both modes pass and name the Edge tag and the Stable tag still to come.
setup_case edge
d="$TMP_ROOT/edge"
release_commit "$d" 6.0.0 "chore(release): 6.0.0"
git -C "$d" tag -a v6.0.0-edge.2 -m "Collie 6.0.0-edge.2"
git -C "$d" tag -a v6.0.0-edge.10 -m "Collie 6.0.0-edge.10"
out="$(run_script "$d")" || fail "a version on Edge must pass: $out"
assert_contains "$out" "or an Edge tag"
assert_contains "$out" "published on Edge as v6.0.0-edge.10"
assert_contains "$out" "tag v6.0.0 when Stable supersedes it"
out="$(run_script "$d" HEAD)" || fail "mode 2 must pass on Edge: $out"
assert_contains "$out" "v6.0.0-edge.10"

# 8b. A tag that only LOOKS like Edge does not count, and neither does another version's Edge tag.
setup_case edge-not
d="$TMP_ROOT/edge-not"
release_commit "$d" 6.1.0 "chore(release): 6.1.0"
git -C "$d" tag -a v6.1.0-edge.01 -m "leading zero"
git -C "$d" tag -a v6.1.0-edgy.1 -m "not edge"
git -C "$d" tag -a v6.1.1-edge.1 -m "another version"
if out="$(run_script "$d")"; then fail "no real Edge tag of 6.1.0 exists, so it must fail: $out"; fi
assert_contains "$out" 'git tag -a v6.1.0'

# 8c. Once the Stable tag exists, the Edge note is gone.
git -C "$TMP_ROOT/edge" tag -a v6.0.0 -m "Collie 6.0.0"
out="$(run_script "$TMP_ROOT/edge")" || fail "a stable tag must pass: $out"
assert_lacks "$out" "Edge"

echo "✓ check-tag.test.sh — all cases passed"
