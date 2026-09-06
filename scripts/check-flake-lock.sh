#!/usr/bin/env bash
# The flake.lock gate for Collie.
#
# `flake.lock` records the exact nixpkgs revision the release is built from (flake.nix, and
# CLAUDE.md → Versioning). It may move ONLY in a `chore(release): x.y.z` commit. A lock bumped in a
# feature commit means the toolchain moved at a point no version records, so the binary a bisect
# builds is not the binary the release built — and nothing in the tree says when it changed.
#
# So: a commit that MOVES `flake.lock` (status M, a change to an already-tracked lock) must also
# stage the three version files. A first arrival (status A) or a removal (status D) is not a move,
# so it passes on its own — that is what let this guard's own lock land.
#
# Runs against the STAGED diff. Called standalone and by the pre-commit hook (guard D).
# Override once with: SKIP_FLAKE_LOCK_CHECK=1 git commit …
set -euo pipefail

# The three files that must always agree on the version (CLAUDE.md → Versioning). Staging all three
# is what makes a commit a release commit; check-version.sh, run by guard A, judges their contents.
VERSION_FILES=(
  herdr-plugin.toml
  package.json
  web/package.json
)

if [ "${SKIP_FLAKE_LOCK_CHECK:-}" = "1" ]; then
  echo "check-flake-lock: SKIP_FLAKE_LOCK_CHECK=1 — skipping flake.lock guard" >&2
  exit 0
fi

# The hook already has the staged list and passes it down; a standalone run computes its own. Used
# only for the version-file check below — the lock's own status is judged separately, next.
staged="${STAGED_FILES-}"
if [ -z "${STAGED_FILES+x}" ]; then
  staged="$(git diff --cached --name-only --diff-filter=ACMR)"
fi

# The lock's own staged status, straight from the index — regardless of what STAGED_FILES says.
# This is what tells a first arrival (A) or a removal (D) from a move (M): only a move is a guarded
# lock change; the other two, and no staged change at all, pass on their own.
lock_status="$(git diff --cached --name-status -- flake.lock | cut -f1)"

case "$lock_status" in
  "")
    echo "✓ flake.lock not staged"
    exit 0
    ;;
  A)
    echo "✓ flake.lock is a first arrival, not a move — no release commit needed"
    exit 0
    ;;
  D)
    echo "✓ flake.lock is being removed, not moved — no release commit needed"
    exit 0
    ;;
esac

missing=""
for f in "${VERSION_FILES[@]}"; do
  printf '%s\n' "$staged" | grep -qxF "$f" || missing="${missing}${f}"$'\n'
done

if [ -z "$missing" ]; then
  echo "✓ flake.lock moves with the three version files — a release commit"
  exit 0
fi

{
  echo "✗ flake.lock is staged, but this is not a release commit. Not staged:"
  printf '%s' "$missing" | sed 's/^/    /'
  echo
  echo "  The lock pins the toolchain a published binary was built with, so it moves once, in the"
  echo "  \`chore(release): x.y.z\` commit, together with the version. Pick one:"
  echo
  echo "  (i)   You are cutting a release — stage the three version files too, and follow the"
  echo "        release recipe in CLAUDE.md → Versioning."
  echo
  echo "  (ii)  You are not — restore the lock and leave the bump to the release:"
  echo "        git restore --staged --worktree flake.lock"
  echo
  echo "  (iii) The lock genuinely has to move now (a security fix in the pinned nixpkgs, say)."
  echo "        Say so:  SKIP_FLAKE_LOCK_CHECK=1 git commit …"
} >&2
exit 1
